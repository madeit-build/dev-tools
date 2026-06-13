# Anchor Drift Detection + Re-anchor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On loading a tour, the engine recomputes each step's `snippetHash` and reports `fresh`/`drifted`/`out-of-range`/`file-missing`; the walk badges drifted steps and offers a deterministic hash-window re-anchor that atomically rewrites a verbatim-moved step's range+hash.

**Architecture:** engine-core gains pure `checkAnchorFreshness` + `findReanchor` (hash-window search — re-anchoring matches the stored hash, no snippet text needed). The protocol gains `hdtw/checkTourDrift` and `hdtw/reanchorStep`; engine-server implements them (reading repo files with the existing workspace-escape guard, atomic rewrite for re-anchor). The VS Code client checks drift on walk start, badges steps, renders a trusted-scoped "Re-anchor this step" command link, and shows on-demand `⚠ N drifted` in the sidebar. Spec: `docs/superpowers/specs/2026-06-13-drift-detection-design.md`.

**Tech Stack:** existing monorepo stack.

**Conventions:** `@made-i-t/hdtw-*` scope; `.js` relative imports; engine-core pure (`node:crypto` allowed, NO fs); clients import code only from the protocol package; engine never trusts agent data; observability via the injected observer (no bare `console.*`); trusted-markdown command links scoped to named commands; tests co-located/excluded from build; commands run from repo root.

---

### Task 1: engine-core — `checkAnchorFreshness` + `findReanchor`

**Files:**
- Modify: `src/engine/core/src/anchors.ts`
- Test: `src/engine/core/src/drift.test.ts`

- [ ] **Step 1: Write the failing test — `src/engine/core/src/drift.test.ts`**

```ts
import { describe, expect, test } from "vitest";
import { computeSnippetHash, checkAnchorFreshness, findReanchor } from "./anchors.js";

const file = "alpha\nbeta\ngamma\ndelta\nepsilon";
// "beta\ngamma" is lines 2-3
const hash23 = computeSnippetHash("beta\ngamma");

function anchor(startLine: number, endLine: number, snippetHash: string) {
  return { file: "f.ts", startLine, endLine, snippetHash };
}

describe("checkAnchorFreshness", () => {
  test("fresh when the recomputed hash matches", () => {
    expect(checkAnchorFreshness(anchor(2, 3, hash23), file)).toBe("fresh");
  });

  test("drifted when the hash no longer matches the range", () => {
    expect(checkAnchorFreshness(anchor(1, 2, hash23), file)).toBe("drifted");
  });

  test("out-of-range when endLine exceeds the file", () => {
    expect(checkAnchorFreshness(anchor(4, 99, hash23), file)).toBe("out-of-range");
  });
});

describe("findReanchor", () => {
  test("relocates verbatim-moved code to its new range", () => {
    const moved = "pad\npad\nbeta\ngamma\ntail";
    const result = findReanchor(anchor(2, 3, hash23), moved);
    expect(result).toEqual({ outcome: "reanchored", startLine: 3, endLine: 4, snippetHash: hash23 });
  });

  test("not-found when the code changed", () => {
    const changed = "alpha\nBETA\nGAMMA\ndelta";
    expect(findReanchor(anchor(2, 3, hash23), changed)).toEqual({ outcome: "not-found" });
  });

  test("not-found when the file is shorter than the window", () => {
    expect(findReanchor(anchor(2, 3, hash23), "only-one-line")).toEqual({ outcome: "not-found" });
  });

  test("ambiguous when more than one window matches", () => {
    const dup = "beta\ngamma\nx\nbeta\ngamma";
    expect(findReanchor(anchor(2, 3, hash23), dup)).toEqual({ outcome: "ambiguous" });
  });

  test("reanchors unchanged code to the same range", () => {
    const result = findReanchor(anchor(2, 3, hash23), file);
    expect(result).toEqual({ outcome: "reanchored", startLine: 2, endLine: 3, snippetHash: hash23 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @made-i-t/hdtw-engine-core test`
Expected: FAIL — `checkAnchorFreshness`/`findReanchor` are not exported.

- [ ] **Step 3: Append to `src/engine/core/src/anchors.ts`** (after `verifyAnchor`):

