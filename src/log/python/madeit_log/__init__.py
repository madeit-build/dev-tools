"""Made I.T. structured logging, the Python mirror of @madeit-build/log.

The record shape is OpenTelemetry's and the trace context is W3C, so the two
implementations agree by both validating against schema/madeit-log-v1.json
rather than by inspection.
"""
import datetime
import json
import os
import re
import secrets

TRACEPARENT_ENV = "TRACEPARENT"
SESSION_PREFIX_LEN = 12

_SEVERITY_NUMBER = {"DEBUG": 5, "INFO": 9, "WARN": 13, "ERROR": 17}

# Whole words rather than substrings: "keyboard" is not a key and "token_count"
# is a metric, but "private_key" and "refresh_token" are exactly what must
# never land. Mirrors src/log/src/core/redact.ts word-for-word.
_CREDENTIAL_WORDS = {
    "token", "secret", "secrets", "password", "passwords", "passwd", "credential",
    "credentials", "authorization", "auth", "bearer", "cookie", "cookies", "apikey",
    "key", "jwt",
}

# A counted token is a number, not a credential, and this library serves LLM
# tooling where token counts are the most common attribute of all.
_COUNT_WORDS = {"count", "used", "limit", "max", "total", "remaining"}

_SESSION_WORD = "session"
_LIFTED_ATTRIBUTE_KEYS = {"madeit.event", "madeit.trace_id", "madeit.span_id"}
_CAMEL_BOUNDARY = re.compile(r"([a-z0-9])([A-Z])")
_DIGIT_BOUNDARY = re.compile(r"([a-zA-Z])([0-9])")
_WORD_SEPARATOR = re.compile(r"[^a-z0-9]+")
_TRACEPARENT = re.compile(r"00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}")
# The schema's rule for madeit.event, checked here so a bad slug is coerced before it reaches a sink.
_EVENT_PATTERN = re.compile(r"[a-z][a-z0-9.-]*")


def mint_traceparent():
    return f"00-{secrets.token_hex(16)}-{secrets.token_hex(8)}-01"


def parse_traceparent(value):
    """The ids in a traceparent, or None for anything we cannot trust.

    Guessing would link records into a trace that never existed, which is worse
    than no trace at all.
    """
    match = _TRACEPARENT.fullmatch(value or "")
    if match is None:
        return None
    trace_id, span_id = match.groups()
    if trace_id == "0" * 32 or span_id == "0" * 16:
        return None
    return trace_id, span_id


def _words_of(key):
    spaced = _DIGIT_BOUNDARY.sub(r"\1 \2", _CAMEL_BOUNDARY.sub(r"\1 \2", key)).lower()
    return [word for word in _WORD_SEPARATOR.split(spaced) if word]


def _is_credential_key(words):
    # Only "token" earns the count exemption: nobody counts passwords, so
    # "password_max" is a credential with a suffix, not a metric.
    credentials = [word for word in words if word in _CREDENTIAL_WORDS]
    if not credentials:
        return False
    only_tokens = all(word == "token" for word in credentials)
    return not (only_tokens and any(word in _COUNT_WORDS for word in words))


def redact(attributes):
    out, dropped = {}, []
    for key, value in attributes.items():
        words = _words_of(key)
        if _is_credential_key(words):
            dropped.append(key)
            continue
        out[key] = (value[:SESSION_PREFIX_LEN]
                    if _SESSION_WORD in words and isinstance(value, str) else value)
    if dropped:
        out["madeit.redacted"] = dropped
    return out


def _safe_message(error):
    # An error whose __str__ raises would otherwise take the announcement down
    # with it, and the type name is still worth reporting.
    try:
        return str(error)
    except Exception:
        return type(error).__name__


def _serialize(record):
    # One attribute JSON cannot carry (a cycle) must cost one record, not the
    # sink for the rest of the process, so the record is swapped for one that
    # names what was lost.
    try:
        return json.dumps(record, default=str)
    except Exception as error:
        replacement = _build_record(
            record["Resource"], record["SeverityText"], "record could not be serialized",
            "log.unserializable",
            attributes={
                "madeit.original_event": record["Attributes"].get("madeit.event"),
                "madeit.error": _safe_message(error),
            },
        )
        replacement["Timestamp"] = record["Timestamp"]
        return json.dumps(replacement, default=str)


