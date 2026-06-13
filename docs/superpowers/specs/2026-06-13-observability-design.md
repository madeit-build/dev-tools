# Design: Observability (logging + metrics) across HDTW

**Date:** 2026-06-13
**Status:** Approved
**Context:** Roadmap "Chunk 2.5". Stacks on Chunk 2 (agent tour generation) — it instruments the generation pipeline and agent loop that chunk introduced. Motivated by dogfooding: the author needs to see what the agent is doing in a VS Code Output channel.

## Goal

A shared observability interface (logging + metrics) injected across the monorepo, with environment-specific sinks: the engine serializes records to stderr as NDJSON; the VS Code client renders them — plus its own client-side records — into a native Output channel. Rich, structured detail on the agent's exploration, anchor verification, and repair rounds.

## Key decisions

- **Logging + metrics now; one sink seam for the future.** A `Logger` and a `Metrics` interface, plus a single `ObservabilitySink` interface. Remote/aggregate telemetry export is a future sink implementation, not new surface now.
- **Transport across the process boundary: structured stderr (NDJSON).** The engine's stdout is the JSON-RPC channel, so it cannot carry logs. Each record is one JSON line on stderr. This is lifecycle-independent — it captures startup, crashes, and any request, exactly when logs matter most — and can never corrupt the protocol. The stderr pipe already exists in the client.
- **Same producer API both sides; only the sink differs.** This realizes "interface as a dependency, VS Code implementation injected": the package is the dependency, `OutputChannelSink` is the injected VS Code implementation, the engine gets `StderrSink`.
- **`engine-core` stays out.** It is pure transformation; the server logs the results of core calls. Keeps the purity rule crisp and the dependency graph minimal.

## Package: `@made-i-t/hdtw-observability`

New package at `src/observability` (added to `pnpm-workspace.yaml`). **CJS**, zero runtime dependencies, no transport or VS Code code — so any package may depend on it.

Exports:

- **Producer API:** `Logger` (`debug/info/warn/error(event: string, fields?: Record<string, unknown>): void`); `Metrics` (`count(name, value?, fields?)`, `timing(name, ms, fields?)`, `startSpan(name, fields?): Span` where `Span.end(fields?)` emits a timing metric); `Observer = { logger: Logger; metrics: Metrics }`.
- **Records:** `LogLevel`; `LogRecord` and `MetricRecord` with `ts`, level/kind, `event`/`name`, and `fields`; union `ObservabilityRecord`.
- **Sink seam:** `ObservabilitySink { record(record: ObservabilityRecord): void }`.
- **Shared logic (no env coupling):** `createObserver({ sink, minLevel?, now? }): Observer` — turns producer calls into records and forwards them; level-filters; times spans via an injectable `now` (default `Date.now`) so tests are deterministic. `serializeRecord(record): string` and `parseRecord(line): ObservabilityRecord | null` (NDJSON; returns null on non-record lines). `fanoutSink(sinks: ObservabilitySink[]): ObservabilitySink`. `createNoopObserver(): Observer`.

## Data flow

```
engine app code  →  observer.logger.info('generate.start', {...})
   → createObserver → StderrSink → NDJSON line on stderr
        ⇢ client reads stderr lines → parseRecord
             → client sink → "HDTW" Output channel (+ future telemetry sinks)
client app code  →  client observer → same Output-channel sink (no round-trip)
```

## Engine side (`engine-server`)

- `StderrSink` writes `serializeRecord(r) + "\n"` to `process.stderr`.
- `main.ts` builds the observer once (`minLevel` from `HDTW_LOG_LEVEL` env, default `info`) and injects it into `runGeneration`; `GenerationHooks` gains an `observer: Observer` field so the `TourGenerator` logs through it.
- Instrumentation:
  - **ClaudeAgentTourGenerator:** `agent.tool` per Read/Grep/Glob use; `agent.usage` per turn (cumulative tokens, running cost estimate); the raw draft text on parse failure.
  - **Generation pipeline:** `generate.start` / `generate.done`; `verify.step` (ok or drifted, per anchor); `repair.round` with the error list; metrics `generate.duration_ms`, `generate.repair_rounds`, `verify.drift` count, token totals.

## VS Code client

- `OutputChannelSink` wraps a native `LogOutputChannel` (`vscode.window.createOutputChannel("HDTW", { log: true })` — real level filtering + timestamps in the UI). It maps record level/kind to the channel's `trace/debug/info/warn/error`.
- The extension builds a client observer on that sink for its own events (engine spawn, getTour, walk, generate command).
- The current `console.error` stderr handler is replaced by a line reader: NDJSON lines → `parseRecord` → the same sink; **non-JSON lines** (raw SDK warnings, stack traces) are appended verbatim so nothing is lost.
- New setting `hdtw.logLevel` (enum `error|warn|info|debug|trace`, default `info`), passed to the engine as `HDTW_LOG_LEVEL` in the spawn env (same mechanism as the API key) and used for the client observer's `minLevel`.

## Error handling

The stderr line reader is garbage-tolerant: a malformed line never throws — it is appended verbatim. Observability never affects generation success/failure; sinks must not throw into producer code (the client sink wraps channel writes defensively).

## Testing

- **observability package (TDD):** `createObserver` record production + level filtering + span timing (injected clock); NDJSON serialize/parse round-trip; garbage line → `null`; `fanoutSink` delivery; `createNoopObserver` is inert.
- **engine-server:** a capturing test sink asserts the generation pipeline emits the expected records (`verify.step`, `repair.round`, `generate.done`) — executable documentation of the contract. Tests construct the observer at `minLevel: "error"` (or use a capturing sink directly) to keep output quiet.
- **vscode client:** parser/sink logic is covered in the package; the stderr-ingestion wiring is verified in the F5 dogfood.

## Module / workspace notes

CJS package, consistent with `protocol`/`engine-core`; the ESM `engine-server` importing it works exactly as it already imports CJS `protocol`/`engine-core`. One line added to `pnpm-workspace.yaml`.

## Out of scope

Remote/aggregate telemetry export (a future sink); persisting logs to disk; per-tour analytics dashboards; instrumenting `engine-core`.
