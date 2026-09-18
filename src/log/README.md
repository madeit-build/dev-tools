# `@madeit-build/log`

Structured logging for Made I.T. projects: one event contract, enforced
redaction, and W3C trace context, with `getLogger` as the only thing callers
touch.

The package is a thin wrapper over [`@logtape/logtape`](https://logtape.org).
It borrows logtape's levels, dispatch, and meta logger; it owns the record
shape, redaction, and sink failure policy.

## Installing

The package is published to GitHub Packages under the `@madeit-build` scope, not npm. Point
your `.npmrc` at the scope and authenticate with a token that has `read:packages`, then install
as usual.

```
@madeit-build:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

```
pnpm add @madeit-build/log
```

or `npm install @madeit-build/log`.

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
object, never in the body string. Call `getLogger` once per component at
startup: each call opens its sinks and registers for the life of the
process.

## Conventions

Every record conforms to `src/log/schema/madeit-log-v1.json`, and the test
suites validate that.

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
| `route` | `madeit.hook_event`, `madeit.tool`, `madeit.answered`, `madeit.duration_ms` | what was dispatched |
| `cue.evaluated` | `madeit.rule`, `madeit.fired`, `madeit.score` | what a cue decided |
| `cue.declined` | `madeit.rule`, `madeit.reason` | why a cue wrote no row at all |
| `cue.throttled` | `madeit.rule`, `madeit.bar`, `madeit.score` | why a cue that fired stayed quiet |
| `cue.spoke` | `madeit.rule`, `madeit.audience` | what reached a human or the agent |
| `daemon.lifecycle` | `madeit.phase`, `madeit.pid`, `madeit.socket` | spawn, listening, the exits |
| `crash` | `madeit.error`, `madeit.stack_digest` | an uncaught error, as a queryable record |
| `sink.disabled` | `madeit.error` | a sink threw and was taken out of rotation |
| `log.meta` | `madeit.error` | logging itself failed, as reported by logtape or by the wrapper |
| `log.unserializable` | `madeit.original_event`, `madeit.error` | a record JSON could not carry, standing in for the original |

`event` must match `^[a-z][a-z0-9.-]*$` and `body` must be non-empty; the
call site throws a `TypeError` otherwise, so a slug the schema would reject
never reaches a sink.

## Redaction

`redact` runs inside the wrapper, before any sink sees a record. A
credential-shaped attribute key (`token`, `secret`, `password`, `key`, and
similar) is dropped and its absence recorded as `madeit.redacted`. Session
ids are truncated to their 12-character prefix.

Any key whose words include `session` (`session_id`, `sessionId`,
`madeit.session_id`, `claude_session_id`) counts as a session id, and only
`token` gets the count exemption: `max_tokens` stays, `password_max` drops.
Both implementations assert every case in
`src/log/schema/redaction-cases.json`.

## Sinks

Sinks are synchronous in phase 1. A sink that throws (or, in TypeScript,
returns a rejecting promise) is disabled and its death announced through the
survivors as `sink.disabled`; stdout `EPIPE` errors are not caught.

## Owns logtape's configuration

The package calls logtape's `configureSync({ reset: true })` on every
`getLogger`, so the process must not call logtape's `configure` itself. If
logtape refuses the configuration anyway, `getLogger` does not throw: it
emits one `log.meta` record and returns a logger that writes to its sinks
directly. The OTel sink phase will revisit this ownership.

## Python

`src/log/python/madeit_log` is the mirror: `get_logger`, `file_sink`, and
`TRACEPARENT_ENV`, with the same record shape, redaction, and sink failure
policy, and `test_madeit_log.py` validates against the same schema. Run its
tests from `src/log/python` with `uv run python -m unittest test_madeit_log -v`.

## Trace context

`withTrace(traceparent)` returns a logger whose records all carry the given
trace. A malformed `traceparent` yields an untraced logger rather than
throwing, so a bad header degrades to a missing trace, never a broken call.
