# Tour Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A step can carry `relatedTours`; following one in the editor pushes the current walk onto a stack, walks the sub-tour, and auto-returns to the parent step. The generation agent proposes cross-links from the existing tour catalog; the engine drops links it can't resolve.

**Architecture:** Schema-additive `relatedTours` on `TourStep` (no version bump). engine-core validates link _shape_; engine-server fetches the catalog, passes it to the generator, and keeps only catalog-resolvable links during verification (logging drops via the observer). The VS Code client gains a pure `walkStack` module (the branching logic) and a stack-based `WalkController` that renders related-tour command links in the narration thread and a breadcrumb in the status bar. Spec: `docs/superpowers/specs/2026-06-13-tour-graph-design.md`.

**Tech Stack:** existing monorepo stack. New VS Code usage: `MarkdownString.isTrusted` command links.

**Conventions (follow exactly):** `@made-i-t/hdtw-*` scope; `.js` relative imports; engine-core stays pure (no fs/transport/SDK); clients import code only from the protocol package; the engine never trusts agent-proposed data; observability via the injected observer (no bare `console.*`); tests co-located/excluded from build; commands run from repo root.

---

### Task 1: Protocol — `relatedTours` on `TourStep`

**Files:**

- Modify: `src/protocol/src/tours.ts`
- Test: `src/protocol/src/relatedTours.test.ts`

- [ ] **Step 1: Add the types in `src/protocol/src/tours.ts`** — add the `RelatedTour` interface immediately above `TourStep`, and the optional field on `TourStep`. Replace the existing `TourStep` interface:

```ts
export interface TourStep {
  title: string;
  anchor: TourAnchor;
  /** Markdown. */
  narration: string;
}
```

with:

```ts
export interface RelatedTour {
  tourId: string;
  /** Link text shown in the narration thread; falls back to the target tour's title when absent. */
  label?: string;
}

export interface TourStep {
  title: string;
  anchor: TourAnchor;
  /** Markdown. */
  narration: string;
  /** Optional cross-links to other tours, surfaced as buttons in the walk. Schema-additive. */
  relatedTours?: RelatedTour[];
}
```

- [ ] **Step 2: Write the smoke test — `src/protocol/src/relatedTours.test.ts`**

```ts
import { expect, test } from "vitest";
import type { RelatedTour, TourStep } from "./index.js";

test("a step can carry related tours and remains schemaVersion-1 compatible", () => {
  const related: RelatedTour = {
    tourId: "jsonrpc",
    label: "How JSON-RPC works",
  };
  const step: TourStep = {
    title: "s",
    narration: "n",
    anchor: {
      file: "a.ts",
      startLine: 1,
      endLine: 1,
      snippetHash: "sha256:aa",
    },
    relatedTours: [related],
  };
  expect(step.relatedTours?.[0].tourId).toBe("jsonrpc");
  // A step without relatedTours is still valid (additive).
  const bare: TourStep = { title: "s", narration: "n", anchor: step.anchor };
  expect(bare.relatedTours).toBeUndefined();
});
```

- [ ] **Step 3: Run tests and build**

Run: `pnpm --filter @made-i-t/hdtw-protocol test && pnpm --filter @made-i-t/hdtw-protocol build`
Expected: all protocol tests pass (existing + 1 new); build exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/protocol
git commit -m "feat(protocol): add optional relatedTours to TourStep"
```

---

### Task 2: engine-core — validate `relatedTours` shape

**Files:**

- Modify: `src/engine/core/src/tours.ts`
- Test: `src/engine/core/src/tours.test.ts`

- [ ] **Step 1: Write the failing tests** — in `src/engine/core/src/tours.test.ts`, inside the `describe("parseTour", ...)` block (after the existing anchor tests), add:

```ts
test("accepts a step with valid relatedTours", () => {
  const step = {
    title: "Linked",
    anchor: {
      file: "a.ts",
      startLine: 1,
      endLine: 1,
      snippetHash: "sha256:aa",
    },
    narration: "x",
    relatedTours: [{ tourId: "other" }, { tourId: "second", label: "Second" }],
  };
  const result = parseTour(validTourJson({ steps: [step] }), "demo");
  expect(result.ok).toBe(true);
});

test("rejects relatedTours that is not an array", () => {
  const step = {
    title: "Bad",
    anchor: {
      file: "a.ts",
      startLine: 1,
      endLine: 1,
      snippetHash: "sha256:aa",
    },
    narration: "x",
    relatedTours: { tourId: "other" },
  };
  const result = parseTour(validTourJson({ steps: [step] }), "demo");
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.errors).toContain("steps[0].relatedTours must be an array");
});

