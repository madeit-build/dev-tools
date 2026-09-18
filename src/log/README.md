# `@madeit-build/log`

Structured logging for Made I.T. projects: one event contract, enforced
redaction, and W3C trace context, with `getLogger` as the only thing callers
touch.

The package is a thin wrapper over [`@logtape/logtape`](https://logtape.org).
It borrows logtape's levels, dispatch, and meta logger; it owns the record
shape, redaction, and sink failure policy.

## Usage

```ts
import { getLogger, stdoutSink } from "@madeit-build/log";

const logger = getLogger({
  service: "hookd", version: "abc1234", environment: "local",
  repo: "agent-utilities", component: "daemon", sinks: [stdoutSink()],
});

logger.info("route", "dispatch routed", { "madeit.tool": "Bash" });
```

`Body` is fixed per event; everything variable belongs in the attributes
object, never in the body string.

## Conventions

Every record is validated against `src/log/schema/madeit-log-v1.json`.

**Resource attributes** (constant for the process)

| Field | Example | Required |
|---|---|---|
| `service.name` | `hookd` | yes |
| `service.version` | short git SHA | yes |
| `deployment.environment` | `local`, `box`, `vik` | yes |
| `madeit.repo` | `agent-utilities` | yes |
| `madeit.component` | `cues`, `daemon`, `board` | yes |

**Record fields**

| Field | Notes | Required |
|---|---|---|
| `Timestamp` | RFC 3339, UTC, millisecond precision | yes |
| `SeverityNumber` | OTel 1-24 | yes |
| `SeverityText` | `DEBUG`, `INFO`, `WARN`, `ERROR` | yes |
| `Body` | one line, human-readable, no interpolated data | yes |
| `TraceId` | 32 hex, from the active context | when in a trace |
| `SpanId` | 16 hex | when in a trace |
| `madeit.event` | stable slug, e.g. `route`, `cue.declined` | yes |

**Events** (phase 1)

| Event | Attributes | Answers |
|---|---|---|
| `route` | `hook_event`, `tool`, `answered`, `duration_ms` | what was dispatched |
| `cue.evaluated` | `rule`, `fired`, `score` | what a cue decided |
| `cue.declined` | `rule`, `reason` | why a cue wrote no row at all |
| `cue.throttled` | `rule`, `bar`, `score` | why a cue that fired stayed quiet |
| `cue.spoke` | `rule`, `audience` | what reached a human or the agent |
| `daemon.lifecycle` | `phase`, `pid`, `socket` | spawn, listening, the exits |
| `crash` | `error`, `stack_digest` | an uncaught error, as a queryable record |

## Redaction

`redact` runs inside the wrapper, before any sink sees a record. A credential-
shaped attribute key (`token`, `secret`, `password`, `key`, and similar) is
dropped and its absence recorded as `madeit.redacted`. Session ids are
truncated to their 12-character prefix.

## Trace context

`withTrace(traceparent)` returns a logger whose records all carry the given
trace. A malformed `traceparent` yields an untraced logger rather than
throwing, so a bad header degrades to a missing trace, never a broken call.
