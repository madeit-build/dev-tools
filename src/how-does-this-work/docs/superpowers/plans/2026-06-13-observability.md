# Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shared `@made-i-t/hdtw-observability` interface (logging + metrics) injected across the monorepo: the engine emits NDJSON records to stderr; the VS Code client renders engine records and its own into a native Output channel. Rich detail on the agent loop, anchor verification, and repair rounds.

**Architecture:** A CJS, zero-dependency observability package defines `Logger`/`Metrics`/`Observer`, record types, an `ObservabilitySink` seam, and shared `createObserver`/NDJSON/`fanoutSink`/`createNoopObserver` logic. The engine-server provides a `StderrSink` and threads an `Observer` through `runGeneration` and `GenerationHooks`; the VS Code client provides an `OutputChannelSink` (native `LogOutputChannel`), builds a client observer, and ingests the engine's stderr NDJSON into the same channel. `engine-core` is untouched (pure). Spec: `docs/superpowers/specs/2026-06-13-observability-design.md`.

**Tech Stack:** existing monorepo stack. New: VS Code `LogOutputChannel`, configuration. No new third-party deps.

**Conventions (follow exactly):** scope `@made-i-t/hdtw-*`; `.js` extensions on ALL relative imports; the observability package is **CJS** (no `"type":"module"`) with an `exports` map (`types` condition first); tests co-located in `src/`, excluded from `tsc` build; commands run from the repository root.

---

### Task 1: `@made-i-t/hdtw-observability` package

**Files:**

- Modify: `pnpm-workspace.yaml`
- Create: `src/observability/package.json`
- Create: `src/observability/tsconfig.json`
- Create: `src/observability/src/records.ts`
- Create: `src/observability/src/observer.ts`
- Create: `src/observability/src/serialization.ts`
- Create: `src/observability/src/index.ts`
- Test: `src/observability/src/observer.test.ts`
- Test: `src/observability/src/serialization.test.ts`

- [ ] **Step 1: Add the package to the workspace** — in `pnpm-workspace.yaml`, add `  - "src/observability"` to the `packages` list (after the `src/protocol` line).

- [ ] **Step 2: Create `src/observability/package.json`**

```json
{
  "name": "@made-i-t/hdtw-observability",
  "version": "0.0.1",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "require": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "eslint src"
  },
  "devDependencies": {
    "typescript": "^5.8.3",
    "vitest": "^3.1.0"
  }
}
```

- [ ] **Step 3: Create `src/observability/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 4: Create `src/observability/src/records.ts`**

```ts
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

/** Numeric ordering for level filtering; higher = more severe. */
export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export interface LogRecord {
  kind: "log";
  ts: number;
  level: LogLevel;
  event: string;
  fields?: Record<string, unknown>;
}

export type MetricKind = "count" | "timing";

export interface MetricRecord {
  kind: "metric";
  ts: number;
  metric: MetricKind;
  name: string;
  value: number;
  fields?: Record<string, unknown>;
}

export type ObservabilityRecord = LogRecord | MetricRecord;

export interface ObservabilitySink {
  record(record: ObservabilityRecord): void;
}
```

- [ ] **Step 5: Write the failing test — `src/observability/src/observer.test.ts`**

```ts
import { describe, expect, test } from "vitest";
import type { ObservabilityRecord, ObservabilitySink } from "./records.js";
import { createNoopObserver, createObserver, fanoutSink } from "./observer.js";

function capturing(): {
  sink: ObservabilitySink;
  records: ObservabilityRecord[];
} {
  const records: ObservabilityRecord[] = [];
  return { sink: { record: (r) => records.push(r) }, records };
}