```ts
export type AnchorFreshness = "fresh" | "drifted" | "out-of-range";

/** Recompute the anchored snippet's hash and compare to the stored one. Assumes a valid anchor range (parseTour gates that). */
export function checkAnchorFreshness(
  anchor: AnchorRange & { snippetHash: string },
  fileContent: string
): AnchorFreshness {
  const lineCount = fileContent.split(/\r?\n/).length;
  if (anchor.endLine > lineCount) {
    return "out-of-range";
  }
  const current = computeSnippetHash(
    extractAnchoredText(fileContent, anchor.startLine, anchor.endLine)
  );
  return current === anchor.snippetHash ? "fresh" : "drifted";
}

export type ReanchorResult =
  | { outcome: "reanchored"; startLine: number; endLine: number; snippetHash: string }
  | { outcome: "not-found" }
  | { outcome: "ambiguous" };

/** Search the file for the window (of the anchor's original length) whose hash equals the stored hash. */
export function findReanchor(
  anchor: AnchorRange & { snippetHash: string },
  fileContent: string
): ReanchorResult {
  const lines = fileContent.split(/\r?\n/);
  const windowLength = anchor.endLine - anchor.startLine + 1;
  if (windowLength < 1 || windowLength > lines.length) {
    return { outcome: "not-found" };
  }
  const matches: { startLine: number; endLine: number }[] = [];
  for (let start = 1; start + windowLength - 1 <= lines.length; start += 1) {
    const end = start + windowLength - 1;
    if (computeSnippetHash(lines.slice(start - 1, end).join("\n")) === anchor.snippetHash) {
      matches.push({ startLine: start, endLine: end });
    }
  }
  if (matches.length === 0) {
    return { outcome: "not-found" };
  }
  if (matches.length > 1) {
    return { outcome: "ambiguous" };
  }
  return {
    outcome: "reanchored",
    startLine: matches[0].startLine,
    endLine: matches[0].endLine,
    snippetHash: anchor.snippetHash,
  };
}
```

- [ ] **Step 4: Run tests and build**

Run: `pnpm --filter @made-i-t/hdtw-engine-core test && pnpm --filter @made-i-t/hdtw-engine-core build`
Expected: all pass (24 prior + 9 new = 33); build exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/engine/core
git commit -m "feat(engine-core): add anchor freshness check and hash-window re-anchor"
```

---

### Task 2: protocol — drift methods + types

**Files:**
- Create: `src/protocol/src/drift.ts`
- Modify: `src/protocol/src/index.ts`
- Test: `src/protocol/src/drift.test.ts`

- [ ] **Step 1: Write the failing test — `src/protocol/src/drift.test.ts`**

```ts
import { expect, test } from "vitest";
import { CHECK_TOUR_DRIFT_METHOD, REANCHOR_STEP_METHOD } from "./index.js";