test("rejects a related entry with a non-string tourId or non-string label", () => {
  const step = {
    title: "Bad",
    anchor: {
      file: "a.ts",
      startLine: 1,
      endLine: 1,
      snippetHash: "sha256:aa",
    },
    narration: "x",
    relatedTours: [{ tourId: "" }, { tourId: "ok", label: 5 }],
  };
  const result = parseTour(validTourJson({ steps: [step] }), "demo");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors).toContain(
      "steps[0].relatedTours[0].tourId must be a non-empty string",
    );
    expect(result.errors).toContain(
      "steps[0].relatedTours[1].label must be a string when present",
    );
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @made-i-t/hdtw-engine-core test`
Expected: the 3 new tests FAIL (relatedTours not yet validated; the "accepts" test passes vacuously today but the rejects fail). Existing tests pass.

- [ ] **Step 3: Add validation in `src/engine/core/src/tours.ts`** — in `validateStep`, after the `errors.push(...validateAnchor(candidate.anchor, label));` line and before `return errors;`, add:

```ts
errors.push(...validateRelatedTours(candidate.relatedTours, label));
```

Then add this new function immediately after `validateStep`:

```ts
function validateRelatedTours(related: unknown, stepLabel: string): string[] {
  if (related === undefined) {
    return [];
  }
  const label = `${stepLabel}.relatedTours`;
  if (!Array.isArray(related)) {
    return [`${label} must be an array`];
  }
  const errors: string[] = [];
  related.forEach((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`${entryLabel} must be an object`);
      return;
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.tourId !== "string" || candidate.tourId.length === 0) {
      errors.push(`${entryLabel}.tourId must be a non-empty string`);
    }
    if (candidate.label !== undefined && typeof candidate.label !== "string") {
      errors.push(`${entryLabel}.label must be a string when present`);
    }
  });
  return errors;
}
```

- [ ] **Step 4: Run tests and build**

Run: `pnpm --filter @made-i-t/hdtw-engine-core test && pnpm --filter @made-i-t/hdtw-engine-core build`
Expected: all pass (21 prior + 3 new = 24); build exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/engine/core
git commit -m "feat(engine-core): validate relatedTours shape in parseTour"
```

---

### Task 3: engine-server — catalog fetch + related-link resolution in the pipeline

**Files:**

- Modify: `src/engine/server/src/tourGenerator.ts` (DraftStep.relatedTours; catalog param on generate/repair)
- Modify: `src/engine/server/src/fakeTourGenerator.ts` (signature; relatedTours pass-through)
- Modify: `src/engine/server/src/generationPipeline.ts` (fetch catalog; resolve links; pass catalog to generator)
- Test: `src/engine/server/tests/generationPipeline.test.ts`

- [ ] **Step 1: Extend the port types in `src/engine/server/src/tourGenerator.ts`**

Add the protocol import for `RelatedTour` and `TourSummary` at the top (there is already a `import type { GenerationProgressParams } from "@made-i-t/hdtw-protocol";` — extend it):

```ts
import type {
  GenerationProgressParams,
  RelatedTour,
  TourSummary,
} from "@made-i-t/hdtw-protocol";
```

Add `relatedTours` to `DraftStep`:

```ts
export interface DraftStep {
  title: string;
  narration: string;
  anchor: DraftAnchor;
  relatedTours?: RelatedTour[];
}
```

Change the `TourGenerator` interface so both methods take `catalog: TourSummary[]` after `model`:

```ts
export interface TourGenerator {
  generate(
    workspaceRoot: string,
    topic: string,
    model: string | undefined,
    catalog: TourSummary[],
    hooks: GenerationHooks,
  ): Promise<DraftTour>;
  /** One repair round: same topic, prior draft, and the anchor errors to fix. */
  repair(
    workspaceRoot: string,
    topic: string,
    model: string | undefined,
    catalog: TourSummary[],
    draft: DraftTour,
    anchorErrors: string[],
    hooks: GenerationHooks,
  ): Promise<DraftTour>;
}
```

- [ ] **Step 2: Update `src/engine/server/src/fakeTourGenerator.ts`** — add the `catalog` parameter (ignored) to both methods. Change `generate`'s signature from `(_workspaceRoot, topic, _model, hooks)` to:

```ts
  async generate(
    _workspaceRoot: string,
    topic: string,
    _model: string | undefined,
    _catalog: import("@made-i-t/hdtw-protocol").TourSummary[],
    hooks: GenerationHooks
  ): Promise<DraftTour> {
```

and `repair`'s signature from `(_workspaceRoot, _topic, _model, _draft, _anchorErrors, hooks)` to:

```ts
  async repair(
    _workspaceRoot: string,
    _topic: string,
    _model: string | undefined,
    _catalog: import("@made-i-t/hdtw-protocol").TourSummary[],
    _draft: DraftTour,
    _anchorErrors: string[],
    hooks: GenerationHooks
  ): Promise<DraftTour> {
```

