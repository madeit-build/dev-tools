# Chunk 2: Embedded Agent + Tour Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Generate Tour…" in the VS Code sidebar runs an embedded Claude agent in the engine that explores the workspace, drafts a tour, has its anchors independently verified by the engine, and lands a saved `.tour.json` that auto-walks — with live token/cost progress, a budget cap, and cancellation.

**Architecture:** Generation lives behind a `TourGenerator` port in `engine-server` (Claude Agent SDK implementation + deterministic fake). The pipeline is generator-agnostic: draft (no hashes) → engine-side anchor verification (`engine-core` pure helpers) → one repair round → `parseTour` gate → atomic write. The protocol gains one long-running cancellable request plus a progress notification. Spec: `docs/superpowers/specs/2026-06-12-chunk-2-agent-tour-generation-design.md`.

**Tech Stack:** Existing monorepo stack + `@anthropic-ai/claude-agent-sdk` (engine-server only). New VS Code APIs: SecretStorage, withProgress, configuration.

**Conventions (established, follow exactly):** scope `@made-i-t/hdtw-*`; `.js` extensions on relative imports; engine-core stays free of fs/transport (NOTE: `node:crypto` is permitted there — deterministic computation, no I/O; Task 7 documents this); clients import code only from the protocol package; commands run from repo root.

---

### Task 1: Generation contract in `@made-i-t/hdtw-protocol`

**Files:**
- Create: `src/protocol/src/generation.ts`
- Modify: `src/protocol/src/index.ts`
- Test: `src/protocol/src/generation.test.ts`

- [ ] **Step 1: Write the failing test — `src/protocol/src/generation.test.ts`**

```ts
import { expect, test } from "vitest";
import {
  GENERATE_TOUR_METHOD,
  GENERATION_AUTH_REQUIRED_ERROR_CODE,
  GENERATION_BUDGET_EXCEEDED_ERROR_CODE,
  GENERATION_FAILED_ERROR_CODE,
  GENERATION_PROGRESS_NOTIFICATION,
} from "./index.js";

test("generation protocol constants are stable", () => {
  expect(GENERATE_TOUR_METHOD).toBe("hdtw/generateTour");
  expect(GENERATION_PROGRESS_NOTIFICATION).toBe("hdtw/generationProgress");
  expect(GENERATION_AUTH_REQUIRED_ERROR_CODE).toBe(-32002);
  expect(GENERATION_FAILED_ERROR_CODE).toBe(-32003);
  expect(GENERATION_BUDGET_EXCEEDED_ERROR_CODE).toBe(-32004);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @made-i-t/hdtw-protocol test`
Expected: FAIL — `generation.test.ts` errors on missing exports (existing 2 tests still pass).

- [ ] **Step 3: Write `src/protocol/src/generation.ts`**

```ts
import type { Tour } from "./tours.js";

/** JSON-RPC method name: client→engine, long-running cancellable tour generation. */
export const GENERATE_TOUR_METHOD = "hdtw/generateTour";

/** JSON-RPC notification: engine→client, progress for an in-flight generation. */
export const GENERATION_PROGRESS_NOTIFICATION = "hdtw/generationProgress";

/** Generation cannot run: no API key and no Claude Code credentials found. */
export const GENERATION_AUTH_REQUIRED_ERROR_CODE = -32002;

/** The agent could not produce a verifiable tour (message carries detail). */
export const GENERATION_FAILED_ERROR_CODE = -32003;

/** Estimated spend crossed maxBudgetUsd; generation was aborted (message carries spend). */
export const GENERATION_BUDGET_EXCEEDED_ERROR_CODE = -32004;

export type GenerationPhase =
  | "exploring"
  | "drafting"
  | "verifying"
  | "repairing"
  | "saving";

export interface GenerateTourParams {
  workspaceRoot: string;
  topic: string;
  /** Model override; omitted/empty means the agent SDK default. */
  model?: string;
  /** Abort when estimated cost crosses this (USD). Engine default applies when omitted. */
  maxBudgetUsd?: number;
}

export interface GenerateTourResult {
  tour: Tour;
  /** Workspace-root-relative path of the written tour file. */
  savedPath: string;
}

export interface GenerationProgressParams {
  phase: GenerationPhase;
  message: string;
  tokensIn: number;
  tokensOut: number;
  /** Rough mid-flight estimate; the final result message is authoritative. */
  estimatedCostUsd: number;
}
```

- [ ] **Step 4: Re-export from `src/protocol/src/index.ts`** — append at the end:

```ts
export * from "./generation.js";
```

- [ ] **Step 5: Run tests and build**

Run: `pnpm --filter @made-i-t/hdtw-protocol test && pnpm --filter @made-i-t/hdtw-protocol build`
Expected: 3 test files pass (3 tests); build exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/protocol
git commit -m "feat(protocol): add generateTour method, progress notification, error codes"
```

---

### Task 2: Anchor verification helpers in `@made-i-t/hdtw-engine-core`

**Files:**
- Create: `src/engine/core/src/anchors.ts`
- Modify: `src/engine/core/src/index.ts`
- Modify: `src/engine/core/package.json` (add `@types/node` devDependency)
- Test: `src/engine/core/src/anchors.test.ts`

Purity note: `node:crypto` is allowed in engine-core (deterministic computation, no I/O). The rule remains: no fs, no transport.

- [ ] **Step 1: Add `@types/node` to engine-core** — in `src/engine/core/package.json` devDependencies add `"@types/node": "^20.17.0"` (alphabetical), and in `src/engine/core/tsconfig.json` add `"types": ["node"]` inside compilerOptions. Run `pnpm install`.

- [ ] **Step 2: Write the failing test — `src/engine/core/src/anchors.test.ts`**

```ts
import { describe, expect, test } from "vitest";
import { computeSnippetHash, extractAnchoredText, verifyAnchor } from "./anchors.js";