def file_sink(path):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    def write(record):
        with open(path, "a") as handle:
            handle.write(_serialize(record) + "\n")
    return write


def _timestamp(at):
    return at.strftime("%Y-%m-%dT%H:%M:%S.") + f"{at.microsecond // 1000:03d}Z"


def _build_record(resource, severity, body, event, attributes=None, trace=None, at=None):
    record = {
        "Timestamp": _timestamp(at or datetime.datetime.now(datetime.timezone.utc)),
        "SeverityNumber": _SEVERITY_NUMBER[severity],
        "SeverityText": severity,
        "Body": body,
        "Resource": resource,
        "Attributes": {**(attributes or {}), "madeit.event": event},
    }
    if trace is not None:
        record["TraceId"], record["SpanId"] = trace
    return record


class _FanOut:
    """Write to every sink and survive any of them.

    A sink that raises is disabled rather than retried, because the failure is
    almost always permanent and a retry on every record puts one broken sink on
    the hot path.
    """

    def __init__(self, resource, sinks):
        self._resource = resource
        self._live = list(sinks)

    def dispatch(self, record):
        for sink in list(self._live):
            # A death notice earlier in this same pass may already have killed it.
            if sink not in self._live:
                continue
            try:
                sink(record)
            except Exception as error:
                self._discard(sink)
                self._announce(error)

    def _announce(self, error):
        notice = _build_record(
            self._resource, "ERROR", "a sink failed and was disabled",
            "sink.disabled", attributes={"madeit.error": _safe_message(error)},
        )
        for sink in list(self._live):
            if sink not in self._live:
                continue
            try:
                sink(notice)
            except Exception as nested:
                # A sink that dies reporting a death is gone too, and its own death
                # is still news to whoever is left. Every death removes a sink, so this ends.
                self._discard(sink)
                self._announce(nested)

    def _discard(self, sink):
        # Two failures for one sink in one pass must not crash the second
        # removal, mirroring Set.delete's no-op in sink.ts.
        if sink in self._live:
            self._live.remove(sink)


def _without_lifted_keys(attributes):
    return {key: value for key, value in attributes.items()
            if key not in _LIFTED_ATTRIBUTE_KEYS}


def _coerce_emittable(event, body):
    # A logger that throws breaks its caller. A marked record keeps the
    # defect queryable instead.
    marks = {}
    valid_event = isinstance(event, str) and _EVENT_PATTERN.fullmatch(event) is not None
    if not valid_event:
        marks["madeit.invalid_event"] = event
    coerced_event = event if valid_event else "invalid"
    valid_body = isinstance(body, str) and body != ""
    if not valid_body:
        marks["madeit.invalid_body"] = True
    coerced_body = body if valid_body else coerced_event
    return coerced_event, coerced_body, marks


class _Logger:
    def __init__(self, resource, fan_out, trace=None):
        self._resource, self._fan_out, self._trace = resource, fan_out, trace

    def with_trace(self, traceparent):
        return _Logger(self._resource, self._fan_out, parse_traceparent(traceparent))

    def _emit(self, severity, event, body, attributes):
        coerced_event, coerced_body, marks = _coerce_emittable(event, body)
        # A trace comes from with_trace or not at all; an attribute never supplies one.
        # The marks are appended after redaction so a caller cannot shadow them.
        clean = {**_without_lifted_keys(redact(attributes or {})), **marks}
        record = _build_record(
            self._resource, severity, coerced_body, coerced_event, attributes=clean, trace=self._trace,
        )
        self._fan_out.dispatch(record)

    def debug(self, event, body, attributes=None):
        self._emit("DEBUG", event, body, attributes)

    def info(self, event, body, attributes=None):
        self._emit("INFO", event, body, attributes)

    def warn(self, event, body, attributes=None):
        self._emit("WARN", event, body, attributes)

    def error(self, event, body, attributes=None):
        self._emit("ERROR", event, body, attributes)


def get_logger(service, version, environment, repo, component, sinks):
    resource = {
        "service.name": service,
        "service.version": version,
        "deployment.environment": environment,
        "madeit.repo": repo,
        "madeit.component": component,
    }
    return _Logger(resource, _FanOut(resource, sinks))