test("drift protocol method names are stable", () => {
  expect(CHECK_TOUR_DRIFT_METHOD).toBe("hdtw/checkTourDrift");
  expect(REANCHOR_STEP_METHOD).toBe("hdtw/reanchorStep");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @made-i-t/hdtw-protocol test`
Expected: FAIL — constants not exported.

- [ ] **Step 3: Write `src/protocol/src/drift.ts`**

```ts
import type { TourAnchor } from "./tours.js";

/** JSON-RPC method: client→engine, recompute per-step anchor freshness for a tour. */
export const CHECK_TOUR_DRIFT_METHOD = "hdtw/checkTourDrift";

/** JSON-RPC method: client→engine, re-anchor one drifted step (atomic rewrite of the tour file). */
export const REANCHOR_STEP_METHOD = "hdtw/reanchorStep";

export type StepDriftState = "fresh" | "drifted" | "out-of-range" | "file-missing";

export interface StepDriftStatus {
  index: number;
  status: StepDriftState;
}

export interface CheckTourDriftParams {
  workspaceRoot: string;
  tourId: string;
}

export interface CheckTourDriftResult {
  statuses: StepDriftStatus[];
}

export type ReanchorOutcome = "reanchored" | "not-found" | "ambiguous" | "file-missing";

export interface ReanchorStepParams {
  workspaceRoot: string;
  tourId: string;
  stepIndex: number;
}

export interface ReanchorStepResult {
  outcome: ReanchorOutcome;
  /** Present only when outcome is "reanchored". */
  anchor?: TourAnchor;
}
```

- [ ] **Step 4: Re-export — append to `src/protocol/src/index.ts`:**

```ts
export * from "./drift.js";
```

- [ ] **Step 5: Run tests and build**

Run: `pnpm --filter @made-i-t/hdtw-protocol test && pnpm --filter @made-i-t/hdtw-protocol build`
Expected: all pass; build exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/protocol
git commit -m "feat(protocol): add checkTourDrift and reanchorStep methods"
```

---

### Task 3: engine-server — `checkTourDrift` handler + register + e2e

**Files:**
- Create: `src/engine/server/src/driftHandlers.ts`
- Modify: `src/engine/server/src/main.ts`
- Test: `src/engine/server/tests/drift.e2e.test.ts`

- [ ] **Step 1: Write `src/engine/server/src/driftHandlers.ts`** (checkTourDrift now; reanchorStep added in Task 4)

```ts
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkAnchorFreshness, findReanchor } from "@made-i-t/hdtw-engine-core";
import type {
  CheckTourDriftParams,
  CheckTourDriftResult,
  ReanchorStepParams,
  ReanchorStepResult,
  StepDriftStatus,
} from "@made-i-t/hdtw-protocol";
import { getTour, TourNotFoundError } from "./tourHandlers.js";

/** Read an anchored file, confined to the workspace; undefined when missing or escaping. */
async function readAnchoredFile(workspaceRoot: string, file: string): Promise<string | undefined> {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolved = path.resolve(resolvedRoot, ...file.split("/"));
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    return undefined;
  }
  try {
    return await readFile(resolved, "utf8");
  } catch {
    return undefined;
  }
}

export async function checkTourDrift(params: CheckTourDriftParams): Promise<CheckTourDriftResult> {
  const { tour } = await getTour({ workspaceRoot: params.workspaceRoot, tourId: params.tourId });
  const statuses: StepDriftStatus[] = [];
  for (let index = 0; index < tour.steps.length; index += 1) {
    const step = tour.steps[index];
    const content = await readAnchoredFile(params.workspaceRoot, step.anchor.file);
    statuses.push({
      index,
      status: content === undefined ? "file-missing" : checkAnchorFreshness(step.anchor, content),
    });
  }
  return { statuses };
}

const TOUR_FILE_SUFFIX = ".tour.json";
const SAFE_TOUR_ID = /^[\w.-]+$/;

export async function reanchorStep(params: ReanchorStepParams): Promise<ReanchorStepResult> {
  const { tour } = await getTour({ workspaceRoot: params.workspaceRoot, tourId: params.tourId });
  const step = tour.steps[params.stepIndex];
  if (!step) {
    throw new TourNotFoundError(`tour "${params.tourId}" has no step ${params.stepIndex}`);
  }
  const content = await readAnchoredFile(params.workspaceRoot, step.anchor.file);
  if (content === undefined) {
    return { outcome: "file-missing" };
  }
  const result = findReanchor(step.anchor, content);
  if (result.outcome !== "reanchored") {
    return { outcome: result.outcome };
  }
  const newAnchor = {
    ...step.anchor,
    startLine: result.startLine,
    endLine: result.endLine,
    snippetHash: result.snippetHash,
  };
  tour.steps[params.stepIndex] = { ...step, anchor: newAnchor };

  if (!SAFE_TOUR_ID.test(params.tourId) || params.tourId.includes("..")) {
    throw new TourNotFoundError(`no tour with id "${params.tourId}"`);
  }
  const finalPath = path.join(
    params.workspaceRoot,
    ".hdtw",
    "tours",
    `${params.tourId}${TOUR_FILE_SUFFIX}`
  );
  const tempPath = `${finalPath}.tmp`;
  await writeFile(tempPath, JSON.stringify(tour, null, 2) + "\n", "utf8");
  await rename(tempPath, finalPath);
  return { outcome: "reanchored", anchor: newAnchor };
}
```

(Both handlers are written now; Task 4 only registers `reanchorStep` and adds its e2e. `reanchorStep` is exported but unused until Task 4 — that is fine.)

- [ ] **Step 2: Write the failing e2e — `src/engine/server/tests/drift.e2e.test.ts`**

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  CHECK_TOUR_DRIFT_METHOD,
  computeSnippetHashUnavailable,
  type CheckTourDriftResult,
} from "@made-i-t/hdtw-protocol";

const serverEntry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
let serverProcess: ChildProcess | undefined;
let connection: MessageConnection | undefined;
let workspaceRoot: string;

// sha256 of "line2\nline3" (the anchored snippet authored below).
const SNIPPET_HASH = "PLACEHOLDER";

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "hdtw-drift-"));
});