describe("createObserver", () => {
  test("emits log records with a fixed clock", () => {
    const { sink, records } = capturing();
    const observer = createObserver({ sink, now: () => 1000 });
    observer.logger.info("generate.start", { topic: "x" });
    expect(records).toEqual([
      {
        kind: "log",
        ts: 1000,
        level: "info",
        event: "generate.start",
        fields: { topic: "x" },
      },
    ]);
  });

  test("filters records below minLevel", () => {
    const { sink, records } = capturing();
    const observer = createObserver({ sink, minLevel: "warn", now: () => 0 });
    observer.logger.debug("noisy");
    observer.logger.error("boom");
    expect(records.map((r) => r.kind === "log" && r.event)).toEqual(["boom"]);
  });

  test("count and timing emit metric records", () => {
    const { sink, records } = capturing();
    const observer = createObserver({ sink, now: () => 5 });
    observer.metrics.count("verify.drift", 2);
    observer.metrics.timing("generate.duration_ms", 1800);
    expect(records).toEqual([
      {
        kind: "metric",
        ts: 5,
        metric: "count",
        name: "verify.drift",
        value: 2,
      },
      {
        kind: "metric",
        ts: 5,
        metric: "timing",
        name: "generate.duration_ms",
        value: 1800,
      },
    ]);
  });

  test("count defaults value to 1", () => {
    const { sink, records } = capturing();
    const observer = createObserver({ sink, now: () => 0 });
    observer.metrics.count("repair.round");
    expect(records[0]).toMatchObject({
      metric: "count",
      name: "repair.round",
      value: 1,
    });
  });

  test("startSpan emits a timing metric on end using elapsed time", () => {
    const { sink, records } = capturing();
    let clock = 100;
    const observer = createObserver({ sink, now: () => clock });
    const span = observer.metrics.startSpan("agent.explore", { topic: "x" });
    clock = 350;
    span.end({ steps: 5 });
    expect(records).toEqual([
      {
        kind: "metric",
        ts: 350,
        metric: "timing",
        name: "agent.explore",
        value: 250,
        fields: { topic: "x", steps: 5 },
      },
    ]);
  });
});

describe("fanoutSink", () => {
  test("delivers each record to every sink", () => {
    const a = capturing();
    const b = capturing();
    const fan = fanoutSink([a.sink, b.sink]);
    const observer = createObserver({ sink: fan, now: () => 0 });
    observer.logger.info("hi");
    expect(a.records).toHaveLength(1);
    expect(b.records).toHaveLength(1);
  });

  test("one throwing sink does not stop the others", () => {
    const good = capturing();
    const bad: ObservabilitySink = {
      record() {
        throw new Error("sink failure");
      },
    };
    const fan = fanoutSink([bad, good.sink]);
    expect(() =>
      fan.record({ kind: "log", ts: 0, level: "info", event: "x" }),
    ).not.toThrow();
    expect(good.records).toHaveLength(1);
  });
});

