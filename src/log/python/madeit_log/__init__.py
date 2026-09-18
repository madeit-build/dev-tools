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
    "token", "secret", "password", "passwd", "credential", "credentials",
    "authorization", "auth", "bearer", "cookie", "apikey", "key", "jwt",
}

# A counted token is a number, not a credential, and this library serves LLM
# tooling where token counts are the most common attribute of all.
_COUNT_WORDS = {"count", "used", "limit", "max", "total", "remaining"}

_SESSION_KEYS = {"madeit.session_id", "session_id"}
_LIFTED_ATTRIBUTE_KEYS = {"madeit.trace_id", "madeit.span_id"}
_CAMEL_BOUNDARY = re.compile(r"([a-z0-9])([A-Z])")
_WORD_SEPARATOR = re.compile(r"[^a-z0-9]+")
_TRACEPARENT = re.compile(r"^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$")


def mint_traceparent():
    return f"00-{secrets.token_hex(16)}-{secrets.token_hex(8)}-01"


def parse_traceparent(value):
    """The ids in a traceparent, or None for anything we cannot trust.

    Guessing would link records into a trace that never existed, which is worse
    than no trace at all.
    """
    match = _TRACEPARENT.match(value or "")
    if match is None:
        return None
    trace_id, span_id = match.groups()
    if trace_id == "0" * 32 or span_id == "0" * 16:
        return None
    return trace_id, span_id


def _words_of(key):
    spaced = _CAMEL_BOUNDARY.sub(r"\1 \2", key).lower()
    return [word for word in _WORD_SEPARATOR.split(spaced) if word]


def _is_credential_key(key):
    words = _words_of(key)
    if not any(word in _CREDENTIAL_WORDS for word in words):
        return False
    return not any(word in _COUNT_WORDS for word in words)


def redact(attributes):
    out, dropped = {}, []
    for key, value in attributes.items():
        if _is_credential_key(key):
            dropped.append(key)
            continue
        out[key] = (value[:SESSION_PREFIX_LEN]
                    if key in _SESSION_KEYS and isinstance(value, str) else value)
    if dropped:
        out["madeit.redacted"] = dropped
    return out


def file_sink(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    def write(record):
        with open(path, "a") as handle:
            handle.write(json.dumps(record) + "\n")
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

    A sink that throws is disabled rather than retried: the failure is almost
    always permanent, and retrying it on every record turns one broken sink
    into a per-call exception handler on the hot path. Mirrors sink.ts.
    """

    def __init__(self, resource, sinks):
        self._resource = resource
        self._live = list(sinks)

    def dispatch(self, record):
        for sink in list(self._live):
            # A sink already disabled by an earlier failure within this same
            # dispatch (e.g. it just failed to receive the sink.disabled
            # notice) must not be invoked a second time for one record.
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
            "sink.disabled", attributes={"madeit.error": str(error)},
        )
        for sink in list(self._live):
            try:
                sink(notice)
            except Exception:
                # A sink that dies reporting a death is simply gone too.
                self._discard(sink)

    def _discard(self, sink):
        # list.remove raises on an absent item; two failures for the same sink
        # in one dispatch (record, then its own disablement notice) must not
        # crash the second removal. Mirrors Set.delete's no-op semantics in
        # sink.ts.
        if sink in self._live:
            self._live.remove(sink)


def _without_lifted_keys(attributes):
    return {key: value for key, value in attributes.items()
            if key not in _LIFTED_ATTRIBUTE_KEYS}


class _Logger:
    def __init__(self, resource, fan_out, trace=None):
        self._resource, self._fan_out, self._trace = resource, fan_out, trace

    def with_trace(self, traceparent):
        return _Logger(self._resource, self._fan_out, parse_traceparent(traceparent))

    def _emit(self, severity, event, body, attributes):
        # madeit.trace_id / madeit.span_id are lifted only from with_trace, never
        # from a caller attribute, so a caller can never spoof or override a trace.
        clean = _without_lifted_keys(attributes or {})
        record = _build_record(
            self._resource, severity, body, event,
            attributes=redact(clean), trace=self._trace,
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