afterEach(async () => {
  connection?.dispose();
  connection = undefined;
  serverProcess?.kill();
  serverProcess = undefined;
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("checkTourDrift reports fresh then drifted after the file shifts", async () => {
  await writeFile(path.join(workspaceRoot, "src.ts"), "line1\nline2\nline3\nline4\n");
  await mkdir(path.join(workspaceRoot, ".hdtw", "tours"), { recursive: true });
  // Build the tour with a correct hash by importing engine-core in-process.
  const { computeSnippetHash } = await import("@made-i-t/hdtw-engine-core");
  const hash = computeSnippetHash("line2\nline3");
  await writeFile(
    path.join(workspaceRoot, ".hdtw/tours/t.tour.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "t",
      title: "T",
      summary: "",
      steps: [
        {
          title: "s",
          narration: "n",
          anchor: { file: "src.ts", startLine: 2, endLine: 3, snippetHash: hash },
        },
      ],
    })
  );

  serverProcess = spawn(process.execPath, [serverEntry], { stdio: ["pipe", "pipe", "inherit"] });
  connection = createMessageConnection(
    new StreamMessageReader(serverProcess.stdout!),
    new StreamMessageWriter(serverProcess.stdin!)
  );
  connection.listen();

  const fresh = await connection.sendRequest<CheckTourDriftResult>(CHECK_TOUR_DRIFT_METHOD, {
    workspaceRoot,
    tourId: "t",
  });
  expect(fresh.statuses).toEqual([{ index: 0, status: "fresh" }]);

  // Shift the anchored lines down by two.
  await writeFile(path.join(workspaceRoot, "src.ts"), "pad\npad\nline1\nline2\nline3\nline4\n");
  const drifted = await connection.sendRequest<CheckTourDriftResult>(CHECK_TOUR_DRIFT_METHOD, {
    workspaceRoot,
    tourId: "t",
  });
  expect(drifted.statuses).toEqual([{ index: 0, status: "drifted" }]);
});
```

IMPORTANT: the test above references `computeSnippetHashUnavailable` and `SNIPPET_HASH`/`PLACEHOLDER` left over from drafting — DELETE the unused `computeSnippetHashUnavailable` import and the `SNIPPET_HASH` constant; the test computes the hash in-process via `computeSnippetHash` from engine-core. Ensure the final test imports only `CHECK_TOUR_DRIFT_METHOD` and `type CheckTourDriftResult` from the protocol and `computeSnippetHash` from engine-core (dynamic import as shown). Verify the test is self-consistent before running.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @made-i-t/hdtw-engine-server build && pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: the drift e2e FAILS ("Unhandled method hdtw/checkTourDrift"). Existing tests pass.

- [ ] **Step 4: Register `checkTourDrift` in `src/engine/server/src/main.ts`.** Add to the protocol import block: `CHECK_TOUR_DRIFT_METHOD`, `type CheckTourDriftParams`. Add an import: `import { checkTourDrift } from "./driftHandlers.js";`. Register after the `GENERATE_TOUR_METHOD` handler:

```ts
connection.onRequest(CHECK_TOUR_DRIFT_METHOD, async (params: CheckTourDriftParams) => {
  try {
    return await checkTourDrift(params);
  } catch (error) {
    if (error instanceof TourNotFoundError) {
      throw new ResponseError(TOUR_NOT_FOUND_ERROR_CODE, error.message);
    }
    throw error;
  }
});
```

(`TourNotFoundError`, `ResponseError`, `TOUR_NOT_FOUND_ERROR_CODE` are already imported in main.ts.)

- [ ] **Step 5: Build and run**

Run: `pnpm --filter @made-i-t/hdtw-engine-server build && pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: all pass — prior 27 + 1 drift e2e = 28.

- [ ] **Step 6: Commit**

```bash
git add src/engine/server/src/driftHandlers.ts src/engine/server/src/main.ts src/engine/server/tests/drift.e2e.test.ts
git commit -m "feat(engine-server): add checkTourDrift over stdio"
```

---

### Task 4: engine-server — register `reanchorStep` + e2e

**Files:**
- Modify: `src/engine/server/src/main.ts`
- Test: `src/engine/server/tests/drift.e2e.test.ts` (extend)

- [ ] **Step 1: Extend the e2e — add a test to `src/engine/server/tests/drift.e2e.test.ts`** (add the imports `REANCHOR_STEP_METHOD`, `type ReanchorStepResult` to the protocol import):

```ts
test("reanchorStep relocates a drifted step and rewrites the tour", async () => {
  await writeFile(path.join(workspaceRoot, "src.ts"), "line1\nline2\nline3\nline4\n");
  await mkdir(path.join(workspaceRoot, ".hdtw", "tours"), { recursive: true });
  const { computeSnippetHash } = await import("@made-i-t/hdtw-engine-core");
  const hash = computeSnippetHash("line2\nline3");
  const tourPath = path.join(workspaceRoot, ".hdtw/tours/t.tour.json");
  await writeFile(
    tourPath,
    JSON.stringify({
      schemaVersion: 1,
      id: "t",
      title: "T",
      summary: "",
      steps: [
        { title: "s", narration: "n", anchor: { file: "src.ts", startLine: 2, endLine: 3, snippetHash: hash } },
      ],
    })
  );
  // Shift the code down by two lines.
  await writeFile(path.join(workspaceRoot, "src.ts"), "pad\npad\nline1\nline2\nline3\nline4\n");

  serverProcess = spawn(process.execPath, [serverEntry], { stdio: ["pipe", "pipe", "inherit"] });
  connection = createMessageConnection(
    new StreamMessageReader(serverProcess.stdout!),
    new StreamMessageWriter(serverProcess.stdin!)
  );
  connection.listen();

  const reanchor = await connection.sendRequest<ReanchorStepResult>(REANCHOR_STEP_METHOD, {
    workspaceRoot,
    tourId: "t",
    stepIndex: 0,
  });
  expect(reanchor.outcome).toBe("reanchored");
  expect(reanchor.anchor).toMatchObject({ startLine: 4, endLine: 5 });

  const onDisk = JSON.parse(await (await import("node:fs/promises")).readFile(tourPath, "utf8"));
  expect(onDisk.steps[0].anchor.startLine).toBe(4);
  expect(onDisk.steps[0].anchor.endLine).toBe(5);

  const recheck = await connection.sendRequest<CheckTourDriftResult>(CHECK_TOUR_DRIFT_METHOD, {
    workspaceRoot,
    tourId: "t",
  });
  expect(recheck.statuses).toEqual([{ index: 0, status: "fresh" }]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @made-i-t/hdtw-engine-server build && pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: the new reanchor test FAILS ("Unhandled method hdtw/reanchorStep").

- [ ] **Step 3: Register `reanchorStep` in `src/engine/server/src/main.ts`.** Add to the protocol import block: `REANCHOR_STEP_METHOD`, `type ReanchorStepParams`. Add to the driftHandlers import: `reanchorStep`. Register after the `CHECK_TOUR_DRIFT_METHOD` handler:

```ts
connection.onRequest(REANCHOR_STEP_METHOD, async (params: ReanchorStepParams) => {
  try {
    return await reanchorStep(params);
  } catch (error) {
    if (error instanceof TourNotFoundError) {
      throw new ResponseError(TOUR_NOT_FOUND_ERROR_CODE, error.message);
    }
    throw error;
  }
});
```

- [ ] **Step 4: Build and run**

Run: `pnpm --filter @made-i-t/hdtw-engine-server build && pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: all pass — 28 prior + 1 = 29.

- [ ] **Step 5: Commit**

```bash
git add src/engine/server/src/main.ts src/engine/server/tests/drift.e2e.test.ts
git commit -m "feat(engine-server): add reanchorStep with atomic tour rewrite"
```

---

### Task 5: VS Code — client methods + pure drift-badge helper

**Files:**
- Modify: `src/clients/vscode/src/engineClient.ts`
- Create: `src/clients/vscode/src/driftBadge.ts`
- Test: `src/clients/vscode/src/driftBadge.test.ts`

- [ ] **Step 1: Add client methods in `src/clients/vscode/src/engineClient.ts`.** Extend the protocol import to include the drift method constants + types, then add two methods after `getTour`:

```ts
  async checkTourDrift(workspaceRoot: string, tourId: string): Promise<CheckTourDriftResult> {
    return this.request<CheckTourDriftResult>(CHECK_TOUR_DRIFT_METHOD, { workspaceRoot, tourId });
  }

  async reanchorStep(
    workspaceRoot: string,
    tourId: string,
    stepIndex: number
  ): Promise<ReanchorStepResult> {
    return this.request<ReanchorStepResult>(REANCHOR_STEP_METHOD, { workspaceRoot, tourId, stepIndex });
  }
```

(Add `CHECK_TOUR_DRIFT_METHOD`, `REANCHOR_STEP_METHOD`, and `type CheckTourDriftResult`, `type ReanchorStepResult` to the existing `@made-i-t/hdtw-protocol` import. `this.request<T>` already exists.)

- [ ] **Step 2: Write the failing test — `src/clients/vscode/src/driftBadge.test.ts`**

```ts
import { describe, expect, test } from "vitest";
import { driftBadge, isReanchorable } from "./driftBadge.js";

describe("driftBadge", () => {
  test("fresh has no badge", () => {
    expect(driftBadge("fresh")).toBe("");
  });
  test("each non-fresh status has a distinct badge line", () => {
    expect(driftBadge("drifted")).toContain("drifted");
    expect(driftBadge("out-of-range")).toContain("out of range");
    expect(driftBadge("file-missing")).toContain("missing");
  });
});

describe("isReanchorable", () => {
  test("drifted and out-of-range are re-anchorable; fresh and file-missing are not", () => {
    expect(isReanchorable("drifted")).toBe(true);
    expect(isReanchorable("out-of-range")).toBe(true);
    expect(isReanchorable("fresh")).toBe(false);
    expect(isReanchorable("file-missing")).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter hdtw-vscode test`
Expected: FAIL — cannot find `./driftBadge.js`.

- [ ] **Step 4: Write `src/clients/vscode/src/driftBadge.ts`** (pure — NO vscode imports)

```ts
import type { StepDriftState } from "@made-i-t/hdtw-protocol";

/** A markdown badge line for a non-fresh step, or "" when fresh. */
export function driftBadge(status: StepDriftState): string {
  switch (status) {
    case "drifted":
      return "⚠️ _This step has drifted — the anchored code has changed since the tour was authored._";
    case "out-of-range":
      return "⚠️ _This step's anchor is out of range — the file is shorter than the tour expects._";
    case "file-missing":
      return "🚫 _This step's anchored file is missing._";
    case "fresh":
      return "";
  }
}

/** Re-anchoring searches the file by hash, so it only applies when the file exists. */
export function isReanchorable(status: StepDriftState): boolean {
  return status === "drifted" || status === "out-of-range";
}
```

- [ ] **Step 5: Run tests and build**

Run: `pnpm --filter hdtw-vscode test && pnpm --filter hdtw-vscode build`
Expected: tests pass (12 prior + 6 new = 18); build clean.

- [ ] **Step 6: Commit**

```bash
git add src/clients/vscode/src/engineClient.ts src/clients/vscode/src/driftBadge.ts src/clients/vscode/src/driftBadge.test.ts
git commit -m "feat(vscode): add drift client methods and pure drift-badge helper"
```

---

### Task 6: VS Code — drift badges + re-anchor link in the walk

**Files:**
- Modify: `src/clients/vscode/src/walkController.ts`
- Modify: `src/clients/vscode/package.json` (command)
- Modify: `src/clients/vscode/src/extension.ts`

- [ ] **Step 1: Thread drift statuses into `WalkController`.** Read the file first. Make these changes:

(a) Imports — add:

```ts
import type { StepDriftState } from "@made-i-t/hdtw-protocol";
import { driftBadge, isReanchorable } from "./driftBadge.js";
```

(b) Add a field for the active tour's per-index drift statuses and a setter:

```ts
  private driftByIndex = new Map<number, StepDriftState>();

  setDrift(statuses: { index: number; status: StepDriftState }[]): void {
    this.driftByIndex = new Map(statuses.map((s) => [s.index, s.status]));
  }
```

(c) In `start(tour)` and `pushTour(tour)`, reset drift to empty before rendering (drift is set separately by the caller after a checkTourDrift): at the top of each, add `this.driftByIndex = new Map();` (the caller calls `setDrift` then re-renders via a new `refresh()` — see (e)).

(d) In `renderCurrentStep`, replace the current crude `const drifted = step.anchor.endLine > document.lineCount;` and the drift notice logic with the authoritative status. Compute:

```ts
    const status: StepDriftState = this.driftByIndex.get(activeWalk(this.stack).stepIndex) ?? "fresh";
    const drifted = status !== "fresh";
```

Keep the existing decoration/range logic guarded by `!drifted` as today. Replace the inline drifted-notice string in the `body` with the badge + optional re-anchor link. Replace the `body` construction with:

```ts
    const badge = driftBadge(status);
    const reanchorLink =
      isReanchorable(status) && this.reanchorContext
        ? `\n\n[🔧 Re-anchor this step](command:hdtw.reanchorStep?${encodeURIComponent(
            JSON.stringify([this.reanchorContext.tourId, activeWalk(this.stack).stepIndex])
          )})`
        : "";
    const body =
      (badge ? badge + "\n\n" : "") + step.narration + reanchorLink + this.relatedSection(step.relatedTours);
```

And update the trusted commands to include the new command:

```ts
    narration.isTrusted = { enabledCommands: ["hdtw.followRelated", "hdtw.reanchorStep"] };
```

(e) Add a `reanchorContext` field + a `refresh()` method so the extension can set drift then re-render the current step, and so the command target knows the active tourId:

```ts
  private reanchorContext: { tourId: string } | undefined;

  setReanchorContext(tourId: string): void {
    this.reanchorContext = { tourId };
  }

  async refresh(): Promise<void> {
    await this.renderCurrentStep();
  }
```

(NOTE: the `file-missing` status keeps the existing missing-file warning path — but now driven by status. If `status === "file-missing"`, the document open will also fail and the existing missing-file branch handles it; the badge is redundant but harmless. Leave the existing missing-file branch intact.)

- [ ] **Step 2: Manifest — add the command in `src/clients/vscode/package.json`** — in `contributes.commands`, after `hdtw.followRelated`, add:

```json
      { "command": "hdtw.reanchorStep", "title": "HDTW: Re-anchor Step" }
```

- [ ] **Step 3: Wire `src/clients/vscode/src/extension.ts`.** Read the file first.

(a) Add a helper that starts a walk WITH drift (used by both startTour and generate auto-walk). After constructing the controller in `startTour`, set the reanchor context, check drift, and apply it. Replace the `startTour` success path:

```ts
  try {
    const { tour } = await client.getTour(root, tourId);
    observer?.logger.info("tour.started", { tourId });
    await refreshTourTitles(root);
    walk?.dispose();
    walk = new WalkController(root, (id) => tourTitles.get(id));
    walk.setReanchorContext(tourId);
    await walk.start(tour);
    await applyDrift(root, tourId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`HDTW: could not start tour: ${message}`);
  }
```

(b) Add the `applyDrift` helper near `startTour`:

```ts
async function applyDrift(root: string, tourId: string): Promise<void> {
  if (!client || !walk) {
    return;
  }
  try {
    const { statuses } = await client.checkTourDrift(root, tourId);
    walk.setDrift(statuses);
    await walk.refresh();
    const drifted = statuses.filter((s) => s.status !== "fresh").length;
    observer?.logger.info("drift.checked", { tourId, drifted, total: statuses.length });
  } catch {
    // Drift is best-effort; a failure leaves the walk usable without badges.
  }
}
```

(c) In `generateTour`'s auto-walk, mirror it: after `await walk.start(result.tour);` add `walk.setReanchorContext(result.tour.id); await applyDrift(root, result.tour.id);` (set the context before or after start; before refresh is fine — simplest is to set context right after constructing walk, like startTour). Adjust to:

```ts
    await refreshTourTitles(root);
    walk?.dispose();
    walk = new WalkController(root, (id) => tourTitles.get(id));
    walk.setReanchorContext(result.tour.id);
    await walk.start(result.tour);
    await applyDrift(root, result.tour.id);
```

(d) Register the re-anchor command — in the `context.subscriptions.push(...)` block, add:

```ts
    vscode.commands.registerCommand("hdtw.reanchorStep", (tourId: string, stepIndex: number) =>
      reanchorStep(tourId, stepIndex)
    ),
```

(e) Add the `reanchorStep` function near `followRelated`:

```ts
async function reanchorStep(tourId: string, stepIndex: number): Promise<void> {
  const root = workspaceRoot();
  if (!root || !client || !walk) {
    return;
  }
  try {
    const result = await client.reanchorStep(root, tourId, stepIndex);
    observer?.logger.info("reanchor.result", { tourId, stepIndex, outcome: result.outcome });
    if (result.outcome === "reanchored") {
      void vscode.window.showInformationMessage(
        `HDTW: re-anchored step ${stepIndex + 1} — review the change in your tour file.`
      );
      await applyDrift(root, tourId);
      return;
    }
    const reason =
      result.outcome === "ambiguous"
        ? "the code appears more than once"
        : result.outcome === "file-missing"
          ? "the file is missing"
          : "the original code could not be found";
    void vscode.window.showWarningMessage(
      `HDTW: couldn't re-anchor step ${stepIndex + 1} — ${reason}. Edit the tour by hand.`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`HDTW: re-anchor failed: ${message}`);
  }
}
```

- [ ] **Step 4: Full verification**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: build clean; tests pass (vscode 18; total = protocol 6, observability 14, core 33, server 29, vscode 18 = 100); lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/clients/vscode
git commit -m "feat(vscode): drift badges and re-anchor link in the walk"
```

