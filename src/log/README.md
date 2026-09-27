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
| `log.meta` | `madeit.error` or `madeit.cli_error` | logging itself failed (`madeit.error`, as reported by logtape or the wrapper), or the `madeit-log` CLI reported a misuse or a sink failure of its own (`madeit.cli_error`); a query needs both |
| `log.unserializable` | `madeit.original_event`, `madeit.error` | a record JSON could not carry, standing in for the original |

`event` must match `^[a-z][a-z0-9.-]*$` and `body` must be non-empty. The
logger never throws on caller input: a bad slug is coerced to `invalid` and
an empty body falls back to the (coerced) event slug, and each defect is
recorded as an ordinary attribute, `madeit.invalid_event` or
`madeit.invalid_body`, rather than silently swallowed.

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

## Bash

`madeit-log` is the same contract, callable straight from a shell script. It
ships as a `bin` of this package (`madeit-log`), so once it is installed
there is nothing to build: it runs under Node from the published package, and
under Bun on the fleet.

There are two modes:

```bash
madeit-log <debug|info|warn|error> <event> <body> [key=value ...]
madeit-log pipe <event> [--level debug|info|warn|error] [--stream stdout|stderr] [--tee]
```

The first is one call per event, for lifecycle lines a script already knows
about:

```bash
madeit-log info deploy.started "starting deploy" madeit.target=box madeit.version="$VERSION"
```

Each `key=value` becomes an attribute; a value that JSON-parses as a number,
boolean or null keeps that type, and anything else stays a string. An
argument with no `=`, a key that is not 1 to 64 characters of letters,
digits, `_`, `.` or `-` (starting with a letter or `_`), or a value that is
only `=` padding is not logged (its text could easily be a mis-quoted value,
possibly a credential): it is only counted, in
`madeit.invalid_attribute_count`.

The second turns a subprocess's stdout and stderr into records, one per line,
without swallowing the output a person or the next stage of a pipeline still
expects:

```bash
some-build-command \
  2> >(madeit-log pipe build.output --stream stderr --tee >&2) \
  | madeit-log pipe build.output --tee
```

`--tee` writes each line through unchanged. Without it, the subprocess's own
output never reaches the terminal or the next pipe stage, only the records
do. A line longer than 16 KiB is cut to that length, and the record says so
with `madeit.truncated` and `madeit.line_bytes`.

The `2> >(...)` process substitution can still be running after
`some-build-command` finishes, since it reads stderr on its own schedule. Add
`wait` (bash 4.4+ waits for the last process substitution) before reading the
records, or the stderr side's lines may not be there yet.

### Environment variables

**Resource**, set once at the top of a script. A variable left unset becomes
`"unknown"` in the record, and the missing names are joined into
`madeit.missing_resource` so the gap is visible on every line rather than
silent:

- `MADEIT_SERVICE`, `MADEIT_VERSION`, `MADEIT_ENVIRONMENT`, `MADEIT_REPO`, `MADEIT_COMPONENT`

**Trace:** `TRACEPARENT`, if set, becomes the record's `TraceId` and
`SpanId`. A malformed value degrades to an untraced record rather than
failing the call.

**Sink:** `MADEIT_LOG_SINK=stderr|stdout|file:<path>`, default `stderr`. A
script's stdout is usually its actual output, and something like journald
already captures stderr for services, so stderr is the safer default. An
unrecognized value, a `file:` target that cannot be created, or one that
fails the first time it writes, still ships the record: it falls back to
stderr, with the sink value in `madeit.invalid_sink` and the failure reason
in `madeit.cli_error`, so nothing silently vanishes.

### It never exits nonzero

Whatever `madeit-log` is given, bad or not, it exits 0. A malformed call
(an unknown level, a missing event, an unrecognized flag) becomes a
`log.meta` record describing the misuse instead of a nonzero exit, because a
log line must never be the reason a script running under `set -e` dies. A
misused `pipe` call still drains piped stdin to EOF before exiting (through
`--tee` if given, discarded otherwise), so a typo in the flags never SIGPIPEs
the command upstream of it. The only thing that can make it exit nonzero is
the Node or Bun runtime itself failing to start.

### Measured costs

The two modes exist because their costs differ by three orders of magnitude.
Measured on martinez against the real core (hyperfine):

| | cost |
|---|---|
| bare `bun` start | 5.5 ms |
| one process per record | 14.1 ms per record (11.6 ms bundled) |
| one process reading a stream, to stdout | about 14 ms to start, then about 3 µs per line (10,000 lines in 45 ms) |
| one process reading a stream, with a `file:` sink | about 20 µs per line, since each record is a synchronous append (426,000 lines in 8.4 s) |

The per-event form suits lifecycle events, not per-line output. For a
subprocess's output, use `pipe`: it pays the startup cost once and reads the
whole stream in one process. The sink still matters at that volume: a `file:`
sink's synchronous append costs about six times what writing to stdout does.

### Security

`pipe` logs each line's content verbatim, as the value of `madeit.line`.
Redaction is key-based and never inspects values, so it cannot catch a
credential that shows up inside a line of output. **Never pipe a command
whose output can carry credentials.**

## Python

`src/log/python/madeit_log` is the mirror: `get_logger`, `file_sink`, and
`TRACEPARENT_ENV`, with the same record shape, redaction, and sink failure
policy, and `test_madeit_log.py` validates against the same schema. Run its
tests from `src/log/python` with `uv run python -m unittest test_madeit_log -v`.

## Trace context

`withTrace(traceparent)` returns a logger whose records all carry the given
trace. A malformed `traceparent` yields an untraced logger rather than
throwing, so a bad header degrades to a missing trace, never a broken call.