(The method bodies are unchanged. The inline `import("...")` type keeps the change to one file without touching its import block; if you prefer, add `TourSummary` to the file's existing protocol type import instead.)

- [ ] **Step 3: Write the failing tests — `src/engine/server/tests/generationPipeline.test.ts`**

Add a test inside `describe("runGeneration", ...)`. It pre-creates an existing tour in the workspace so the catalog has one resolvable id, then drafts a step with one resolvable and one ghost related link:

```ts
test("keeps catalog-resolvable related links and drops the rest", async () => {
  await mkdir(path.join(workspaceRoot, ".hdtw", "tours"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, ".hdtw/tours/existing.tour.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "existing",
      title: "Existing",
      summary: "",
      steps: [
        {
          title: "s",
          narration: "n",
          anchor: {
            file: "README.md",
            startLine: 1,
            endLine: 1,
            snippetHash: "sha256:aa",
          },
        },
      ],
    }),
  );
  const draft: DraftTour = {
    title: "Linked tour",
    summary: "has links",
    steps: [
      {
        title: "The readme",
        narration: "x",
        anchor: { file: "README.md", startLine: 1, endLine: 1 },
        relatedTours: [
          { tourId: "existing" },
          { tourId: "ghost", label: "Nope" },
        ],
      },
    ],
  };
  const result = await run(new FakeTourGenerator({ draft }));
  expect(result.tour.steps[0].relatedTours).toEqual([{ tourId: "existing" }]);
  const dropped = observed
    .filter(
      (r) =>
        r.kind === "log"
        && (r as { event: string }).event === "verify.related_dropped",
    )
    .map((r) => (r as { fields?: { tourId?: string } }).fields?.tourId);
  expect(dropped).toContain("ghost");
});
```

(`mkdir`/`writeFile`/`path` are already imported in this test file; `observed` and `run` already exist from the observability task.)

- [ ] **Step 4: Run to verify failure**

Run: `pnpm --filter @made-i-t/hdtw-engine-server build`
Expected: FAIL — the generator signatures changed (TS errors at the pipeline call sites and the missing catalog param), and `verify.related_dropped` isn't emitted yet.

- [ ] **Step 5: Update `src/engine/server/src/generationPipeline.ts`**

Add imports: extend the protocol type import to include `RelatedTour` and `TourSummary`, and import `listTours`:

```ts
import type {
  GenerateTourParams,
  GenerateTourResult,
  GenerationProgressParams,
  RelatedTour,
  Tour,
  TourStep,
  TourSummary,
} from "@made-i-t/hdtw-protocol";
import { listTours } from "./tourHandlers.js";
```

In `runGeneration`, fetch the catalog once near the top of the `try` block (right after the `hooks` object is defined, before the first `generator.generate`):

```ts
const catalogResult = await listTours({ workspaceRoot: params.workspaceRoot });
const catalog: TourSummary[] = catalogResult.tours.filter(
  (tour) => tour.error === undefined,
);
const catalogIds = new Set(catalog.map((tour) => tour.id));
```

Change the `generator.generate(...)` call to pass `catalog`:

```ts
draft = await generator.generate(
  params.workspaceRoot,
  params.topic,
  normalizeModel(params.model),
  catalog,
  hooks,
);
```

Change the `generator.repair(...)` call to pass `catalog` after `normalizeModel(params.model)`:

```ts
draft = await generator.repair(
  params.workspaceRoot,
  params.topic,
  normalizeModel(params.model),
  catalog,
  draft,
  verified.errors,
  hooks,
);
```

Change BOTH `verifyDraft(...)` calls to pass `catalogIds` and `observer`:

```ts
let verified = await verifyDraft(
  params.workspaceRoot,
  draft,
  catalogIds,
  observer,
  onProgress,
);
```

and (in the repair branch):

```ts
verified = await verifyDraft(
  params.workspaceRoot,
  draft,
  catalogIds,
  observer,
  onProgress,
);
```

Change `verifyDraft` to accept `catalogIds` and attach resolved links. Replace the whole `verifyDraft` function with:

```ts
async function verifyDraft(
  workspaceRoot: string,
  draft: DraftTour,
  catalogIds: Set<string>,
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
  for (const draftStep of draft.steps) {
    const verifiedStep = await verifyStep(workspaceRoot, draftStep);
    if (typeof verifiedStep === "string") {
      observer.logger.warn("verify.step", {
        ok: false,
        file: draftStep.anchor.file,
        error: verifiedStep,
      });
      observer.metrics.count("verify.drift");
      errors.push(verifiedStep);
    } else {
      observer.logger.info("verify.step", {
        ok: true,
        title: draftStep.title,
        file: draftStep.anchor.file,
      });
      const related = resolveRelatedTours(
        draftStep.relatedTours,
        catalogIds,
        observer,
      );
      steps.push(
        related.length > 0
          ? { ...verifiedStep, relatedTours: related }
          : verifiedStep,
      );
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, steps };
}

function resolveRelatedTours(
  related: RelatedTour[] | undefined,
  catalogIds: Set<string>,
  observer: Observer,
): RelatedTour[] {
  if (!related) {
    return [];
  }
  const kept: RelatedTour[] = [];
  for (const link of related) {
    if (catalogIds.has(link.tourId)) {
      kept.push(link);
    } else {
      observer.logger.info("verify.related_dropped", { tourId: link.tourId });
    }
  }
  return kept;
}
```

(A self-link to the tour being generated is dropped automatically: the new tour is not yet in the catalog, so its id is not in `catalogIds`.)

- [ ] **Step 6: Run tests and build**

Run: `pnpm --filter @made-i-t/hdtw-engine-server build && pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: all pass (24 prior + 1 new = 25).

- [ ] **Step 7: Commit**

```bash
git add src/engine/server/src/tourGenerator.ts src/engine/server/src/fakeTourGenerator.ts src/engine/server/src/generationPipeline.ts src/engine/server/tests/generationPipeline.test.ts
git commit -m "feat(engine-server): fetch tour catalog and resolve related links during generation"
```

---

### Task 4: engine-server — Claude generator proposes cross-links

**Files:**

- Modify: `src/engine/server/src/claudeTourGenerator.ts`
- Test: `src/engine/server/src/claudeTourGenerator.test.ts`

- [ ] **Step 1: Write the failing tests** — in `src/engine/server/src/claudeTourGenerator.test.ts`, add to the `describe("parseDraft", ...)` block:

```ts
test("accepts a draft with relatedTours on a step", () => {
  const text = `\`\`\`json
{ "title": "T", "summary": "S", "steps": [ { "title": "s1", "narration": "n", "anchor": { "file": "a.ts", "startLine": 1, "endLine": 2 }, "relatedTours": [ { "tourId": "other", "label": "Other" } ] } ] }
\`\`\``;
  const draft = parseDraft(text);
  expect(draft.steps[0].relatedTours).toEqual([
    { tourId: "other", label: "Other" },
  ]);
});

test("rejects relatedTours with a non-string tourId", () => {
  const text = `\`\`\`json
{ "title": "T", "summary": "S", "steps": [ { "title": "s1", "narration": "n", "anchor": { "file": "a.ts", "startLine": 1, "endLine": 2 }, "relatedTours": [ { "tourId": 5 } ] } ] }
\`\`\``;
  expect(() => parseDraft(text)).toThrow();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @made-i-t/hdtw-engine-server build && pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: the "rejects" test FAILS (relatedTours not validated; bad entry passes through). The "accepts" test passes today (the field rides along untyped) — that is fine; it locks behavior. Note: the build also currently fails because Task 4's signatures don't match yet — do Step 3 first if the build blocks the test run.

- [ ] **Step 3: Update `src/engine/server/src/claudeTourGenerator.ts`**

(a) Add the catalog parameter to `generate`/`repair`, threading the catalog into the generate prompt. Change `generate`:

```ts
  async generate(
    workspaceRoot: string,
    topic: string,
    model: string | undefined,
    catalog: import("@made-i-t/hdtw-protocol").TourSummary[],
    hooks: GenerationHooks
  ): Promise<DraftTour> {
    const prompt = `Create a guided tour for this topic: ${topic}${catalogSection(catalog)}`;
    return this.runQuery(workspaceRoot, prompt, model, MAX_GENERATE_TURNS, "exploring", hooks);
  }
```

Change `repair`'s signature to accept (and ignore for prompt purposes) the catalog — insert `catalog` after `model`:

```ts
  async repair(
    workspaceRoot: string,
    topic: string,
    model: string | undefined,
    _catalog: import("@made-i-t/hdtw-protocol").TourSummary[],
    draft: DraftTour,
    anchorErrors: string[],
    hooks: GenerationHooks
  ): Promise<DraftTour> {
```

(The repair body is unchanged.)

(b) Add the catalog-section helper near the bottom of the file (e.g. after `isAuthError`):

```ts
function catalogSection(
  catalog: import("@made-i-t/hdtw-protocol").TourSummary[],
): string {
  if (catalog.length === 0) {
    return "";
  }
  const lines = catalog.map((tour) => `- ${tour.id}: ${tour.title}`).join("\n");
  return `\n\nThe workspace already has these tours. Where a step naturally leads into one of them, you MAY add a "relatedTours" array to that step with the exact id (and an optional label). Only reference ids from this list:\n${lines}`;
}
```

(c) Extend `SYSTEM_PROMPT` so the agent knows the optional field. Replace the final fenced-JSON example block in `SYSTEM_PROMPT` (the one showing the step shape) with one that documents `relatedTours`:

```ts
Your FINAL message must be ONLY a fenced JSON block in exactly this shape, with no other prose. The "relatedTours" array is OPTIONAL and only allowed when the workspace lists tours you may link to:

\`\`\`json
{
  "title": "Short tour title",
  "summary": "One-sentence summary",
  "steps": [
    {
      "title": "Step title",
      "narration": "Markdown narration.",
      "anchor": { "file": "relative/path.ts", "startLine": 10, "endLine": 24 },
      "relatedTours": [{ "tourId": "existing-tour-id", "label": "Optional link text" }]
    }
  ]
}
\`\`\``;
```

(d) Extend `validateDraft` to validate optional `relatedTours`. Inside the `draft.steps.forEach(...)` callback, after the anchor check, add:

```ts
if (candidate.relatedTours !== undefined) {
  if (!Array.isArray(candidate.relatedTours)) {
    errors.push(`steps[${index}].relatedTours must be an array`);
  } else {
    candidate.relatedTours.forEach((link, linkIndex) => {
      const entry = link as Record<string, unknown> | null;
      if (
        typeof entry !== "object"
        || entry === null
        || typeof entry.tourId !== "string"
        || entry.tourId.length === 0
      ) {
        errors.push(
          `steps[${index}].relatedTours[${linkIndex}].tourId must be a non-empty string`,
        );
      }
    });
  }
}
```

- [ ] **Step 4: Build, test, lint**

Run: `pnpm build && pnpm --filter @made-i-t/hdtw-engine-server test && pnpm lint`
Expected: build clean; server tests 27 (25 + 2 new parseDraft); lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/engine/server/src/claudeTourGenerator.ts src/engine/server/src/claudeTourGenerator.test.ts
git commit -m "feat(engine-server): let the agent propose validated related-tour links"
```

---

### Task 5: VS Code — pure `walkStack` module

**Files:**

- Create: `src/clients/vscode/src/walkStack.ts`
- Test: `src/clients/vscode/src/walkStack.test.ts`

- [ ] **Step 1: Write the failing test — `src/clients/vscode/src/walkStack.test.ts`**

```ts
import { describe, expect, test } from "vitest";
import type { Tour } from "@made-i-t/hdtw-protocol";
import { startWalk } from "./walkState.js";
import {
  activeWalk,
  advance,
  breadcrumbLabel,
  pushWalk,
  retreat,
} from "./walkStack.js";

function tour(id: string, steps: number): Tour {
  return {
    schemaVersion: 1,
    id,
    title: id.toUpperCase(),
    summary: "",
    steps: Array.from({ length: steps }, (_unused, index) => ({
      title: `${id}-${index}`,
      narration: "n",
      anchor: {
        file: "a.ts",
        startLine: 1,
        endLine: 1,
        snippetHash: "sha256:aa",
      },
    })),
  };
}

describe("walkStack", () => {
  test("activeWalk is the top of stack", () => {
    const stack = [startWalk(tour("root", 3))];
    expect(activeWalk(stack).tour.id).toBe("root");
  });

  test("advance moves within the active walk", () => {
    let stack = [startWalk(tour("root", 3))];
    stack = advance(stack);
    expect(activeWalk(stack).stepIndex).toBe(1);
  });

  test("advance past a sub-tour's last step pops to the parent at its branch step", () => {
    let stack = [{ tour: tour("root", 3), stepIndex: 2 }];
    stack = pushWalk(stack, tour("sub", 2));
    stack = advance(stack); // sub 0 -> 1
    expect(activeWalk(stack).stepIndex).toBe(1);
    stack = advance(stack); // sub last -> pop to root
    expect(activeWalk(stack).tour.id).toBe("root");
    expect(activeWalk(stack).stepIndex).toBe(2);
  });

  test("retreat before a sub-tour's first step pops to the parent", () => {
    let stack = [{ tour: tour("root", 3), stepIndex: 1 }];
    stack = pushWalk(stack, tour("sub", 2));
    stack = retreat(stack); // sub at 0 -> pop to root
    expect(activeWalk(stack).tour.id).toBe("root");
    expect(activeWalk(stack).stepIndex).toBe(1);
  });

  test("advance at the root's last step is a no-op", () => {
    const stack = [{ tour: tour("root", 2), stepIndex: 1 }];
    expect(advance(stack)).toBe(stack);
  });

  test("breadcrumbLabel joins tour titles with the separator", () => {
    let stack = [startWalk(tour("root", 2))];
    stack = pushWalk(stack, tour("sub", 2));
    expect(breadcrumbLabel(stack)).toBe("ROOT › SUB");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter hdtw-vscode test`
Expected: FAIL — cannot find module `./walkStack.js`.

- [ ] **Step 3: Write `src/clients/vscode/src/walkStack.ts`** (pure — NO `vscode` imports)

```ts
import type { Tour } from "@made-i-t/hdtw-protocol";
import {
  hasNext,
  hasPrevious,
  nextStep,
  previousStep,
  startWalk,
  type WalkState,
} from "./walkState.js";

/** A non-empty stack of walks; the top is the active one. Following a related tour pushes; reaching a sub-tour's boundary pops. */
export type WalkStack = WalkState[];

export function activeWalk(stack: WalkStack): WalkState {
  return stack[stack.length - 1];
}

export function pushWalk(stack: WalkStack, tour: Tour): WalkStack {
  return [...stack, startWalk(tour)];
}

export function advance(stack: WalkStack): WalkStack {
  const active = activeWalk(stack);
  if (hasNext(active)) {
    return [...stack.slice(0, -1), nextStep(active)];
  }
  if (stack.length > 1) {
    return stack.slice(0, -1);
  }
  return stack;
}

export function retreat(stack: WalkStack): WalkStack {
  const active = activeWalk(stack);
  if (hasPrevious(active)) {
    return [...stack.slice(0, -1), previousStep(active)];
  }
  if (stack.length > 1) {
    return stack.slice(0, -1);
  }
  return stack;
}

export function breadcrumbLabel(stack: WalkStack): string {
  return stack.map((walk) => walk.tour.title).join(" › ");
}
```

- [ ] **Step 4: Run tests and build**

Run: `pnpm --filter hdtw-vscode test && pnpm --filter hdtw-vscode build`
Expected: tests pass (6 prior + 6 new = 12); build exit 0; no `walkStack.test.*` in dist.

- [ ] **Step 5: Commit**

```bash
git add src/clients/vscode/src/walkStack.ts src/clients/vscode/src/walkStack.test.ts
git commit -m "feat(vscode): add pure walk-stack module"
```

---

### Task 6: VS Code — stack-based WalkController, related links, breadcrumb, follow command

**Files:**

- Modify: `src/clients/vscode/src/walkController.ts`
- Modify: `src/clients/vscode/package.json` (command)
- Modify: `src/clients/vscode/src/extension.ts` (followRelated command, tourTitles, controller construction)

- [ ] **Step 1: Rewrite `src/clients/vscode/src/walkController.ts`** — replace the entire file with the stack-based version:

```ts
import path from "node:path";
import * as vscode from "vscode";
import type { Tour } from "@made-i-t/hdtw-protocol";
import { currentStep, progressLabel, startWalk } from "./walkState.js";
import {
  activeWalk,
  advance,
  breadcrumbLabel,
  pushWalk,
  retreat,
  type WalkStack,
} from "./walkStack.js";

export class WalkController implements vscode.Disposable {
  private stack: WalkStack = [];
  private readonly commentController: vscode.CommentController;
  private thread: vscode.CommentThread | undefined;
  private readonly decoration: vscode.TextEditorDecorationType;
  private readonly statusBarItem: vscode.StatusBarItem;
  private decoratedEditor: vscode.TextEditor | undefined;

  constructor(
    private readonly workspaceRoot: string,
    /** Returns the title of a tour id known to the workspace, or undefined when it does not exist. */
    private readonly lookupTourTitle: (tourId: string) => string | undefined,
  ) {
    this.commentController = vscode.comments.createCommentController(
      "hdtw-tour",
      "HDTW Tour Guide",
    );
    this.decoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor(
        "editor.findMatchHighlightBackground",
      ),
    });
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
    );
  }

  async start(tour: Tour): Promise<void> {
    this.stack = [startWalk(tour)];
    await this.renderCurrentStep();
  }

  /** Follow a related tour: push it onto the stack and walk it. */
  async pushTour(tour: Tour): Promise<void> {
    if (this.stack.length === 0) {
      this.stack = [startWalk(tour)];
    } else {
      this.stack = pushWalk(this.stack, tour);
    }
    await this.renderCurrentStep();
  }

  async next(): Promise<void> {
    if (this.stack.length === 0) {
      return;
    }
    this.stack = advance(this.stack);
    await this.renderCurrentStep();
  }

  async previous(): Promise<void> {
    if (this.stack.length === 0) {
      return;
    }
    this.stack = retreat(this.stack);
    await this.renderCurrentStep();
  }

  exit(): void {
    this.stack = [];
    this.clearStepArtifacts();
    this.statusBarItem.hide();
  }

  dispose(): void {
    this.exit();
    this.commentController.dispose();
    this.decoration.dispose();
    this.statusBarItem.dispose();
  }

  private async renderCurrentStep(): Promise<void> {
    if (this.stack.length === 0) {
      return;
    }
    this.clearStepArtifacts();
    const active = activeWalk(this.stack);
    const step = currentStep(active);
    const fileUri = vscode.Uri.file(
      path.join(this.workspaceRoot, ...step.anchor.file.split("/")),
    );

    let document: vscode.TextDocument | undefined;
    try {
      document = await vscode.workspace.openTextDocument(fileUri);
    } catch {
      document = undefined;
    }

    if (!document) {
      void vscode.window.showWarningMessage(
        `HDTW step "${step.title}": anchor file ${step.anchor.file} is missing — code may have changed since this tour was authored.`,
      );
      this.updateStatusBar();
      return;
    }

    const drifted = step.anchor.endLine > document.lineCount;
    const startLine = Math.min(step.anchor.startLine, document.lineCount) - 1;
    const endLine = Math.min(step.anchor.endLine, document.lineCount) - 1;
    const range = new vscode.Range(
      startLine,
      0,
      endLine,
      document.lineAt(endLine).text.length,
    );

    const editor = await vscode.window.showTextDocument(document, {
      preserveFocus: false,
    });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

    if (!drifted) {
      editor.setDecorations(this.decoration, [range]);
      this.decoratedEditor = editor;
    }

    const body =
      (drifted
        ? "⚠️ _This step's anchor has drifted — code may have changed since authoring._\n\n"
        : "")
      + step.narration
      + this.relatedSection(step.relatedTours);
    const narration = new vscode.MarkdownString(body);
    narration.isTrusted = { enabledCommands: ["hdtw.followRelated"] };
    const comments: vscode.Comment[] = [
      {
        body: narration,
        mode: vscode.CommentMode.Preview,
        author: {
          name: `🧭 HDTW Guide — ${step.title} (${progressLabel(active)})`,
        },
      },
    ];
    this.thread = this.commentController.createCommentThread(
      fileUri,
      range,
      comments,
    );
    this.thread.collapsibleState =
      vscode.CommentThreadCollapsibleState.Expanded;
    this.thread.canReply = false;
    this.thread.label = breadcrumbLabel(this.stack);

    this.updateStatusBar();
  }

  private relatedSection(
    related: Tour["steps"][number]["relatedTours"],
  ): string {
    if (!related || related.length === 0) {
      return "";
    }
    const lines = related.map((link) => {
      const title = this.lookupTourTitle(link.tourId);
      const text = link.label ?? title ?? link.tourId;
      if (title === undefined) {
        return `- 🚫 ${text} _(tour not found)_`;
      }
      const args = encodeURIComponent(JSON.stringify([link.tourId]));
      return `- [🧭 ${text}](command:hdtw.followRelated?${args})`;
    });
    return `\n\n**Related tours**\n\n${lines.join("\n")}`;
  }

  private updateStatusBar(): void {
    if (this.stack.length === 0) {
      return;
    }
    this.statusBarItem.text = `🧠 ${breadcrumbLabel(this.stack)} · ${progressLabel(activeWalk(this.stack))}`;
    this.statusBarItem.show();
  }

  private clearStepArtifacts(): void {
    this.thread?.dispose();
    this.thread = undefined;
    this.decoratedEditor?.setDecorations(this.decoration, []);
    this.decoratedEditor = undefined;
  }
}
```

- [ ] **Step 2: Manifest — add the command in `src/clients/vscode/package.json`** — in the `contributes.commands` array, after `hdtw.tourExit`, add:

```json
{ "command": "hdtw.followRelated", "title": "HDTW: Follow Related Tour" }
```

- [ ] **Step 3: Wire `src/clients/vscode/src/extension.ts`**

The `WalkController` constructor now needs `(workspaceRoot, lookupTourTitle)`. Build a tour-title lookup from a `listTours` snapshot taken when a walk begins, and register the follow command. Make these changes:

(a) Add module state near the others:

```ts
let tourTitles = new Map<string, string>();
```

(b) Add a helper to refresh the snapshot (near `workspaceRoot()`):

```ts
async function refreshTourTitles(root: string): Promise<void> {
  if (!client) {
    return;
  }
  try {
    const { tours } = await client.listTours(root);
    tourTitles = new Map(
      tours.filter((tour) => tour.error === undefined)
           .map((tour) => [tour.id, tour.title]),
    );
  } catch {
    // Leave the previous snapshot in place.
  }
}
```

(c) In `startTour`, after fetching the tour and before constructing the controller, refresh titles and pass the lookup. Replace the body of the `try` in `startTour`:

```ts
try {
  const { tour } = await client.getTour(root, tourId);
  observer?.logger.info("tour.started", { tourId });
  await refreshTourTitles(root);
  walk?.dispose();
  walk = new WalkController(root, (id) => tourTitles.get(id));
  await walk.start(tour);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  void vscode.window.showErrorMessage(`HDTW: could not start tour: ${message}`);
}
```

(d) In `generateTour`, where it auto-walks the result (`walk = new WalkController(root); await walk.start(result.tour);`), refresh titles and pass the lookup:

```ts
await refreshTourTitles(root);
walk?.dispose();
walk = new WalkController(root, (id) => tourTitles.get(id));
await walk.start(result.tour);
```

(e) Register the follow command — in the `context.subscriptions.push(...)` block where the other `hdtw.*` commands are registered, add:

```ts
    vscode.commands.registerCommand("hdtw.followRelated", (tourId: string) => followRelated(tourId)),
```

(f) Add the `followRelated` function (near `startTour`):

```ts
async function followRelated(tourId: string): Promise<void> {
  const root = workspaceRoot();
  if (!root || !client || !walk) {
    return;
  }
  try {
    const { tour } = await client.getTour(root, tourId);
    observer?.logger.info("tour.followed", { tourId });
    await walk.pushTour(tour);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(
      `HDTW: could not open related tour "${tourId}": ${message}`,
    );
  }
}
```

- [ ] **Step 4: Full verification**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: build clean; tests pass (protocol +1, core +3, server +3, vscode +6 over the pre-chunk baseline — total 80); lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/clients/vscode
git commit -m "feat(vscode): walk-stack controller with related-tour links and breadcrumb"
```

---

### Task 7: Dogfood second tour + cross-link + docs

**Files:**

- Create: `.hdtw/tours/anchor-verification.tour.json`
- Modify: `.hdtw/tours/monorepo-architecture.tour.json` (add a related link)
- Modify: `docs/product-roadmap.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Author a second tour — `.hdtw/tours/anchor-verification.tour.json`**

A 2-step tour about how the engine verifies anchors. Compute hashes with the same helper as Chunk 1 (sha256 over the anchored lines joined with `\n`):

```bash
hash_lines() { node -e '
const fs=require("fs"),crypto=require("crypto");
const [file,start,end]=process.argv.slice(1);
const text=fs.readFileSync(file,"utf8").split(/\r?\n/).slice(Number(start)-1,Number(end)).join("\n");
console.log("sha256:"+crypto.createHash("sha256").update(text).digest("hex"));
' "$1" "$2" "$3"; }
```

Steps (locate exact lines with `grep -n`, anchor the named construct, compute the hash, and fill real `startLine`/`endLine`/`snippetHash` — no `0`/`FILL` may survive):

1. **"Hashing the snippet"** — `src/engine/core/src/anchors.ts`: the `computeSnippetHash` function. Narration: `Every anchor stores a sha256 of the exact lines it points at, computed here. This is what lets a later chunk detect when code has drifted out from under a tour — the hash recorded at authoring time no longer matches the file.`
2. **"Verifying against the file"** — `src/engine/core/src/anchors.ts`: the `verifyAnchor` function. Narration: `The engine never trusts an anchor's line range — it independently checks the range against the real file and recomputes the hash. The agent proposes; the engine verifies. That is the core trust rule of generation.`

Assemble:

```json
{
  "schemaVersion": 1,
  "id": "anchor-verification",
  "title": "How anchors are verified",
  "summary": "How the engine hashes and verifies tour anchors",
  "steps": [
    {
      "title": "Hashing the snippet",
      "anchor": {
        "file": "src/engine/core/src/anchors.ts",
        "startLine": 0,
        "endLine": 0,
        "snippetHash": "sha256:FILL"
      },
      "narration": "Every anchor stores a sha256 of the exact lines it points at, computed here. This is what lets a later chunk detect when code has drifted out from under a tour — the hash recorded at authoring time no longer matches the file."
    },
    {
      "title": "Verifying against the file",
      "anchor": {
        "file": "src/engine/core/src/anchors.ts",
        "startLine": 0,
        "endLine": 0,
        "snippetHash": "sha256:FILL"
      },
      "narration": "The engine never trusts an anchor's line range — it independently checks the range against the real file and recomputes the hash. The agent proposes; the engine verifies. That is the core trust rule of generation."
    }
  ]
}
```

Replace every `0`/`FILL` with real located values.

- [ ] **Step 2: Add a cross-link in `.hdtw/tours/monorepo-architecture.tour.json`** — find the step titled **"The process boundary"** and add a `relatedTours` field to it (it currently has `title`, `anchor`, `narration`):

```json
      "relatedTours": [
        { "tourId": "anchor-verification", "label": "How tour anchors are verified" }
      ]
```

(Insert it as a sibling of `narration` in that step object, with correct JSON commas.)

- [ ] **Step 3: Validate both tours with the engine**

```bash
pnpm --filter @made-i-t/hdtw-engine-core build
node -e '
const { parseTour } = require("./src/engine/core/dist/index.js");
const fs = require("fs");
for (const id of ["anchor-verification", "monorepo-architecture"]) {
  const text = fs.readFileSync(`.hdtw/tours/${id}.tour.json`, "utf8");
  const result = parseTour(text, id);
  if (!result.ok) { console.error(id, result.errors); process.exit(1); }
  console.log(`${id}: valid, ${result.tour.steps.length} steps`);
}
'
```

Expected: both valid. Also re-verify the two `anchor-verification` hashes by re-running `hash_lines` for each anchor and confirming they match what you wrote; `sed -n '<start>,<end>p' src/engine/core/src/anchors.ts` must show the expected function.

- [ ] **Step 4: Update docs**

In `docs/product-roadmap.md`: the "Candidate chunk — Tour graph…" section is being delivered now. Change its heading from `### Candidate chunk — Tour graph: related-tour links + walk stack ⬜ idea (2026-06-12)` to `### Tour Graph — related-tour links + walk stack ✅ shipped 2026-06-13` and add a spec link line under it: `Spec: \`docs/superpowers/specs/2026-06-13-tour-graph-design.md\``. Update the table's last row to note agent cross-linking shipped. Remove the trailing "Sequencing note:" line (it described it as a future pairing).

In `AGENTS.md` **Current state**, add after the Chunk 2.5 bullet:

```markdown
- **Tour graph shipped — branching:** a `TourStep` may carry `relatedTours` (`{tourId,label?}`, schema-additive). The VS Code walk is a stack: following a related-tour link (rendered in the narration thread) pushes a sub-tour and auto-returns to the parent step; the status bar shows a `root › sub` breadcrumb. The generation agent receives the tour catalog and may propose links; the engine keeps only catalog-resolvable ones (`verify.related_dropped`). Pure stack logic: `src/clients/vscode/src/walkStack.ts`.
```

- [ ] **Step 5: Full verification and commit**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: all green (80 tests).

```bash
git add .hdtw docs/product-roadmap.md AGENTS.md
git commit -m "feat: dogfood related-tour link; mark tour graph shipped"
```

- [ ] **Step 6: Human F5 dogfood (flag in report — cannot be automated)**

1. F5 → open the repo in the Extension Dev Host.
2. Walk **Monorepo architecture** to the "process boundary" step → the narration thread shows a **"Related tours"** link.
3. Click it → the **anchor-verification** sub-tour opens; status bar shows `🧠 Monorepo architecture › How anchors are verified · 1/2`.
4. `Next` to the sub-tour's end → auto-returns to the parent at the process-boundary step.
5. (Agent) Generate a new tour on a topic adjacent to an existing one and confirm it may add a valid related link (or that bogus links are dropped — check the HDTW output channel for `verify.related_dropped`).