describe("createNoopObserver", () => {
  test("is inert and span.end does not throw", () => {
    const observer = createNoopObserver();
    expect(() => {
      observer.logger.error("ignored");
      observer.metrics.count("ignored");
      observer.metrics.startSpan("ignored").end();
    }).not.toThrow();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm install && pnpm --filter @made-i-t/hdtw-observability test`
Expected: FAIL — cannot find module `./observer.js`.

- [ ] **Step 7: Write `src/observability/src/observer.ts`**

```ts
import {
  LOG_LEVEL_ORDER,
  type LogLevel,
  type ObservabilityRecord,
  type ObservabilitySink,
} from "./records.js";

export interface Span {
  end(fields?: Record<string, unknown>): void;
}

export interface Logger {
  trace(event: string, fields?: Record<string, unknown>): void;
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface Metrics {
  count(name: string, value?: number, fields?: Record<string, unknown>): void;
  timing(
    name: string,
    milliseconds: number,
    fields?: Record<string, unknown>,
  ): void;
  startSpan(name: string, fields?: Record<string, unknown>): Span;
}

export interface Observer {
  logger: Logger;
  metrics: Metrics;
}

export interface CreateObserverOptions {
  sink: ObservabilitySink;
  minLevel?: LogLevel;
  now?: () => number;
}

export function createObserver(options: CreateObserverOptions): Observer {
  const minLevel = options.minLevel ?? "info";
  const now = options.now ?? (() => Date.now());
  const threshold = LOG_LEVEL_ORDER[minLevel];

  const emit = (record: ObservabilityRecord): void => {
    options.sink.record(record);
  };

  const log = (
    level: LogLevel,
    event: string,
    fields?: Record<string, unknown>,
  ): void => {
    if (LOG_LEVEL_ORDER[level] < threshold) {
      return;
    }
    emit(
      fields === undefined
        ? { kind: "log", ts: now(), level, event }
        : { kind: "log", ts: now(), level, event, fields },
    );
  };

  const metric = (
    kind: "count" | "timing",
    name: string,
    value: number,
    fields?: Record<string, unknown>,
  ): void => {
    emit(
      fields === undefined
        ? { kind: "metric", ts: now(), metric: kind, name, value }
        : { kind: "metric", ts: now(), metric: kind, name, value, fields },
    );
  };

  return {
    logger: {
      trace: (event, fields) => log("trace", event, fields),
      debug: (event, fields) => log("debug", event, fields),
      info: (event, fields) => log("info", event, fields),
      warn: (event, fields) => log("warn", event, fields),
      error: (event, fields) => log("error", event, fields),
    },
    metrics: {
      count: (name, value = 1, fields) => metric("count", name, value, fields),
      timing: (name, milliseconds, fields) =>
        metric("timing", name, milliseconds, fields),
      startSpan: (name, startFields) => {
        const startedAt = now();
        return {
          end: (endFields) => {
            const merged = { ...startFields, ...endFields };
            metric(
              "timing",
              name,
              now() - startedAt,
              Object.keys(merged).length > 0 ? merged : undefined,
            );
          },
        };
      },
    },
  };
}

export function fanoutSink(sinks: ObservabilitySink[]): ObservabilitySink {
  return {
    record(record) {
      for (const sink of sinks) {
        try {
          sink.record(record);
        } catch {
          // A failing sink must never break producers or other sinks.
        }
      }
    },
  };
}

export function createNoopObserver(): Observer {
  return createObserver({ sink: { record: () => {} }, minLevel: "error" });
}
```

- [ ] **Step 8: Write the failing test — `src/observability/src/serialization.test.ts`**

```ts
import { describe, expect, test } from "vitest";
import type { LogRecord } from "./records.js";
import { parseRecord, serializeRecord } from "./serialization.js";

const record: LogRecord = {
  kind: "log",
  ts: 1717000000000,
  level: "info",
  event: "generate.start",
  fields: { topic: "x" },
};

describe("NDJSON round-trip", () => {
  test("serializeRecord produces a single newline-free JSON line", () => {
    const line = serializeRecord(record);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual(record);
  });

  test("parseRecord reverses serializeRecord", () => {
    expect(parseRecord(serializeRecord(record))).toEqual(record);
  });

  test("parseRecord returns null for non-record lines", () => {
    expect(parseRecord("a raw stack trace line")).toBeNull();
    expect(parseRecord('{"not":"a record"}')).toBeNull();
    expect(parseRecord("")).toBeNull();
    expect(parseRecord("   ")).toBeNull();
  });

  test("parseRecord accepts metric records", () => {
    const line = serializeRecord({
      kind: "metric",
      ts: 1,
      metric: "count",
      name: "verify.drift",
      value: 2,
    });
    expect(parseRecord(line)).toMatchObject({
      kind: "metric",
      name: "verify.drift",
    });
  });
});
```

- [ ] **Step 9: Run test to verify it fails**

Run: `pnpm --filter @made-i-t/hdtw-observability test`
Expected: FAIL — cannot find module `./serialization.js`.

- [ ] **Step 10: Write `src/observability/src/serialization.ts`**

```ts
import type { ObservabilityRecord } from "./records.js";

export function serializeRecord(record: ObservabilityRecord): string {
  return JSON.stringify(record);
}

export function parseRecord(line: string): ObservabilityRecord | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.kind === "log"
      && typeof candidate.event === "string"
      && typeof candidate.ts === "number"
  ) {
    return parsed as ObservabilityRecord;
  }
  if (candidate.kind === "metric"
      && typeof candidate.name === "string"
      && typeof candidate.value === "number"
      && typeof candidate.ts === "number"
  ) {
    return parsed as ObservabilityRecord;
  }
  return null;
}
```

- [ ] **Step 11: Write `src/observability/src/index.ts`**

```ts
export * from "./records.js";
export * from "./observer.js";
export * from "./serialization.js";
```

- [ ] **Step 12: Run tests and build**

Run: `pnpm --filter @made-i-t/hdtw-observability test && pnpm --filter @made-i-t/hdtw-observability build`
Expected: 2 test files pass (15 tests); build exit 0; `dist/` contains no `*.test.*`.

- [ ] **Step 13: Commit**

```bash
git add pnpm-workspace.yaml src/observability pnpm-lock.yaml
git commit -m "feat(observability): add logging + metrics interface package"
```

---

### Task 2: Thread an Observer through engine-server generation

**Files:**

- Modify: `src/engine/server/package.json` (add observability dep)
- Create: `src/engine/server/src/stderrSink.ts`
- Modify: `src/engine/server/src/tourGenerator.ts` (add `observer` to `GenerationHooks`)
- Modify: `src/engine/server/src/fakeTourGenerator.ts` (no behavior change; signature already receives hooks)
- Modify: `src/engine/server/src/generationPipeline.ts` (accept + use observer)
- Modify: `src/engine/server/src/main.ts` (build observer, inject)
- Modify: `src/engine/server/tests/generationPipeline.test.ts` (pass a capturing observer, assert records)

- [ ] **Step 1: Add the dependency** — in `src/engine/server/package.json` dependencies add `"@made-i-t/hdtw-observability": "workspace:*"` (alphabetical, before `@made-i-t/hdtw-protocol`). Run `pnpm install`.

- [ ] **Step 2: Create `src/engine/server/src/stderrSink.ts`**

```ts
import {
  serializeRecord,
  type ObservabilityRecord,
  type ObservabilitySink,
} from "@made-i-t/hdtw-observability";

/** Writes each record as one NDJSON line to stderr (stdout is the JSON-RPC channel). */
export class StderrSink implements ObservabilitySink {
  record(record: ObservabilityRecord): void {
    process.stderr.write(serializeRecord(record) + "\n");
  }
}
```

- [ ] **Step 3: Add `observer` to `GenerationHooks`** — in `src/engine/server/src/tourGenerator.ts`, add the import and field:

```ts
import type { GenerationProgressParams } from "@made-i-t/hdtw-protocol";
import type { Observer } from "@made-i-t/hdtw-observability";
```

and in the `GenerationHooks` interface add:

```ts
export interface GenerationHooks {
  onProgress(progress: GenerationProgressParams): void;
  /** Aborted on client cancellation or budget breach. Implementations must stop promptly. */
  signal: AbortSignal;
  /** Structured logging + metrics for this generation run. */
  observer: Observer;
}
```

- [ ] **Step 4: Update the pipeline test FIRST (TDD) — `src/engine/server/tests/generationPipeline.test.ts`**

Add the import:

```ts
import {
  createObserver,
  type ObservabilityRecord,
} from "@made-i-t/hdtw-observability";
```

Add a module-level capture and reset it in `beforeEach` (alongside `progress = []`):

```ts
let observed: ObservabilityRecord[];
```

In `beforeEach` add: `observed = [];`

Change the `run` helper to construct an observer wired to a capturing sink and pass it into `runGeneration`:

```ts
function run(
  generator: FakeTourGenerator,
  options: { maxBudgetUsd?: number; signal?: AbortSignal } = {},
) {
  const controller = new AbortController();
  const observer = createObserver({
    sink: { record: (r) => observed.push(r) },
    minLevel: "trace",
    now: () => 0,
  });
  return runGeneration(
    {
      workspaceRoot,
      topic: "how does it work",
      maxBudgetUsd: options.maxBudgetUsd,
    },
    generator,
    observer,
    (p) => progress.push(p),
    options.signal ?? controller.signal,
  );
}
```

Add a new test at the end of the `describe("runGeneration", ...)` block:

```ts
test("emits observability records across the run", async () => {
  await run(new FakeTourGenerator());
  const logEvents = observed.filter((r) => r.kind === "log")
                            .map((r) => (r as { event: string }).event);
  expect(logEvents).toContain("generate.start");
  expect(logEvents).toContain("verify.step");
  expect(logEvents).toContain("generate.done");
  const metricNames = observed.filter((r) => r.kind === "metric")
                              .map((r) => (r as { name: string }).name);
  expect(metricNames).toContain("generate.duration_ms");
});

test("repair round is logged", async () => {
  await run(new FakeTourGenerator({ draft: BAD_DRAFT }));
  const logEvents = observed.filter((r) => r.kind === "log")
                            .map((r) => (r as { event: string }).event);
  expect(logEvents).toContain("repair.round");
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `pnpm --filter @made-i-t/hdtw-engine-server build`
Expected: FAIL — `runGeneration` does not yet accept an `observer` argument (TS compile error), and `GenerationHooks` consumers need the field.

- [ ] **Step 6: Update `runGeneration` and instrument it — `src/engine/server/src/generationPipeline.ts`**

Add the import:

```ts
import type { Observer } from "@made-i-t/hdtw-observability";
```

Change the `runGeneration` signature to take `observer` (after `generator`):

```ts
export async function runGeneration(
  params: GenerateTourParams,
  generator: TourGenerator,
  observer: Observer,
  onProgress: (progress: GenerationProgressParams) => void,
  cancelSignal: AbortSignal
): Promise<GenerateTourResult> {
```

At the very start of the function body (after the `maxBudgetUsd` line), add:

```ts
const span = observer.metrics.startSpan("generate.duration_ms", {
  topic: params.topic,
});
observer.logger.info("generate.start", {
  topic: params.topic,
  model: params.model ?? "(default)",
  maxBudgetUsd,
});
```

Add `observer` to the `hooks` object so generators can log:

```ts
const hooks = {
  signal: abort.signal,
  observer,
  onProgress: (progress: GenerationProgressParams) => {
    onProgress(progress);
    if (progress.estimatedCostUsd > maxBudgetUsd
        && budgetBreachedAtUsd === undefined
    ) {
      budgetBreachedAtUsd = progress.estimatedCostUsd;
      abort.abort();
    }
  },
};
```

When the repair round runs, before the `generator.repair(...)` call add:

```ts
observer.logger.info("repair.round", { errors: verified.errors });
observer.metrics.count("generate.repair_rounds");
```

In `verifyDraft`, after computing the per-step result, log it. Change `verifyDraft` to accept the observer and log each step. Update its signature and the two call sites to pass `observer`:

```ts
async function verifyDraft(
  workspaceRoot: string,
  draft: DraftTour,
  observer: Observer,
  onProgress: (progress: GenerationProgressParams) => void,
): Promise<VerifiedDraft> {
  onProgress({
    phase: "verifying",
    message: "Verifying anchors",
    tokensIn: 0,
    tokensOut: 0,
    estimatedCostUsd: 0,
  });
  const errors: string[] = [];
  const steps: TourStep[] = [];
  for (const step of draft.steps) {
    const verifiedStep = await verifyStep(workspaceRoot, step);
    if (typeof verifiedStep === "string") {
      observer.logger.warn("verify.step", {
        ok: false,
        file: step.anchor.file,
        error: verifiedStep,
      });
      observer.metrics.count("verify.drift");
      errors.push(verifiedStep);
    } else {
      observer.logger.info("verify.step", {
        ok: true,
        title: step.title,
        file: step.anchor.file,
      });
      steps.push(verifiedStep);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, steps };
}
```

Update both `verifyDraft(...)` call sites in `runGeneration` to pass `observer` as the third argument (before `onProgress`).

Before the final `return saveTour(...)`, end the span and log done. Change the tail of `runGeneration` to:

```ts
onProgress({
  phase: "saving",
  message: "Saving tour",
  tokensIn: 0,
  tokensOut: 0,
  estimatedCostUsd: 0,
});
const result = await saveTour(params.workspaceRoot, draft, verified.steps);
observer.logger.info("generate.done", {
  id: result.tour.id,
  steps: result.tour.steps.length,
  savedPath: result.savedPath,
});
span.end({ steps: result.tour.steps.length });
return result;
```

(The `span.end` only runs on success; aborts/failures throw before it, which is acceptable — duration is only meaningful for completed runs.)

- [ ] **Step 7: Update `main.ts` to build and inject the observer — `src/engine/server/src/main.ts`**

Add imports:

```ts
import { createObserver, type LogLevel } from "@made-i-t/hdtw-observability";
import { StderrSink } from "./stderrSink.js";
```

After the `connection` is created, build the observer:

```ts
const VALID_LEVELS: readonly LogLevel[] = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
];
const configuredLevel = process.env.HDTW_LOG_LEVEL as LogLevel | undefined;
const minLevel: LogLevel =
  configuredLevel && VALID_LEVELS.includes(configuredLevel)
    ? configuredLevel
    : "info";
const observer = createObserver({ sink: new StderrSink(), minLevel });
```

In the `GENERATE_TOUR_METHOD` handler, pass `observer` to `runGeneration` (after `createGenerator()`):

```ts
return await runGeneration(
  params,
  createGenerator(),
  observer,
  (progress) =>
    connection.sendNotification(GENERATION_PROGRESS_NOTIFICATION, progress),
  abort.signal,
);
```

- [ ] **Step 8: Build and run all server tests**

Run: `pnpm --filter @made-i-t/hdtw-engine-server build && pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: all pass — 22 prior + 2 new observability tests = 24. (The e2e tests go through `main.ts` which now builds the observer; they emit NDJSON to inherited stderr — harmless.)

- [ ] **Step 9: Commit**

```bash
git add src/engine/server pnpm-lock.yaml
git commit -m "feat(engine-server): thread observer through generation; emit records to stderr"
```

---

### Task 3: Instrument the Claude agent loop

**Files:**

- Modify: `src/engine/server/src/claudeTourGenerator.ts`

No automated test exercises the real SDK path; instrumentation is verified by the F5 dogfood. `parseDraft` tests are unaffected.

- [ ] **Step 1: Log tool use, per-turn usage, and parse failures in `runQuery`** — in `src/engine/server/src/claudeTourGenerator.ts`, inside the `for await (const message of response)` loop, extend the handling so the agent's actions are observable. Replace the loop body with:

```ts
for await (const message of response) {
  if (message.type === "assistant") {
    const usage = message.message.usage;
    tokensIn += usage?.input_tokens ?? 0;
    tokensOut += usage?.output_tokens ?? 0;
    for (const block of message.message.content) {
      if (block.type === "tool_use") {
        hooks.observer.logger.debug("agent.tool", {
          tool: block.name,
          input: block.input,
        });
      }
    }
    hooks.observer.logger.debug("agent.usage", { phase, tokensIn, tokensOut });
    hooks.onProgress({
      phase,
      message:
        phase === "exploring"
          ? "Agent exploring the codebase"
          : "Agent repairing anchors",
      tokensIn,
      tokensOut,
      estimatedCostUsd:
        tokensIn * ESTIMATED_USD_PER_INPUT_TOKEN
        + tokensOut * ESTIMATED_USD_PER_OUTPUT_TOKEN,
    });
  }
  if (message.type === "result") {
    if (message.subtype === "success") {
      resultText = message.result;
    } else {
      throw new GenerationFailedError(
        `agent run ended without a result (${message.subtype})`,
      );
    }
  }
}
```

If the installed SDK's assistant-message content block shape differs (e.g. the block union member name for tool calls is not `tool_use`, or `content` is not directly iterable), adapt the field access to the SDK's exported types and report the deviation — do not drop the `agent.tool` logging silently.

- [ ] **Step 2: Log a parse failure before throwing** — in `parseDraft`, the function currently throws on invalid JSON without surfacing the raw text. Since `parseDraft` is a free function without an observer, leave it as-is; instead, in `runQuery`, wrap the final `return parseDraft(resultText);` so a failure logs the raw output first:

```ts
try {
  return parseDraft(resultText);
} catch (error) {
  hooks.observer.logger.error("agent.parse_failed", {
    resultPreview: resultText.slice(0, 2000),
  });
  throw error;
}
```

- [ ] **Step 3: Build, test, lint**

Run: `pnpm build && pnpm --filter @made-i-t/hdtw-engine-server test && pnpm lint`
Expected: build clean (SDK types compile for the content-block access), server tests 24, lint clean.

- [ ] **Step 4: Commit**

```bash
git add src/engine/server/src/claudeTourGenerator.ts
git commit -m "feat(engine-server): log agent tool use, per-turn usage, and parse failures"
```

---

### Task 4: VS Code Output channel + stderr ingestion + log level

**Files:**

- Modify: `src/clients/vscode/package.json` (observability dep + `hdtw.logLevel` setting)
- Create: `src/clients/vscode/src/outputChannelSink.ts`
- Modify: `src/clients/vscode/src/engineClient.ts` (stderr NDJSON ingestion; pass observer/sink in)
- Modify: `src/clients/vscode/src/extension.ts` (build channel + observer, wire log level into spawn env, instrument events)

- [ ] **Step 1: Manifest — `src/clients/vscode/package.json`**

Add the dependency to `dependencies`: `"@made-i-t/hdtw-observability": "workspace:*"` (alphabetical, before `@made-i-t/hdtw-protocol`). Then add a property to the existing `contributes.configuration.properties` object:

```json
        "hdtw.logLevel": {
          "type": "string",
          "enum": ["error", "warn", "info", "debug", "trace"],
          "default": "info",
          "description": "Verbosity of the HDTW output channel and engine logs."
        }
```

Run `pnpm install`.

- [ ] **Step 2: Create `src/clients/vscode/src/outputChannelSink.ts`**

```ts
import * as vscode from "vscode";
import type {
  ObservabilityRecord,
  ObservabilitySink,
} from "@made-i-t/hdtw-observability";

/** Renders observability records into a native VS Code LogOutputChannel. */
export class OutputChannelSink implements ObservabilitySink {
  constructor(private readonly channel: vscode.LogOutputChannel) {}

  record(record: ObservabilityRecord): void {
    try {
      if (record.kind === "metric") {
        this.channel.debug(
          `metric ${record.name}=${record.value}${formatFields(record.fields)}`,
        );
        return;
      }
      const line = `${record.event}${formatFields(record.fields)}`;
      switch (record.level) {
        case "trace":
          this.channel.trace(line);
          break;
        case "debug":
          this.channel.debug(line);
          break;
        case "info":
          this.channel.info(line);
          break;
        case "warn":
          this.channel.warn(line);
          break;
        case "error":
          this.channel.error(line);
          break;
      }
    } catch {
      // Never let rendering break the producer.
    }
  }

  /** A non-record stderr line from the engine (raw SDK output, stack trace). */
  appendRaw(line: string): void {
    try {
      this.channel.appendLine(line);
    } catch {
      // ignore
    }
  }
}

function formatFields(fields: Record<string, unknown> | undefined): string {
  if (!fields || Object.keys(fields).length === 0) {
    return "";
  }
  return " " + JSON.stringify(fields);
}
```

- [ ] **Step 3: Engine stderr ingestion — `src/clients/vscode/src/engineClient.ts`**

Add the import:

```ts
import { parseRecord } from "@made-i-t/hdtw-observability";
import type { OutputChannelSink } from "./outputChannelSink.js";
```

Change the `EngineClient` constructor to accept the sink:

```ts
  constructor(private readonly sink: OutputChannelSink) {}
```

Replace the existing stderr handler (the `serverProcess.stderr?.on("data", ...)` block that calls `console.error`) with a newline-buffered NDJSON reader:

```ts
let stderrBuffer = "";
serverProcess.stderr?.on("data", (chunk: Buffer) => {
  stderrBuffer += chunk.toString();
  let newlineIndex = stderrBuffer.indexOf("\n");
  while (newlineIndex !== -1) {
    const line = stderrBuffer.slice(0, newlineIndex);
    stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
    const record = parseRecord(line);
    if (record) {
      this.sink.record(record);
    } else if (line.trim().length > 0) {
      this.sink.appendRaw(`[engine] ${line}`);
    }
    newlineIndex = stderrBuffer.indexOf("\n");
  }
});
```

- [ ] **Step 4: Build channel + observer, wire log level + instrument — `src/clients/vscode/src/extension.ts`**

Add imports at the top:

```ts
import { createObserver, type Observer } from "@made-i-t/hdtw-observability";
import { OutputChannelSink } from "./outputChannelSink.js";
```

Add module state alongside the others:

```ts
let channel: vscode.LogOutputChannel | undefined;
let sink: OutputChannelSink | undefined;
let observer: Observer | undefined;
```

At the very start of `activate` (before `if (client)`), build the channel/observer and add a helper to read the level:

```ts
channel = channel ?? vscode.window.createOutputChannel("HDTW", { log: true });
sink = sink ?? new OutputChannelSink(channel);
const logLevel = vscode.workspace.getConfiguration("hdtw")
                                 .get<string>("logLevel", "info");
observer = createObserver({ sink, minLevel: normalizeLevel(logLevel) });
context.subscriptions.push(channel);
```

Change the `EngineClient` construction to pass the sink:

```ts
client = new EngineClient(sink);
```

Change the `connect` call to also pass the log level into the engine env (merge with the existing apiKey env):

```ts
const apiKey = await context.secrets.get(API_KEY_SECRET);
const env: Record<string, string> = { HDTW_LOG_LEVEL: logLevel };
if (apiKey) {
  env.ANTHROPIC_API_KEY = apiKey;
}
const result = await client.connect(env);
observer.logger.info("engine.connected", {
  engine: result.engineName,
  version: result.engineVersion,
});
```

Add the `normalizeLevel` helper near the bottom of the file:

```ts
function normalizeLevel(
  value: string,
): "error" | "warn" | "info" | "debug" | "trace" {
  switch (value) {
    case "error":
    case "warn":
    case "info":
    case "debug":
    case "trace":
      return value;
    default:
      return "info";
  }
}
```

Instrument the generate flow: in `generateTour`, immediately after `if (!topic) { return; }`, add:

```ts
observer?.logger.info("generate.requested", { topic });
```

and in `handleGenerationError`, at the top of the function add:

```ts
observer?.logger.error("generate.error", {
  code: (error as { code?: number }).code,
  message: error instanceof Error ? error.message : String(error),
});
```

In `startTour`, after a successful `getTour`, add:

```ts
observer?.logger.info("tour.started", { tourId });
```

(place it right after `const { tour } = await client.getTour(root, tourId);`)

- [ ] **Step 5: Full verification**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: build clean; tests pass (protocol 3, observability 15, core 21, server 24, vscode 2 = 65); lint clean.

- [ ] **Step 6: Commit**

```bash
git add src/clients/vscode pnpm-lock.yaml
git commit -m "feat(vscode): render engine + client observability in an Output channel"
```

---

### Task 5: Docs

**Files:**

- Modify: `docs/product-roadmap.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Roadmap** — in `docs/product-roadmap.md`, add a new section immediately after the Chunk 2 block (before Chunk 3):

```markdown
### Chunk 2.5 — Observability ✅ shipped 2026-06-13

Spec: `docs/superpowers/specs/2026-06-13-observability-design.md`

| Feature                                                                                      | Capability                                                                                             |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `@made-i-t/hdtw-observability` — injected `Logger` + `Metrics` + sink seam                   | Structured observability shared across packages; one seam for future telemetry export                  |
| Engine emits NDJSON records to stderr; client renders them in a native "HDTW" Output channel | See the agent's tool use, anchor verification, repair rounds, and timings live — even on startup/crash |
| `hdtw.logLevel` setting → `HDTW_LOG_LEVEL` engine env                                        | One control for engine + client verbosity                                                              |
```

- [ ] **Step 2: AGENTS.md** — in **Current state**, add after the Chunk 2 bullet:

```markdown
- **Chunk 2.5 shipped — observability:** `@made-i-t/hdtw-observability` defines injected `Logger`/`Metrics` + an `ObservabilitySink` seam. The engine writes NDJSON records to stderr (`StderrSink`); the VS Code client ingests them plus its own events into a native "HDTW" `LogOutputChannel`. Verbosity: the `hdtw.logLevel` setting, forwarded as `HDTW_LOG_LEVEL`. `engine-core` is intentionally uninstrumented (pure).
```

In **Working conventions**, add:

```markdown
- Observability is injected, never imported ad hoc: code takes an `Observer` (from `@made-i-t/hdtw-observability`); the engine's sink writes NDJSON to stderr, the client's renders to its Output channel. Do not add bare `console.log`/`console.error` — use the injected observer.
```

- [ ] **Step 3: Full verification**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: all green (65 tests).

- [ ] **Step 4: Commit**

```bash
git add docs/product-roadmap.md AGENTS.md
git commit -m "docs: mark observability (chunk 2.5) shipped"
```
