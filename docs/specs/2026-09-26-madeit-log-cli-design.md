# `madeit-log`: the logging contract for bash

**Status:** proposed
**Date:** 2026-09-26
**Home:** `src/log/src/core` (a `bin` in `@madeit-build/log`), packaged for the fleet in box.provisioning

## The problem

Bash scripts across the fleet, the Macs and CI have no way to emit
`madeit-log-v1` records. They print ad-hoc JSON or plain text, so their output
skips the contract's redaction, carries no trace context, and cannot be
queried alongside the TypeScript and Python programs that do use it.
Capturing a subprocess's stdout and stderr as records is the other half of the
same gap.

## Decision

**One `madeit-log` command over the existing TypeScript core,** so redaction,
record shape and coercion keep exactly one implementation. It has two modes,
because their costs differ by three orders of magnitude.

Measured on martinez against the real core (hyperfine):

| | cost |
|---|---|
| bare `bun` start | 5.5 ms |
| one process per record | 14.1 ms per record (11.6 ms bundled) |
| one process reading a stream | about 14 ms to start, then about 3 µs per line (10,000 lines in 45 ms) |

- **`madeit-log <debug|info|warn|error> <event> <body> [key=value ...]`** is
  the per-event form. At about 14 ms a call, it suits lifecycle events, not
  per-line output.
- **`madeit-log pipe <event> [--level L] [--stream stdout|stderr] [--tee]`**
  reads stdin and emits one record per line, with the line as the
  `madeit.line` attribute and the stream as `madeit.stream`. It is how a
  subprocess's output becomes records:
  `cmd 2> >(madeit-log pipe build.output --stream stderr --tee >&2) | madeit-log pipe build.output --tee`.
  `--tee` also passes each line through unchanged, so capturing never swallows
  output a person or a pipe expects. Lines longer than 16 KiB are cut, and the
  record says so with `madeit.truncated`.

## The interface

- **Resource** comes from the environment, set once at the top of a script:
  `MADEIT_SERVICE`, `MADEIT_VERSION`, `MADEIT_ENVIRONMENT`, `MADEIT_REPO`,
  `MADEIT_COMPONENT`. A missing one is filled with `unknown` and named in the
  record's `madeit.missing_resource` attribute. The record still validates,
  and the gap is visible in every line rather than silent.
- **Trace context** comes from `TRACEPARENT`, through the core's `withTrace`.
  A malformed value yields an untraced record, as it does in the core.
- **Attributes** are `key=value` arguments. A value that is a JSON number,
  boolean or null is typed as one; anything else is a string. An argument
  without `=` is kept as `madeit.invalid_attribute` rather than dropped.
- **Sink:** `MADEIT_LOG_SINK=stderr|stdout|file:<path>`, default `stderr`. A
  script's stdout is often its data, and journald already captures stderr for
  services. The core gains a `stderrSink()` beside `stdoutSink()`.
- **It never breaks its caller.** The exit status is 0 for any caller input,
  bad or not. A malformed invocation (unknown level, missing event) becomes a
  `log.meta` record describing the misuse instead of a nonzero exit, because a
  script running under `set -e` must not die because of a log line. `pipe`
  exits 0 at end of input. The only nonzero exit is the runtime itself failing
  to start.

## Security

- **Identity:** the calling script's own user. The command has no privileges
  of its own and opens no network connection.
- **Authentication:** none. It writes only to the sink it is given.
- **Authorization:** whatever the caller can already write to.
- **Redaction** is the core's, key-based: credential-shaped attribute keys are
  dropped, and session ids are truncated. **`pipe` logs line content as a
  value, and key-based redaction does not inspect values.** A command that
  prints a secret to stdout puts it in the log. The README and `--help` say so
  plainly: never pipe a command whose output can carry credentials. Value
  scanning is out of scope for this change.

## Observability

The command is itself a logging tool, so every failure it can observe becomes
a record rather than a silent drop:

- misuse becomes `log.meta`;
- a missing resource is named in `madeit.missing_resource`;
- a truncated line carries `madeit.truncated`;
- a sink failure goes through the core's existing `sink.disabled` path.

## Packaging

- **dev-tools:** `cli.ts` in `src/log/src/core`, built to `dist/cli.js` by the
  package's existing `tsc` build and exposed as `"bin": { "madeit-log": "./dist/cli.js" }`.
  It uses Node APIs only (`node:readline`, `process`), so it runs under Node
  from the published npm package and under Bun on the fleet.
- **box.provisioning:** a derivation from the pinned `devToolsSrc` input that
  fetches dependencies with nixpkgs' `pnpm.fetchDeps` (fixed-output,
  hash-pinned), builds `dist/`, and wraps `dist/cli.js` with Bun. It is
  installed on box, vik and cerberus through the shared module list, and on
  martinez through home-manager. CI steps reach it with `nix shell`.

## How it is proved

- **CLI tests (vitest, in the package):**
  - every emitted record validates against `madeit-log-v1.json`;
  - every case in `redaction-cases.json` goes through the CLI's `key=value`
    path and gets the expected keep, drop or truncate;
  - misuse exits 0 and emits `log.meta`;
  - `pipe` emits one record per line, `--tee` reproduces its input byte for
    byte, and a long line is truncated and marked;
  - a missing resource is named;
  - `TRACEPARENT` sets the trace ids.
- **A throughput test** confirms `pipe` handles 10,000 lines in one process.
  It asserts on process count and correctness, not wall-clock time, so it
  cannot flake.
- **In box.provisioning:** the derivation's check phase runs `madeit-log` once
  and validates the record, and CI builds it for x86_64-linux and
  aarch64-linux.

## Not in this change

- Value-based redaction for `pipe`.
- OTLP export. Records go to a sink; shipping them is the existing collectors'
  job.
- Converting existing bash scripts to use it; each conversion is its own change.

## Success criteria

1. `madeit-log info probe.hello "hello" madeit.n=1` prints one valid
   `madeit-log-v1` record to stderr on box, vik, cerberus and martinez.
2. `pipe` turns a subprocess's stdout and stderr into records, one per line,
   and `--tee` leaves the original output intact.
3. The shared redaction cases pass through the CLI.
4. No input a caller can give makes it exit nonzero.