describe("computeSnippetHash", () => {
  test("hashes text with the canonical sha256 prefix", () => {
    // sha256("hello") — well-known vector
    expect(computeSnippetHash("hello")).toBe(
      "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
  });
});

describe("extractAnchoredText", () => {
  test("extracts 1-based inclusive line ranges joined with \\n", () => {
    expect(extractAnchoredText("a\nb\nc\nd", 2, 3)).toBe("b\nc");
  });

  test("normalizes CRLF to LF", () => {
    expect(extractAnchoredText("a\r\nb\r\nc", 1, 2)).toBe("a\nb");
  });
});

describe("verifyAnchor", () => {
  const content = "line1\nline2\nline3";

  test("accepts an in-range anchor and returns the computed hash", () => {
    const result = verifyAnchor({ file: "a.ts", startLine: 1, endLine: 2 }, content);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snippetHash).toBe(computeSnippetHash("line1\nline2"));
    }
  });

  test("rejects a range past the end of the file", () => {
    const result = verifyAnchor({ file: "a.ts", startLine: 2, endLine: 9 }, content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toBe("a.ts: endLine 9 exceeds file length 3");
    }
  });

  test("rejects startLine below 1", () => {
    const result = verifyAnchor({ file: "a.ts", startLine: 0, endLine: 1 }, content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toBe("a.ts: startLine must be an integer >= 1 (got 0)");
    }
  });

  test("rejects endLine before startLine", () => {
    const result = verifyAnchor({ file: "a.ts", startLine: 3, endLine: 2 }, content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toBe("a.ts: endLine 2 is before startLine 3");
    }
  });

  test("collects multiple errors", () => {
    const result = verifyAnchor({ file: "a.ts", startLine: 0, endLine: 99 }, content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(2);
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @made-i-t/hdtw-engine-core test`
Expected: FAIL — cannot find module `./anchors.js` (existing 12 tests pass).

- [ ] **Step 4: Write `src/engine/core/src/anchors.ts`**

```ts
import { createHash } from "node:crypto";

/** Canonical snippet hash: sha256 over the anchored lines joined with "\n". */
export function computeSnippetHash(anchoredText: string): string {
  return "sha256:" + createHash("sha256").update(anchoredText).digest("hex");
}

/** 1-based inclusive extraction; CRLF normalized to LF. */
export function extractAnchoredText(
  fileContent: string,
  startLine: number,
  endLine: number
): string {
  return fileContent
    .split(/\r?\n/)
    .slice(startLine - 1, endLine)
    .join("\n");
}

export interface AnchorRange {
  file: string;
  startLine: number;
  endLine: number;
}

export type AnchorVerification =
  | { ok: true; snippetHash: string }
  | { ok: false; errors: [string, ...string[]] };

export function verifyAnchor(anchor: AnchorRange, fileContent: string): AnchorVerification {
  const lineCount = fileContent.split(/\r?\n/).length;
  const errors: string[] = [];

  if (!Number.isInteger(anchor.startLine) || anchor.startLine < 1) {
    errors.push(`${anchor.file}: startLine must be an integer >= 1 (got ${anchor.startLine})`);
  }
  if (!Number.isInteger(anchor.endLine) || anchor.endLine < 1) {
    errors.push(`${anchor.file}: endLine must be an integer >= 1 (got ${anchor.endLine})`);
  } else if (Number.isInteger(anchor.startLine) && anchor.endLine < anchor.startLine) {
    errors.push(`${anchor.file}: endLine ${anchor.endLine} is before startLine ${anchor.startLine}`);
  }
  if (Number.isInteger(anchor.endLine) && anchor.endLine > lineCount) {
    errors.push(`${anchor.file}: endLine ${anchor.endLine} exceeds file length ${lineCount}`);
  }

  if (errors.length > 0) {
    return { ok: false, errors: errors as [string, ...string[]] };
  }
  return {
    ok: true,
    snippetHash: computeSnippetHash(
      extractAnchoredText(fileContent, anchor.startLine, anchor.endLine)
    ),
  };
}
```

- [ ] **Step 5: Re-export from `src/engine/core/src/index.ts`** — append at the end:

```ts
export * from "./anchors.js";
```

- [ ] **Step 6: Run tests and build**

Run: `pnpm --filter @made-i-t/hdtw-engine-core test && pnpm --filter @made-i-t/hdtw-engine-core build`
Expected: 3 test files pass (20 tests: 12 existing + 8 new); build exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/engine/core pnpm-lock.yaml
git commit -m "feat(engine-core): add canonical snippet hashing and anchor verification"
```

---

### Task 3: TourGenerator port, fake generator, and generation pipeline

**Files:**
- Create: `src/engine/server/src/tourGenerator.ts` (port types + errors)
- Create: `src/engine/server/src/fakeTourGenerator.ts`
- Create: `src/engine/server/src/generationPipeline.ts`
- Test: `src/engine/server/tests/generationPipeline.test.ts`

No SDK in this task — the pipeline is proven against the fake.

- [ ] **Step 1: Write `src/engine/server/src/tourGenerator.ts`**

```ts
import type { GenerationProgressParams } from "@made-i-t/hdtw-protocol";

export interface DraftAnchor {
  file: string;
  startLine: number;
  endLine: number;
}

export interface DraftStep {
  title: string;
  narration: string;
  anchor: DraftAnchor;
}

export interface DraftTour {
  title: string;
  summary: string;
  steps: DraftStep[];
}

export interface GenerationHooks {
  onProgress(progress: GenerationProgressParams): void;
  /** Aborted on client cancellation or budget breach. Implementations must stop promptly. */
  signal: AbortSignal;
}

export interface TourGenerator {
  generate(
    workspaceRoot: string,
    topic: string,
    model: string | undefined,
    hooks: GenerationHooks
  ): Promise<DraftTour>;
  /** One repair round: same topic, prior draft, and the anchor errors to fix. */
  repair(
    workspaceRoot: string,
    topic: string,
    draft: DraftTour,
    anchorErrors: string[],
    hooks: GenerationHooks
  ): Promise<DraftTour>;
}

export class AuthRequiredError extends Error {}

export class GenerationFailedError extends Error {}

export class BudgetExceededError extends Error {
  constructor(
    message: string,
    public readonly spentUsd: number
  ) {
    super(message);
  }
}

export class GenerationCancelledError extends Error {}
```

- [ ] **Step 2: Write `src/engine/server/src/fakeTourGenerator.ts`**

The fake is deterministic and configurable so pipeline tests and the stdio e2e share it. Default behavior: emit two progress events, then a one-step draft anchored to `README.md` line 1.

```ts
import type {
  DraftTour,
  GenerationHooks,
  TourGenerator,
} from "./tourGenerator.js";
import { GenerationCancelledError } from "./tourGenerator.js";

export interface FakeTourGeneratorOptions {
  /** First generate() returns this draft; defaults to a valid one-step draft. */
  draft?: DraftTour;
  /** Draft returned by repair(); defaults to the same valid draft. */
  repairedDraft?: DraftTour;
  /** Cost reported per progress event (drives budget tests). */
  costPerEvent?: number;
}

const DEFAULT_DRAFT: DraftTour = {
  title: "Fake tour",
  summary: "A deterministic tour for tests",
  steps: [
    {
      title: "The readme",
      narration: "This is the readme of the workspace.",
      anchor: { file: "README.md", startLine: 1, endLine: 1 },
    },
  ],
};

export class FakeTourGenerator implements TourGenerator {
  constructor(private readonly options: FakeTourGeneratorOptions = {}) {}

  async generate(
    _workspaceRoot: string,
    topic: string,
    _model: string | undefined,
    hooks: GenerationHooks
  ): Promise<DraftTour> {
    this.emit(hooks, "exploring", `Exploring for "${topic}"`, 1000, 200);
    this.throwIfAborted(hooks);
    this.emit(hooks, "drafting", "Drafting tour", 2000, 800);
    this.throwIfAborted(hooks);
    return this.options.draft ?? DEFAULT_DRAFT;
  }

  async repair(
    _workspaceRoot: string,
    _topic: string,
    _draft: DraftTour,
    _anchorErrors: string[],
    hooks: GenerationHooks
  ): Promise<DraftTour> {
    this.emit(hooks, "repairing", "Repairing anchors", 500, 200);
    this.throwIfAborted(hooks);
    return this.options.repairedDraft ?? DEFAULT_DRAFT;
  }

  private emit(
    hooks: GenerationHooks,
    phase: "exploring" | "drafting" | "repairing",
    message: string,
    tokensIn: number,
    tokensOut: number
  ): void {
    hooks.onProgress({
      phase,
      message,
      tokensIn,
      tokensOut,
      estimatedCostUsd: this.options.costPerEvent ?? 0.01,
    });
  }

  private throwIfAborted(hooks: GenerationHooks): void {
    if (hooks.signal.aborted) {
      throw new GenerationCancelledError("fake generator aborted");
    }
  }
}
```

- [ ] **Step 3: Write the failing tests — `src/engine/server/tests/generationPipeline.test.ts`**

```ts
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { GenerationProgressParams } from "@made-i-t/hdtw-protocol";
import { FakeTourGenerator } from "../src/fakeTourGenerator.js";
import { runGeneration } from "../src/generationPipeline.js";
import {
  BudgetExceededError,
  GenerationCancelledError,
  GenerationFailedError,
  type DraftTour,
} from "../src/tourGenerator.js";

let workspaceRoot: string;
let progress: GenerationProgressParams[];

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "hdtw-gen-"));
  await writeFile(path.join(workspaceRoot, "README.md"), "fixture readme\nsecond line\n");
  progress = [];
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function run(generator: FakeTourGenerator, options: { maxBudgetUsd?: number; signal?: AbortSignal } = {}) {
  const controller = new AbortController();
  return runGeneration(
    { workspaceRoot, topic: "how does it work", maxBudgetUsd: options.maxBudgetUsd },
    generator,
    (p) => progress.push(p),
    options.signal ?? controller.signal
  );
}

const BAD_DRAFT: DraftTour = {
  title: "Fake tour",
  summary: "Bad anchors",
  steps: [
    {
      title: "Nope",
      narration: "Points past EOF.",
      anchor: { file: "README.md", startLine: 1, endLine: 99 },
    },
  ],
};

describe("runGeneration", () => {
  test("happy path: verifies, saves atomically, returns tour + relative path", async () => {
    const result = await run(new FakeTourGenerator());
    expect(result.savedPath).toBe(".hdtw/tours/fake-tour.tour.json");
    expect(result.tour.id).toBe("fake-tour");
    expect(result.tour.steps[0].anchor.snippetHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const onDisk = await readFile(path.join(workspaceRoot, result.savedPath), "utf8");
    expect(JSON.parse(onDisk).id).toBe("fake-tour");
    expect(progress.some((p) => p.phase === "verifying")).toBe(true);
    expect(progress.some((p) => p.phase === "saving")).toBe(true);
  });

  test("repair round: bad draft is repaired then saved", async () => {
    const generator = new FakeTourGenerator({ draft: BAD_DRAFT });
    const result = await run(generator);
    expect(result.tour.steps[0].anchor.endLine).toBe(1);
    expect(progress.some((p) => p.phase === "repairing")).toBe(true);
  });

  test("fails after one repair round if anchors still bad", async () => {
    const generator = new FakeTourGenerator({ draft: BAD_DRAFT, repairedDraft: BAD_DRAFT });
    await expect(run(generator)).rejects.toBeInstanceOf(GenerationFailedError);
    const files = await readFile(path.join(workspaceRoot, ".hdtw/tours/fake-tour.tour.json"), "utf8").catch(() => undefined);
    expect(files).toBeUndefined(); // nothing written on failure
  });

  test("budget: aborts when estimated cost crosses maxBudgetUsd", async () => {
    const generator = new FakeTourGenerator({ costPerEvent: 5 });
    await expect(run(generator, { maxBudgetUsd: 1 })).rejects.toBeInstanceOf(BudgetExceededError);
  });

  test("cancellation: pre-aborted signal cancels cleanly", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(run(new FakeTourGenerator(), { signal: controller.signal })).rejects.toBeInstanceOf(
      GenerationCancelledError
    );
  });

  test("filename collision gets a numeric suffix", async () => {
    await mkdir(path.join(workspaceRoot, ".hdtw", "tours"), { recursive: true });
    await writeFile(path.join(workspaceRoot, ".hdtw/tours/fake-tour.tour.json"), "{}");
    const result = await run(new FakeTourGenerator());
    expect(result.savedPath).toBe(".hdtw/tours/fake-tour-2.tour.json");
    expect(result.tour.id).toBe("fake-tour-2");
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: `generationPipeline.test.ts` FAILS — cannot find module `../src/generationPipeline.js` (existing 10 tests pass; build first if dist is stale).

- [ ] **Step 5: Write `src/engine/server/src/generationPipeline.ts`**

```ts
import { mkdir, readFile, rename, writeFile, access } from "node:fs/promises";
import path from "node:path";
import {
  parseTour,
  verifyAnchor,
} from "@made-i-t/hdtw-engine-core";
import type {
  GenerateTourParams,
  GenerateTourResult,
  GenerationProgressParams,
  Tour,
  TourStep,
} from "@made-i-t/hdtw-protocol";
import {
  BudgetExceededError,
  GenerationCancelledError,
  GenerationFailedError,
  type DraftStep,
  type DraftTour,
  type TourGenerator,
} from "./tourGenerator.js";

const DEFAULT_MAX_BUDGET_USD = 2;
const TOURS_DIR_SEGMENTS = [".hdtw", "tours"];

export async function runGeneration(
  params: GenerateTourParams,
  generator: TourGenerator,
  onProgress: (progress: GenerationProgressParams) => void,
  cancelSignal: AbortSignal
): Promise<GenerateTourResult> {
  const maxBudgetUsd = params.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD;
  // One controller feeds the generator: aborted by client cancellation OR budget breach.
  const abort = new AbortController();
  let budgetBreachedAtUsd: number | undefined;

  if (cancelSignal.aborted) {
    throw new GenerationCancelledError("generation cancelled");
  }
  cancelSignal.addEventListener("abort", () => abort.abort(), { once: true });

  const hooks = {
    signal: abort.signal,
    onProgress: (progress: GenerationProgressParams) => {
      onProgress(progress);
      if (progress.estimatedCostUsd > maxBudgetUsd && budgetBreachedAtUsd === undefined) {
        budgetBreachedAtUsd = progress.estimatedCostUsd;
        abort.abort();
      }
    },
  };

  const translateAbort = (error: unknown): never => {
    if (budgetBreachedAtUsd !== undefined) {
      throw new BudgetExceededError(
        `generation aborted: estimated cost $${budgetBreachedAtUsd.toFixed(2)} exceeded budget $${maxBudgetUsd.toFixed(2)}`,
        budgetBreachedAtUsd
      );
    }
    if (cancelSignal.aborted || abort.signal.aborted) {
      throw new GenerationCancelledError("generation cancelled");
    }
    throw error;
  };

  let draft: DraftTour;
  try {
    draft = await generator.generate(params.workspaceRoot, params.topic, normalizeModel(params.model), hooks);
  } catch (error) {
    translateAbort(error);
    throw error; // unreachable; satisfies control flow
  }

  let verified = await verifyDraft(params.workspaceRoot, draft, onProgress);
  if (!verified.ok) {
    try {
      draft = await generator.repair(params.workspaceRoot, params.topic, draft, verified.errors, hooks);
    } catch (error) {
      translateAbort(error);
      throw error;
    }
    verified = await verifyDraft(params.workspaceRoot, draft, onProgress);
    if (!verified.ok) {
      throw new GenerationFailedError(
        `agent could not produce verifiable anchors after one repair round: ${verified.errors.join("; ")}`
      );
    }
  }

  onProgress({ phase: "saving", message: "Saving tour", tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0 });
  return saveTour(params.workspaceRoot, draft, verified.steps);
}

function normalizeModel(model: string | undefined): string | undefined {
  return model && model.trim().length > 0 ? model : undefined;
}

type VerifiedDraft =
  | { ok: true; steps: TourStep[] }
  | { ok: false; errors: string[] };

async function verifyDraft(
  workspaceRoot: string,
  draft: DraftTour,
  onProgress: (progress: GenerationProgressParams) => void
): Promise<VerifiedDraft> {
  onProgress({ phase: "verifying", message: "Verifying anchors", tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0 });
  const errors: string[] = [];
  const steps: TourStep[] = [];
  for (const step of draft.steps) {
    const verifiedStep = await verifyStep(workspaceRoot, step);
    if (typeof verifiedStep === "string") {
      errors.push(verifiedStep);
    } else {
      steps.push(verifiedStep);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, steps };
}

async function verifyStep(workspaceRoot: string, step: DraftStep): Promise<TourStep | string> {
  let fileContent: string;
  try {
    fileContent = await readFile(path.join(workspaceRoot, ...step.anchor.file.split("/")), "utf8");
  } catch {
    return `${step.anchor.file}: file does not exist in the workspace`;
  }
  const verification = verifyAnchor(step.anchor, fileContent);
  if (!verification.ok) {
    return verification.errors.join("; ");
  }
  return {
    title: step.title,
    narration: step.narration,
    anchor: { ...step.anchor, snippetHash: verification.snippetHash },
  };
}

async function saveTour(
  workspaceRoot: string,
  draft: DraftTour,
  steps: TourStep[]
): Promise<GenerateTourResult> {
  const toursDir = path.join(workspaceRoot, ...TOURS_DIR_SEGMENTS);
  await mkdir(toursDir, { recursive: true });

  const id = await uniqueTourId(toursDir, slugify(draft.title));
  const tour: Tour = {
    schemaVersion: 1,
    id,
    title: draft.title,
    summary: draft.summary,
    steps,
  };

  // Final gate: the generated artifact must pass the same validation playback uses.
  const serialized = JSON.stringify(tour, null, 2) + "\n";
  const gate = parseTour(serialized, id);
  if (!gate.ok) {
    throw new GenerationFailedError(`generated tour failed validation: ${gate.errors.join("; ")}`);
  }

  // Atomic write: a half-written tour file can never appear.
  const finalPath = path.join(toursDir, `${id}.tour.json`);
  const tempPath = `${finalPath}.tmp`;
  await writeFile(tempPath, serialized, "utf8");
  await rename(tempPath, finalPath);

  return { tour, savedPath: [...TOURS_DIR_SEGMENTS, `${id}.tour.json`].join("/") };
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "tour";
}

async function uniqueTourId(toursDir: string, baseId: string): Promise<string> {
  let id = baseId;
  let counter = 2;
  while (await exists(path.join(toursDir, `${id}.tour.json`))) {
    id = `${baseId}-${counter}`;
    counter += 1;
  }
  return id;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @made-i-t/hdtw-engine-server build && pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: all server tests pass (10 existing + 6 new = 16).

- [ ] **Step 7: Commit**

```bash
git add src/engine/server/src/tourGenerator.ts src/engine/server/src/fakeTourGenerator.ts src/engine/server/src/generationPipeline.ts src/engine/server/tests/generationPipeline.test.ts
git commit -m "feat(engine-server): add TourGenerator port, fake generator, and generation pipeline"
```

---

### Task 4: Wire generateTour into the protocol server + stdio e2e

**Files:**
- Modify: `src/engine/server/src/main.ts`
- Test: `src/engine/server/tests/generation.e2e.test.ts`

- [ ] **Step 1: Write the failing e2e test — `src/engine/server/tests/generation.e2e.test.ts`**

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import {
  GENERATE_TOUR_METHOD,
  GENERATION_PROGRESS_NOTIFICATION,
  type GenerateTourResult,
  type GenerationProgressParams,
} from "@made-i-t/hdtw-protocol";

const serverEntry = fileURLToPath(new URL("../dist/main.js", import.meta.url));

let serverProcess: ChildProcess | undefined;
let connection: MessageConnection | undefined;
let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "hdtw-e2e-gen-"));
  await writeFile(path.join(workspaceRoot, "README.md"), "fixture readme\n");
});

afterEach(async () => {
  connection?.dispose();
  connection = undefined;
  serverProcess?.kill();
  serverProcess = undefined;
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("generateTour over stdio with the fake generator: progress + saved tour", async () => {
  serverProcess = spawn(process.execPath, [serverEntry], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, HDTW_GENERATOR: "fake" },
  });
  connection = createMessageConnection(
    new StreamMessageReader(serverProcess.stdout!),
    new StreamMessageWriter(serverProcess.stdin!)
  );
  const progress: GenerationProgressParams[] = [];
  connection.onNotification(GENERATION_PROGRESS_NOTIFICATION, (p: GenerationProgressParams) =>
    progress.push(p)
  );
  connection.listen();

  const result = await connection.sendRequest<GenerateTourResult>(GENERATE_TOUR_METHOD, {
    workspaceRoot,
    topic: "how does the readme work",
  });

  expect(result.tour.id).toBe("fake-tour");
  expect(result.savedPath).toBe(".hdtw/tours/fake-tour.tour.json");
  const onDisk = JSON.parse(
    await readFile(path.join(workspaceRoot, result.savedPath), "utf8")
  );
  expect(onDisk.steps[0].anchor.snippetHash).toMatch(/^sha256:/);
  expect(progress.map((p) => p.phase)).toContain("exploring");
  expect(progress.map((p) => p.phase)).toContain("saving");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @made-i-t/hdtw-engine-server build && pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: the new e2e FAILS (method not registered — "Unhandled method hdtw/generateTour" error response). Existing tests pass.

- [ ] **Step 3: Register the method in `src/engine/server/src/main.ts`** — replace the entire file with:

```ts
import {
  createMessageConnection,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
  type CancellationToken,
} from "vscode-jsonrpc/node";
import {
  GENERATE_TOUR_METHOD,
  GENERATION_AUTH_REQUIRED_ERROR_CODE,
  GENERATION_BUDGET_EXCEEDED_ERROR_CODE,
  GENERATION_FAILED_ERROR_CODE,
  GENERATION_PROGRESS_NOTIFICATION,
  GET_TOUR_METHOD,
  LIST_TOURS_METHOD,
  PING_METHOD,
  TOUR_NOT_FOUND_ERROR_CODE,
  type GenerateTourParams,
  type GetTourParams,
  type ListToursParams,
  type PingParams,
} from "@made-i-t/hdtw-protocol";
import { handlePing } from "./pingHandler.js";
import { getTour, listTours, TourNotFoundError } from "./tourHandlers.js";
import { runGeneration } from "./generationPipeline.js";
import { FakeTourGenerator } from "./fakeTourGenerator.js";
import { ClaudeAgentTourGenerator } from "./claudeTourGenerator.js";
import {
  AuthRequiredError,
  BudgetExceededError,
  GenerationCancelledError,
  GenerationFailedError,
  type TourGenerator,
} from "./tourGenerator.js";

// JSON-RPC standard code for a request the client cancelled.
const REQUEST_CANCELLED_ERROR_CODE = -32800;

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout)
);

function createGenerator(): TourGenerator {
  return process.env.HDTW_GENERATOR === "fake"
    ? new FakeTourGenerator()
    : new ClaudeAgentTourGenerator();
}

connection.onRequest(PING_METHOD, (params: PingParams) => handlePing(params));

connection.onRequest(LIST_TOURS_METHOD, (params: ListToursParams) => listTours(params));

connection.onRequest(GET_TOUR_METHOD, async (params: GetTourParams) => {
  try {
    return await getTour(params);
  } catch (error) {
    if (error instanceof TourNotFoundError) {
      throw new ResponseError(TOUR_NOT_FOUND_ERROR_CODE, error.message);
    }
    throw error;
  }
});

connection.onRequest(
  GENERATE_TOUR_METHOD,
  async (params: GenerateTourParams, token: CancellationToken) => {
    const abort = new AbortController();
    const cancelSubscription = token.onCancellationRequested(() => abort.abort());
    try {
      return await runGeneration(
        params,
        createGenerator(),
        (progress) => connection.sendNotification(GENERATION_PROGRESS_NOTIFICATION, progress),
        abort.signal
      );
    } catch (error) {
      if (error instanceof GenerationCancelledError) {
        throw new ResponseError(REQUEST_CANCELLED_ERROR_CODE, "generation cancelled");
      }
      if (error instanceof AuthRequiredError) {
        throw new ResponseError(GENERATION_AUTH_REQUIRED_ERROR_CODE, error.message);
      }
      if (error instanceof BudgetExceededError) {
        throw new ResponseError(GENERATION_BUDGET_EXCEEDED_ERROR_CODE, error.message);
      }
      if (error instanceof GenerationFailedError) {
        throw new ResponseError(GENERATION_FAILED_ERROR_CODE, error.message);
      }
      throw error;
    } finally {
      cancelSubscription.dispose();
    }
  }
);

// Shutdown contract: the server exits when stdin reaches EOF, which doubles
// as orphan cleanup — if the parent client dies, the closed pipe tears us
// down. Keep this property if the transport ever changes.
connection.listen();
```

Note: this imports `ClaudeAgentTourGenerator` which doesn't exist until Task 5. For THIS task, create a minimal stub `src/engine/server/src/claudeTourGenerator.ts` so the build passes (Task 5 replaces it entirely):

```ts
import {
  AuthRequiredError,
  type DraftTour,
  type GenerationHooks,
  type TourGenerator,
} from "./tourGenerator.js";

/** Replaced with the real Agent SDK implementation in the next task. */
export class ClaudeAgentTourGenerator implements TourGenerator {
  async generate(): Promise<DraftTour> {
    throw new AuthRequiredError("Claude agent generator not yet implemented");
  }

  async repair(
    _workspaceRoot: string,
    _topic: string,
    _draft: DraftTour,
    _anchorErrors: string[],
    _hooks: GenerationHooks
  ): Promise<DraftTour> {
    throw new AuthRequiredError("Claude agent generator not yet implemented");
  }
}
```

- [ ] **Step 4: Build and run all server tests**

Run: `pnpm --filter @made-i-t/hdtw-engine-server build && pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: all pass — 10 existing + 6 pipeline + 1 generation e2e = 17.

- [ ] **Step 5: Commit**

```bash
git add src/engine/server
git commit -m "feat(engine-server): register generateTour with progress, cancellation, typed errors"
```

---

### Task 5: ClaudeAgentTourGenerator (real Agent SDK)

**Files:**
- Modify: `src/engine/server/src/claudeTourGenerator.ts` (replace the stub entirely)
- Modify: `src/engine/server/package.json` (SDK dependency)

No automated test for the real SDK path (it spends tokens and needs auth) — verified by build/lint here and the human F5 dogfood in Task 7. The pipeline around it is already proven against the fake.

- [ ] **Step 1: Add the SDK dependency**

Run: `pnpm --filter @made-i-t/hdtw-engine-server add @anthropic-ai/claude-agent-sdk`
Expected: installs the latest SDK into engine-server dependencies.

- [ ] **Step 2: Replace `src/engine/server/src/claudeTourGenerator.ts` entirely with:**

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  AuthRequiredError,
  GenerationCancelledError,
  GenerationFailedError,
  type DraftTour,
  type GenerationHooks,
  type TourGenerator,
} from "./tourGenerator.js";

// Rough mid-flight estimate only; the SDK's final result cost is authoritative.
// Sonnet-class list pricing per million tokens.
const ESTIMATED_USD_PER_INPUT_TOKEN = 3 / 1_000_000;
const ESTIMATED_USD_PER_OUTPUT_TOKEN = 15 / 1_000_000;

const MAX_GENERATE_TURNS = 40;
const MAX_REPAIR_TURNS = 15;

const SYSTEM_PROMPT = `You are a principal engineer creating a guided tour of a codebase for a new team member.

You will be given a topic. Explore the codebase with your tools (Read, Grep, Glob) until you genuinely understand how that topic works, from entrypoint to exit. Then produce a tour: 4 to 8 steps, each anchored to a specific range of lines in a specific file, ordered so a newcomer can follow the flow.

Rules for anchors:
- Before anchoring a step, Read the file and confirm the exact CURRENT line numbers of the code you are anchoring. Line numbers must be 1-based and inclusive.
- Anchor the smallest range that contains the construct you are explaining (a function, a block, a declaration) — typically 3 to 25 lines.
- File paths must be relative to the workspace root, using forward slashes.

Rules for narration:
- 2 to 4 sentences per step, in Markdown.
- Explain WHY the code is the way it is — patterns, architecture, intent — not just what it does. Speak like a senior engineer walking someone through the system.

Your FINAL message must be ONLY a fenced JSON block in exactly this shape, with no other prose:

\`\`\`json
{
  "title": "Short tour title",
  "summary": "One-sentence summary",
  "steps": [
    {
      "title": "Step title",
      "narration": "Markdown narration.",
      "anchor": { "file": "relative/path.ts", "startLine": 10, "endLine": 24 }
    }
  ]
}
\`\`\``;

export class ClaudeAgentTourGenerator implements TourGenerator {
  async generate(
    workspaceRoot: string,
    topic: string,
    model: string | undefined,
    hooks: GenerationHooks
  ): Promise<DraftTour> {
    const prompt = `Create a guided tour for this topic: ${topic}`;
    return this.runQuery(workspaceRoot, prompt, model, MAX_GENERATE_TURNS, "exploring", hooks);
  }

  async repair(
    workspaceRoot: string,
    topic: string,
    draft: DraftTour,
    anchorErrors: string[],
    hooks: GenerationHooks
  ): Promise<DraftTour> {
    const prompt = `You previously drafted this tour for the topic "${topic}":

\`\`\`json
${JSON.stringify(draft, null, 2)}
\`\`\`

These anchors failed verification against the actual files:
${anchorErrors.map((error) => `- ${error}`).join("\n")}

Re-read the affected files, fix ONLY the broken anchors (adjust line ranges or choose a better location), and output the corrected complete tour in the required fenced JSON format.`;
    return this.runQuery(workspaceRoot, prompt, model, MAX_REPAIR_TURNS, "repairing", hooks);
  }

  private async runQuery(
    workspaceRoot: string,
    prompt: string,
    model: string | undefined,
    maxTurns: number,
    phase: "exploring" | "repairing",
    hooks: GenerationHooks
  ): Promise<DraftTour> {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    hooks.signal.addEventListener("abort", onAbort, { once: true });

    let tokensIn = 0;
    let tokensOut = 0;
    let resultText: string | undefined;

    try {
      const response = query({
        prompt,
        options: {
          cwd: workspaceRoot,
          model,
          maxTurns,
          allowedTools: ["Read", "Grep", "Glob"],
          systemPrompt: SYSTEM_PROMPT,
          abortController,
        },
      });

      for await (const message of response) {
        if (message.type === "assistant") {
          const usage = message.message.usage;
          tokensIn += usage?.input_tokens ?? 0;
          tokensOut += usage?.output_tokens ?? 0;
          hooks.onProgress({
            phase,
            message: phase === "exploring" ? "Agent exploring the codebase" : "Agent repairing anchors",
            tokensIn,
            tokensOut,
            estimatedCostUsd:
              tokensIn * ESTIMATED_USD_PER_INPUT_TOKEN + tokensOut * ESTIMATED_USD_PER_OUTPUT_TOKEN,
          });
        }
        if (message.type === "result") {
          if (message.subtype === "success") {
            resultText = message.result;
          } else {
            throw new GenerationFailedError(`agent run ended without a result (${message.subtype})`);
          }
        }
      }
    } catch (error) {
      if (hooks.signal.aborted) {
        throw new GenerationCancelledError("generation aborted");
      }
      if (isAuthError(error)) {
        throw new AuthRequiredError(
          "No Anthropic credentials found. Set an API key (HDTW: Set Anthropic API Key) or log in to Claude Code."
        );
      }
      throw error;
    } finally {
      hooks.signal.removeEventListener("abort", onAbort);
    }

    if (resultText === undefined) {
      throw new GenerationFailedError("agent run produced no final result");
    }
    return parseDraft(resultText);
  }
}

function isAuthError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /api key|authentication|unauthorized|401|not logged in|credential|billing/i.test(text);
}

export function parseDraft(resultText: string): DraftTour {
  const fenced = [...resultText.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1] ?? resultText;
  let raw: unknown;
  try {
    raw = JSON.parse(fenced.trim());
  } catch {
    throw new GenerationFailedError("agent output was not valid JSON in the required format");
  }
  const errors = validateDraft(raw);
  if (errors.length > 0) {
    throw new GenerationFailedError(`agent output failed draft validation: ${errors.join("; ")}`);
  }
  return raw as DraftTour;
}

function validateDraft(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["draft must be a JSON object"];
  }
  const draft = value as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof draft.title !== "string" || draft.title.length === 0) errors.push("title missing");
  if (typeof draft.summary !== "string") errors.push("summary missing");
  if (!Array.isArray(draft.steps) || draft.steps.length === 0 || draft.steps.length > 12) {
    errors.push("steps must be a non-empty array of at most 12");
    return errors;
  }
  draft.steps.forEach((step, index) => {
    if (typeof step !== "object" || step === null) {
      errors.push(`steps[${index}] must be an object`);
      return;
    }
    const candidate = step as Record<string, unknown>;
    if (typeof candidate.title !== "string" || candidate.title.length === 0)
      errors.push(`steps[${index}].title missing`);
    if (typeof candidate.narration !== "string" || candidate.narration.length === 0)
      errors.push(`steps[${index}].narration missing`);
    const anchor = candidate.anchor as Record<string, unknown> | undefined;
    if (
      anchor === undefined ||
      typeof anchor.file !== "string" ||
      !Number.isInteger(anchor.startLine) ||
      !Number.isInteger(anchor.endLine)
    ) {
      errors.push(`steps[${index}].anchor incomplete`);
    }
  });
  return errors;
}
```

**SDK adaptation note:** if the installed SDK's message/option type names differ slightly (e.g. `systemPrompt` vs `customSystemPrompt`, usage field shapes), adapt the field access to the SDK's exported TypeScript types and report the deviation — do NOT loosen the DraftTour contract or skip the abort wiring.

- [ ] **Step 3: Add a unit test for draft parsing only (no SDK calls)** — append to a new file `src/engine/server/src/claudeTourGenerator.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { parseDraft } from "./claudeTourGenerator.js";
import { GenerationFailedError } from "./tourGenerator.js";

const VALID = `Here is the tour:
\`\`\`json
{ "title": "T", "summary": "S", "steps": [ { "title": "s1", "narration": "n", "anchor": { "file": "a.ts", "startLine": 1, "endLine": 2 } } ] }
\`\`\``;

describe("parseDraft", () => {
  test("extracts the last fenced json block", () => {
    const draft = parseDraft(VALID);
    expect(draft.title).toBe("T");
    expect(draft.steps).toHaveLength(1);
  });

  test("rejects non-JSON output", () => {
    expect(() => parseDraft("I could not complete the task")).toThrow(GenerationFailedError);
  });

  test("rejects structurally invalid drafts", () => {
    expect(() => parseDraft('```json\n{"title":"T"}\n```')).toThrow(GenerationFailedError);
  });
});
```

- [ ] **Step 4: Build, test, lint**

Run: `pnpm build && pnpm --filter @made-i-t/hdtw-engine-server test && pnpm lint`
Expected: build clean (SDK types compile), server tests 20 (17 + 3 new), lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/engine/server pnpm-lock.yaml
git commit -m "feat(engine-server): implement Claude Agent SDK tour generator"
```

---

### Task 6: VS Code generation UX — settings, auth command, progress, auto-walk

**Files:**
- Modify: `src/clients/vscode/package.json` (settings, commands, menus)
- Modify: `src/clients/vscode/src/engineClient.ts` (connect env + generateTour)
- Modify: `src/clients/vscode/src/extension.ts` (commands + flow)

- [ ] **Step 1: Manifest additions in `src/clients/vscode/package.json`**

Add to the `"commands"` array (after the existing entries):

```json
      { "command": "hdtw.generateTour", "title": "HDTW: Generate Tour…", "icon": "$(sparkle)" },
      { "command": "hdtw.setApiKey", "title": "HDTW: Set Anthropic API Key" }
```

Add the generate button to the `"view/title"` menu array (BEFORE the refresh entry so it reads generate-then-refresh):

```json
        { "command": "hdtw.generateTour", "when": "view == hdtwTours", "group": "navigation@1" },
```

and change the existing refresh entry's group to `"navigation@2"`.

Add a top-level `"configuration"` key inside `"contributes"`:

```json
    "configuration": {
      "title": "How Does This Work",
      "properties": {
        "hdtw.generation.model": {
          "type": "string",
          "default": "",
          "description": "Model for tour generation. Empty uses the agent SDK default."
        },
        "hdtw.generation.maxBudgetUsd": {
          "type": "number",
          "default": 2,
          "description": "Abort tour generation when the estimated cost exceeds this many USD."
        }
      }
    }
```

- [ ] **Step 2: Extend `src/clients/vscode/src/engineClient.ts`**

Change the imports from `@made-i-t/hdtw-protocol` to also include the generation contract, and import the jsonrpc CancellationTokenSource:

```ts
import {
  CancellationTokenSource,
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import {
  GENERATE_TOUR_METHOD,
  GENERATION_PROGRESS_NOTIFICATION,
  GET_TOUR_METHOD,
  LIST_TOURS_METHOD,
  PING_METHOD,
  PROTOCOL_VERSION,
  type GenerateTourParams,
  type GenerateTourResult,
  type GenerationProgressParams,
  type GetTourParams,
  type GetTourResult,
  type ListToursParams,
  type ListToursResult,
  type PingParams,
  type PingResult,
} from "@made-i-t/hdtw-protocol";
```

Change `connect()`'s signature to accept extra environment (the API key) and use it in the spawn env:

```ts
  async connect(extraEnv: Record<string, string> = {}): Promise<PingResult> {
```

and in the spawn options:

```ts
      env: { ...process.env, ...extraEnv, ELECTRON_RUN_AS_NODE: "1" },
```

Add this method after `getTour` (note: one generation at a time — the extension guards this; the progress handler is connection-global):

```ts
  async generateTour(
    params: GenerateTourParams,
    onProgress: (progress: GenerationProgressParams) => void,
    cancellation: { onCancellationRequested(listener: () => void): { dispose(): void } }
  ): Promise<GenerateTourResult> {
    if (!this.connection) {
      throw new Error("engine not connected");
    }
    const progressSubscription = this.connection.onNotification(
      GENERATION_PROGRESS_NOTIFICATION,
      onProgress
    );
    const source = new CancellationTokenSource();
    const cancelSubscription = cancellation.onCancellationRequested(() => source.cancel());
    try {
      return await this.connection.sendRequest<GenerateTourResult>(
        GENERATE_TOUR_METHOD,
        params,
        source.token
      );
    } finally {
      progressSubscription.dispose();
      cancelSubscription.dispose();
      source.dispose();
    }
  }
```

- [ ] **Step 3: Extend `src/clients/vscode/src/extension.ts`** — replace the entire file with:

```ts
import * as vscode from "vscode";
import {
  GENERATION_AUTH_REQUIRED_ERROR_CODE,
  GENERATION_BUDGET_EXCEEDED_ERROR_CODE,
} from "@made-i-t/hdtw-protocol";
import { EngineClient } from "./engineClient.js";
import { TourTreeProvider } from "./tourTree.js";
import { WalkController } from "./walkController.js";

const API_KEY_SECRET = "hdtw.anthropicApiKey";
const REQUEST_CANCELLED_ERROR_CODE = -32800;

let client: EngineClient | undefined;
let walk: WalkController | undefined;
let tree: TourTreeProvider | undefined;
let generating = false;

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (client) {
    return;
  }
  client = new EngineClient();
  try {
    const apiKey = await context.secrets.get(API_KEY_SECRET);
    const result = await client.connect(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {});
    void vscode.window.showInformationMessage(
      `HDTW engine connected (${result.engineName} v${result.engineVersion}, protocol v${result.protocolVersion})`
    );
  } catch (error) {
    client.dispose();
    client = undefined;
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`HDTW engine failed to start: ${message}`);
    return;
  }

  tree = new TourTreeProvider(client, workspaceRoot);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("hdtwTours", tree),
    vscode.commands.registerCommand("hdtw.refreshTours", () => tree?.refresh()),
    vscode.commands.registerCommand("hdtw.startTour", (tourId: string) => startTour(tourId)),
    vscode.commands.registerCommand("hdtw.tourNext", () => walk?.next()),
    vscode.commands.registerCommand("hdtw.tourPrevious", () => walk?.previous()),
    vscode.commands.registerCommand("hdtw.tourExit", () => walk?.exit()),
    vscode.commands.registerCommand("hdtw.generateTour", () => generateTour()),
    vscode.commands.registerCommand("hdtw.setApiKey", () => setApiKey(context))
  );
}

async function startTour(tourId: string): Promise<void> {
  const root = workspaceRoot();
  if (!root || !client) {
    void vscode.window.showErrorMessage("HDTW: open a folder to walk its tours.");
    return;
  }
  try {
    const { tour } = await client.getTour(root, tourId);
    walk?.dispose();
    walk = new WalkController(root);
    await walk.start(tour);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`HDTW: could not start tour: ${message}`);
  }
}

async function generateTour(): Promise<void> {
  const root = workspaceRoot();
  if (!root || !client) {
    void vscode.window.showErrorMessage("HDTW: open a folder to generate a tour.");
    return;
  }
  if (generating) {
    void vscode.window.showWarningMessage("HDTW: a tour is already being generated.");
    return;
  }
  const topic = await vscode.window.showInputBox({
    title: "Generate Tour",
    prompt: "What should the tour explain?",
    placeHolder: "e.g. How does a tour get from disk to the editor?",
  });
  if (!topic) {
    return;
  }

  const config = vscode.workspace.getConfiguration("hdtw.generation");
  const model = config.get<string>("model", "");
  const maxBudgetUsd = config.get<number>("maxBudgetUsd", 2);

  generating = true;
  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "HDTW: generating tour",
        cancellable: true,
      },
      (progress, token) =>
        client!.generateTour(
          { workspaceRoot: root, topic, model: model || undefined, maxBudgetUsd },
          (update) =>
            progress.report({
              message: `${update.message} (${Math.round((update.tokensIn + update.tokensOut) / 1000)}k tokens · ~$${update.estimatedCostUsd.toFixed(2)})`,
            }),
          token
        )
    );
    tree?.refresh();
    void vscode.window.showInformationMessage(`HDTW: tour saved to ${result.savedPath}`);
    walk?.dispose();
    walk = new WalkController(root);
    await walk.start(result.tour);
  } catch (error) {
    handleGenerationError(error);
  } finally {
    generating = false;
  }
}

function handleGenerationError(error: unknown): void {
  const code = (error as { code?: number }).code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === REQUEST_CANCELLED_ERROR_CODE) {
    return; // user cancelled — silent
  }
  if (code === GENERATION_AUTH_REQUIRED_ERROR_CODE) {
    void vscode.window
      .showErrorMessage(`HDTW: ${message}`, "Set API Key")
      .then((action) => {
        if (action === "Set API Key") {
          void vscode.commands.executeCommand("hdtw.setApiKey");
        }
      });
    return;
  }
  if (code === GENERATION_BUDGET_EXCEEDED_ERROR_CODE) {
    void vscode.window.showErrorMessage(
      `HDTW: ${message} Raise hdtw.generation.maxBudgetUsd to allow more.`
    );
    return;
  }
  void vscode.window.showErrorMessage(`HDTW: tour generation failed: ${message}`);
}

async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  const key = await vscode.window.showInputBox({
    title: "Set Anthropic API Key",
    prompt: "Stored in VS Code SecretStorage; passed to the engine on next start.",
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) {
    return;
  }
  if (key === "") {
    await context.secrets.delete(API_KEY_SECRET);
    void vscode.window.showInformationMessage("HDTW: API key cleared. Reload to apply.");
  } else {
    await context.secrets.store(API_KEY_SECRET, key);
    void vscode.window.showInformationMessage("HDTW: API key saved. Reload to apply.");
  }
  const action = await vscode.window.showInformationMessage(
    "Reload window to restart the engine with the new credentials?",
    "Reload"
  );
  if (action === "Reload") {
    void vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

export function deactivate(): void {
  walk?.dispose();
  walk = undefined;
  client?.dispose();
  client = undefined;
  tree = undefined;
}
```

- [ ] **Step 4: Full verification**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: build clean; tests pass (protocol 3, core 20, server 20, vscode 2 = 45); lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/clients/vscode
git commit -m "feat(vscode): add Generate Tour flow with progress, budget, and API key auth"
```

---

### Task 7: Docs and the human dogfood handoff

**Files:**
- Modify: `docs/product-roadmap.md` (Chunk 2 status)
- Modify: `AGENTS.md` (current state + purity-rule clarification)

- [ ] **Step 1: Update `AGENTS.md`**

In **Working conventions**, change the bullet:

```markdown
- Keep the engine/client/protocol boundaries intact in every change — if a client needs engine data, the answer is a protocol addition, not an import.
```

to:

```markdown
- Keep the engine/client/protocol boundaries intact in every change — if a client needs engine data, the answer is a protocol addition, not an import.
- `engine-core` purity rule, precisely: no filesystem, no transport, no SDK/network. Deterministic computation from `node:` builtins (e.g. `node:crypto` hashing) is allowed.
```

In **Current state**, add after the Chunk 1 bullet:

```markdown
- **Chunk 2 implemented — agent tour generation (pending human F5 dogfood):** the engine embeds the Claude Agent SDK behind a `TourGenerator` port; `hdtw/generateTour` streams progress, enforces a budget, verifies anchors engine-side with one repair round, and writes atomically. VS Code adds "HDTW: Generate Tour…", settings (`hdtw.generation.*`), and "HDTW: Set Anthropic API Key" (SecretStorage; falls back to Claude Code CLI credentials). Test generators: run the engine with `HDTW_GENERATOR=fake`.
```

- [ ] **Step 2: Update `docs/product-roadmap.md`** — change the Chunk 2 heading from `🔄 spec'd, next up` to `✅ shipped 2026-06-12 (F5 dogfood pending)`.

- [ ] **Step 3: Full verification**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: all green (45 tests).

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md docs/product-roadmap.md
git commit -m "docs: mark chunk 2 implemented; clarify engine-core purity rule"
```

- [ ] **Step 5: Human F5 dogfood (cannot be automated — flag in the report)**

1. F5 → Extension Development Host (dogfood workspace).
2. Tours view → sparkle button → topic: "How does a tour get from disk into the editor?"
3. Watch the progress notification show phases + tokens/cost. Expect a 1–3 minute run on your Claude Code subscription auth.
4. On success: the tour saves, the sidebar refreshes, and the walk auto-starts. Walk it; sanity-check the anchors point at real, sensible code.
5. Cancel check: start another generation and hit Cancel — silent stop, no partial file in `.hdtw/tours/`.
6. If the result is good: commit the generated tour as the chunk-2 dogfood artifact and update the roadmap heading to remove "(F5 dogfood pending)".