---

### Task 7: VS Code sidebar drift badge + docs

**Files:**
- Modify: `src/clients/vscode/src/tourTree.ts`
- Modify: `src/clients/vscode/src/extension.ts` (drift counts + Check command)
- Modify: `src/clients/vscode/package.json` (command + menu)
- Modify: `docs/product-roadmap.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: TourTreeProvider shows a drift count.** In `src/clients/vscode/src/tourTree.ts`, give `TourTreeProvider` a drift lookup. Read the file; add a constructor param `private readonly driftCount: (tourId: string) => number | undefined` (third param), and in the valid-tour branch of `TourTreeItem` append the count to the description when present. Simplest: have `TourTreeProvider.getChildren` pass the count into `TourTreeItem`. Change `TourTreeItem` to accept an optional `driftCount` and, when `> 0`, set `this.description = \`${tour.stepCount} steps · ⚠ ${driftCount} drifted\``. (Keep the existing description when undefined/0.)

Provide the count from the provider:

```ts
  async getChildren(): Promise<TourTreeItem[]> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot || !this.client.isConnected) {
      return [];
    }
    const result = await this.client.listTours(workspaceRoot);
    return result.tours.map((tour) => new TourTreeItem(tour, this.driftCount(tour.id)));
  }
```

- [ ] **Step 2: Extension owns the drift-count cache.** In `src/clients/vscode/src/extension.ts`:

(a) Add module state: `let driftCounts = new Map<string, number>();`

(b) When constructing the tree, pass the lookup: `tree = new TourTreeProvider(client, workspaceRoot, (id) => driftCounts.get(id));`

(c) In `applyDrift` (from Task 6), after computing `drifted`, update the cache and refresh the tree:

```ts
    driftCounts.set(tourId, drifted);
    tree?.refresh();
```

(insert right after the `observer?.logger.info("drift.checked", ...)` line).

(d) Add a `hdtw.checkTourDrift` command that checks the clicked tour and updates its badge:

```ts
    vscode.commands.registerCommand("hdtw.checkTourDrift", async (item?: { id?: string }) => {
      const root = workspaceRoot();
      const tourId = typeof item?.id === "string" ? item.id : undefined;
      if (!root || !client || !tourId) {
        return;
      }
      try {
        const { statuses } = await client.checkTourDrift(root, tourId);
        driftCounts.set(tourId, statuses.filter((s) => s.status !== "fresh").length);
        tree?.refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`HDTW: drift check failed: ${message}`);
      }
    }),
```

(The TreeItem already sets `this.id = tour.id`, so the command receives the item with `.id`.)

- [ ] **Step 3: Manifest — command + context menu.** In `src/clients/vscode/package.json`:

Add to `contributes.commands`:

```json
      { "command": "hdtw.checkTourDrift", "title": "HDTW: Check Tour for Drift", "icon": "$(search)" }
```

Add a `view/item/context` menu so it appears on a tour row (add the `view/item/context` key to `contributes.menus` if absent):

```json
      "view/item/context": [
        { "command": "hdtw.checkTourDrift", "when": "view == hdtwTours && viewItem == hdtwTour", "group": "inline" }
      ]
```

(`TourTreeItem` already sets `contextValue = "hdtwTour"` for valid tours.)

- [ ] **Step 4: Verify**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: all green (100 tests — no new unit tests this task); lint clean.

- [ ] **Step 5: Docs.**

In `docs/product-roadmap.md`: change the Chunk 4a heading from `🔄 spec'd, next up` to `✅ shipped 2026-06-13`.

In `AGENTS.md` **Current state**, add after the Tour graph bullet:

```markdown
- **Anchor drift detection shipped (Chunk 4a):** on walk start the engine recomputes each step's `snippetHash` (`hdtw/checkTourDrift`) and reports `fresh`/`drifted`/`out-of-range`/`file-missing`. Drifted steps badge in the narration thread with a "Re-anchor this step" link → `hdtw/reanchorStep` slides a window of the anchor's length to find the verbatim-moved code by hash and atomically rewrites that step's range+hash (author reviews the git diff). Sidebar shows `⚠ N drifted` on demand. Pure core: `checkAnchorFreshness`/`findReanchor` in `src/engine/core/src/anchors.ts`.
```

- [ ] **Step 6: Commit**

```bash
git add src/clients/vscode docs/product-roadmap.md AGENTS.md
git commit -m "feat(vscode): sidebar drift badge + check-drift command; mark chunk 4a shipped"
```

- [ ] **Step 7: Human F5 dogfood (flag in report — cannot be automated)**

1. F5 → Extension Dev Host. Walk a tour; confirm steps show no drift badge.
2. Edit a file so an anchored step's code shifts down a few lines; save.
3. Re-start that tour (or run "HDTW: Check Tour for Drift" on it) → the step badges "drifted"; the sidebar shows `⚠ 1 drifted`.
4. Click "Re-anchor this step" → info message; the tour file updates (check `git diff .hdtw/tours/...`); re-walk → the step is fresh.
5. Edit the anchored code's CONTENT (not just position) → re-anchor → "couldn't re-anchor … edit by hand".
```
