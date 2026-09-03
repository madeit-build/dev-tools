# Conversational Ask Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "HDTW: Ask…" generates an ephemeral walk (`generateTour{save:false}`, nothing written); the user walks it and clicks "Save to catalog" (`hdtw/saveTour`) to promote it into `.hdtw/tours/`. Casual questions leave no trace.

**Architecture:** The generation pipeline's catalog-write logic is extracted into a shared `tourStorage` module; `generateTour` gains a `save` flag (skips the write + the "saving" phase when false, returning the in-memory verified `Tour`); a new `hdtw/saveTour` writes a client-held `Tour` via the same module. The VS Code client adds an "Ask…" entry that runs `save:false` and a status-bar "Save tour" affordance shown only for unsaved walks. Spec: `docs/superpowers/specs/2026-06-13-conversational-ask-design.md`.

**Tech Stack:** existing monorepo stack. No new deps.

**Conventions:** `@made-i-t/hdtw-*` scope; `.js` relative imports; engine-core pure; clients import code only from the protocol package; engine never trusts agent/client data (the saved tour is re-gated; `slugify` confines the path); observability via the injected observer (no bare `console.*`); tests co-located/excluded from build; commands run from repo root.

---

### Task 1: Protocol — `save` flag, optional `savedPath`, `saveTour` method

**Files:**
- Modify: `src/protocol/src/generation.ts`
- Test: `src/protocol/src/saveTour.test.ts`

- [ ] **Step 1: Write the failing test — `src/protocol/src/saveTour.test.ts`**

```ts
import { expect, test } from "vitest";
import { SAVE_TOUR_METHOD, SAVE_TOUR_FAILED_ERROR_CODE } from "./index.js";

test("saveTour protocol constants are stable", () => {
  expect(SAVE_TOUR_METHOD).toBe("hdtw/saveTour");
  expect(SAVE_TOUR_FAILED_ERROR_CODE).toBe(-32005);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @made-i-t/hdtw-protocol test`
Expected: FAIL — constants not exported.

- [ ] **Step 3: Edit `src/protocol/src/generation.ts`.** Add `save?` to `GenerateTourParams` and make `savedPath` optional on the result:

Change `GenerateTourParams` to add (after `maxBudgetUsd?`):
```ts
  /** When false, generate without writing the tour to the catalog (ephemeral). Defaults to true. */
  save?: boolean;
```

Change `GenerateTourResult` so `savedPath` is optional:
```ts
export interface GenerateTourResult {
  tour: Tour;
  /** Workspace-root-relative path of the written tour file; absent when save was false. */
  savedPath?: string;
}
```

Append the saveTour contract at the end of the file:
```ts
/** JSON-RPC method: client→engine, persist a (previously generated, in-memory) tour into the catalog. */
export const SAVE_TOUR_METHOD = "hdtw/saveTour";

/** A tour could not be saved to the catalog (message carries detail). */
export const SAVE_TOUR_FAILED_ERROR_CODE = -32005;

export interface SaveTourParams {
  workspaceRoot: string;
  tour: Tour;
}

export interface SaveTourResult {
  savedPath: string;
}
```

(`Tour` is already imported in this file via `import type { Tour } from "./tours.js";` — confirm; if not, add it.)

- [ ] **Step 4: Run tests and build**

Run: `pnpm --filter @made-i-t/hdtw-protocol test && pnpm --filter @made-i-t/hdtw-protocol build`
Expected: all pass; build exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/protocol
git commit -m "feat(protocol): add save flag, optional savedPath, and saveTour method"
```

---

### Task 2: engine-server — extract `tourStorage`; `generateTour` honors `save`

**Files:**
- Create: `src/engine/server/src/tourStorage.ts`
- Modify: `src/engine/server/src/generationPipeline.ts`
- Test: `src/engine/server/src/tourStorage.test.ts`
- Test: `src/engine/server/tests/generationPipeline.test.ts` (extend)

- [ ] **Step 1: Write `src/engine/server/src/tourStorage.ts`** (moves slugify/uniqueTourId/exists + the atomic catalog write out of the pipeline):

```ts
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseTour } from "@made-i-t/hdtw-engine-core";
import type { Tour } from "@made-i-t/hdtw-protocol";

export const TOURS_DIR_SEGMENTS = [".hdtw", "tours"];
const TOUR_FILE_SUFFIX = ".tour.json";

export class TourSaveError extends Error {}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "tour";
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function uniqueTourId(toursDir: string, baseId: string): Promise<string> {
  let id = baseId;
  let counter = 2;
  while (await exists(path.join(toursDir, `${id}${TOUR_FILE_SUFFIX}`))) {
    id = `${baseId}-${counter}`;
    counter += 1;
  }
  return id;
}

/** Assign a unique id, gate the result, and atomically write the tour into the catalog. */
export async function writeTourToCatalog(
  workspaceRoot: string,
  tour: Tour
): Promise<{ savedPath: string; tour: Tour }> {
  const toursDir = path.join(workspaceRoot, ...TOURS_DIR_SEGMENTS);
  await mkdir(toursDir, { recursive: true });

  const id = await uniqueTourId(toursDir, slugify(tour.title));
  const finalTour: Tour = { ...tour, id };
  const serialized = JSON.stringify(finalTour, null, 2) + "\n";
  const gate = parseTour(serialized, id);
  if (!gate.ok) {
    throw new TourSaveError(`tour failed validation: ${gate.errors.join("; ")}`);
  }

  const finalPath = path.join(toursDir, `${id}${TOUR_FILE_SUFFIX}`);
  const tempPath = `${finalPath}.tmp`;
  await writeFile(tempPath, serialized, "utf8");
  await rename(tempPath, finalPath);

  return { savedPath: [...TOURS_DIR_SEGMENTS, `${id}${TOUR_FILE_SUFFIX}`].join("/"), tour: finalTour };
}
```

- [ ] **Step 2: Write the failing test — `src/engine/server/src/tourStorage.test.ts`**

```ts
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Tour } from "@made-i-t/hdtw-protocol";
import { slugify, writeTourToCatalog } from "./tourStorage.js";

describe("slugify", () => {
  test("lowercases and dashes non-alphanumerics, trims dashes", () => {
    expect(slugify("How Does Drift Work?!")).toBe("how-does-drift-work");
    expect(slugify("***")).toBe("tour");
  });
});

function tour(title: string): Tour {
  return {
    schemaVersion: 1,
    id: "provisional",
    title,
    summary: "",
    steps: [
      { title: "s", narration: "n", anchor: { file: "README.md", startLine: 1, endLine: 1, snippetHash: "sha256:aa" } },
    ],
  };
}

describe("writeTourToCatalog", () => {
  let workspaceRoot: string;
  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), "hdtw-store-"));
  });
  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("writes the tour with a slugified id and matching filename", async () => {
    const result = await writeTourToCatalog(workspaceRoot, tour("My Tour"));
    expect(result.savedPath).toBe(".hdtw/tours/my-tour.tour.json");
    expect(result.tour.id).toBe("my-tour");
    const onDisk = JSON.parse(await readFile(path.join(workspaceRoot, result.savedPath), "utf8"));
    expect(onDisk.id).toBe("my-tour");
  });

  test("a colliding title gets a -2 suffix", async () => {
    await mkdir(path.join(workspaceRoot, ".hdtw", "tours"), { recursive: true });
    await writeFile(path.join(workspaceRoot, ".hdtw/tours/my-tour.tour.json"), "{}");
    const result = await writeTourToCatalog(workspaceRoot, tour("My Tour"));
    expect(result.savedPath).toBe(".hdtw/tours/my-tour-2.tour.json");
    expect(result.tour.id).toBe("my-tour-2");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: FAIL — `tourStorage.js` not found.

- [ ] **Step 4: Refactor `src/engine/server/src/generationPipeline.ts` to use `tourStorage` and honor `save`.**

(a) Remove the local `slugify`, `uniqueTourId`, `exists`, and the `saveTour` function (the catalog-write internals). Remove now-unused imports (`access`, `mkdir`, `rename`, `writeFile` from `node:fs/promises` if no longer used elsewhere — `readFile` is still used by `verifyStep`, keep it). Add:

```ts
import { writeTourToCatalog } from "./tourStorage.js";
```

(b) Add an `assembleTour` helper near the bottom (builds the in-memory tour + gates it):

```ts
function assembleTour(draft: DraftTour, steps: TourStep[]): Tour {
  const tour: Tour = {
    schemaVersion: 1,
    id: slugifyTitle(draft.title),
    title: draft.title,
    summary: draft.summary,
    steps,
  };
  const serialized = JSON.stringify(tour, null, 2) + "\n";
  const gate = parseTour(serialized, tour.id);
  if (!gate.ok) {
    throw new GenerationFailedError(`generated tour failed validation: ${gate.errors.join("; ")}`);
  }
  return tour;
}

function slugifyTitle(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "tour";
}
```

(`parseTour` is already imported from engine-core in this file; confirm. `Tour`/`TourStep`/`DraftTour` types are already imported.)

(c) Replace the tail of `runGeneration` (the `onProgress saving` + `saveTour` + `generate.done` + `span.end` + `return`) with:

```ts
  const tour = assembleTour(draft, verified.steps);

  if (params.save === false) {
    observer.logger.info("generate.done", { id: tour.id, steps: tour.steps.length, saved: false });
    span.end({ steps: tour.steps.length });
    return { tour, savedPath: undefined };
  }

  onProgress({ phase: "saving", message: "Saving tour", tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0 });
  let saved;
  try {
    saved = await writeTourToCatalog(params.workspaceRoot, tour);
  } catch (error) {
    throw new GenerationFailedError(error instanceof Error ? error.message : String(error));
  }
  observer.logger.info("generate.done", { id: saved.tour.id, steps: saved.tour.steps.length, savedPath: saved.savedPath });
  span.end({ steps: saved.tour.steps.length });
  return { tour: saved.tour, savedPath: saved.savedPath };
```

(`GenerateTourResult` now allows `savedPath?: string` so returning `savedPath: undefined` typechecks.)

- [ ] **Step 5: Extend the pipeline test — `src/engine/server/tests/generationPipeline.test.ts`.** Add inside `describe("runGeneration", ...)`:

```ts
  test("save:false returns the tour and writes nothing", async () => {
    const controller = new AbortController();
    const observer = createObserver({ sink: { record: () => {} }, minLevel: "error" });
    const result = await runGeneration(
      { workspaceRoot, topic: "x", save: false },
      new FakeTourGenerator(),
      observer,
      () => {},
      controller.signal
    );
    expect(result.savedPath).toBeUndefined();
    expect(result.tour.steps).toHaveLength(1);
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(path.join(workspaceRoot, ".hdtw", "tours")).catch(() => []);
    expect(entries).toEqual([]); // nothing written
  });
```

(The existing happy-path test already covers `save:true` writing — confirm it still passes.)

- [ ] **Step 6: Run tests and build**

Run: `pnpm --filter @made-i-t/hdtw-engine-server build && pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: all pass (prior server tests + 4 new across tourStorage + pipeline). Report the count.

- [ ] **Step 7: Commit**

```bash
git add src/engine/server/src/tourStorage.ts src/engine/server/src/generationPipeline.ts src/engine/server/src/tourStorage.test.ts src/engine/server/tests/generationPipeline.test.ts
git commit -m "feat(engine-server): extract tourStorage; generateTour honors save flag"
```

---

### Task 3: engine-server — `saveTour` handler + register + e2e

**Files:**
- Create: `src/engine/server/src/saveTourHandler.ts`
- Modify: `src/engine/server/src/main.ts`
- Test: `src/engine/server/tests/saveTour.e2e.test.ts`

- [ ] **Step 1: Write `src/engine/server/src/saveTourHandler.ts`**

```ts
import type { SaveTourParams, SaveTourResult } from "@made-i-t/hdtw-protocol";
import { writeTourToCatalog } from "./tourStorage.js";

export async function saveTour(params: SaveTourParams): Promise<SaveTourResult> {
  const { savedPath } = await writeTourToCatalog(params.workspaceRoot, params.tour);
  return { savedPath };
}
```

- [ ] **Step 2: Write the failing e2e — `src/engine/server/tests/saveTour.e2e.test.ts`**

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
  SAVE_TOUR_METHOD,
  type GenerateTourResult,
  type SaveTourResult,
} from "@made-i-t/hdtw-protocol";

const serverEntry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
let serverProcess: ChildProcess | undefined;
let connection: MessageConnection | undefined;
let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "hdtw-save-"));
  await writeFile(path.join(workspaceRoot, "README.md"), "fixture readme\n");
});
afterEach(async () => {
  connection?.dispose();
  connection = undefined;
  serverProcess?.kill();
  serverProcess = undefined;
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("generate save:false writes nothing; saveTour then persists it", async () => {
  serverProcess = spawn(process.execPath, [serverEntry], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, HDTW_GENERATOR: "fake" },
  });
  connection = createMessageConnection(
    new StreamMessageReader(serverProcess.stdout!),
    new StreamMessageWriter(serverProcess.stdin!)
  );
  connection.listen();

  const generated = await connection.sendRequest<GenerateTourResult>(GENERATE_TOUR_METHOD, {
    workspaceRoot,
    topic: "how does the readme work",
    save: false,
  });
  expect(generated.savedPath).toBeUndefined();

  const saved = await connection.sendRequest<SaveTourResult>(SAVE_TOUR_METHOD, {
    workspaceRoot,
    tour: generated.tour,
  });
  expect(saved.savedPath).toBe(".hdtw/tours/fake-tour.tour.json");
  const onDisk = JSON.parse(await readFile(path.join(workspaceRoot, saved.savedPath), "utf8"));
  expect(onDisk.id).toBe("fake-tour");

  // Saving again gets a -2 suffix.
  const saved2 = await connection.sendRequest<SaveTourResult>(SAVE_TOUR_METHOD, {
    workspaceRoot,
    tour: generated.tour,
  });
  expect(saved2.savedPath).toBe(".hdtw/tours/fake-tour-2.tour.json");
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @made-i-t/hdtw-engine-server build && pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: the saveTour e2e FAILS ("Unhandled method hdtw/saveTour"). Existing tests pass.

- [ ] **Step 4: Register in `src/engine/server/src/main.ts`.** Add to the protocol import block: `SAVE_TOUR_METHOD`, `SAVE_TOUR_FAILED_ERROR_CODE`, `type SaveTourParams`. Add `import { saveTour } from "./saveTourHandler.js";` and `import { TourSaveError } from "./tourStorage.js";`. Register after the `GENERATE_TOUR_METHOD` handler:

```ts
connection.onRequest(SAVE_TOUR_METHOD, async (params: SaveTourParams) => {
  try {
    return await saveTour(params);
  } catch (error) {
    if (error instanceof TourSaveError) {
      throw new ResponseError(SAVE_TOUR_FAILED_ERROR_CODE, error.message);
    }
    throw error;
  }
});
```

- [ ] **Step 5: Build and run**

Run: `pnpm --filter @made-i-t/hdtw-engine-server build && pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: all pass (+1 saveTour e2e). Report the count.

- [ ] **Step 6: Commit**

```bash
git add src/engine/server/src/saveTourHandler.ts src/engine/server/src/main.ts src/engine/server/tests/saveTour.e2e.test.ts
git commit -m "feat(engine-server): add saveTour handler over stdio"
```

---

### Task 4: VS Code — "Ask…" + ephemeral walk + "Save tour"

**Files:**
- Create: `src/clients/vscode/src/saveState.ts`
- Modify: `src/clients/vscode/src/engineClient.ts`
- Modify: `src/clients/vscode/package.json`
- Modify: `src/clients/vscode/src/extension.ts`
- Test: `src/clients/vscode/src/saveState.test.ts`

- [ ] **Step 1: Write the failing test — `src/clients/vscode/src/saveState.test.ts`**

```ts
import { describe, expect, test } from "vitest";
import { createSaveState } from "./saveState.js";

describe("saveState", () => {
  test("a saved walk shows no save affordance", () => {
    const s = createSaveState();
    s.setSaved();
    expect(s.unsavedTour()).toBeUndefined();
  });
  test("an unsaved walk exposes its tour until saved", () => {
    const s = createSaveState();
    const tour = { id: "t" } as unknown as import("@made-i-t/hdtw-protocol").Tour;
    s.setUnsaved(tour);
    expect(s.unsavedTour()).toBe(tour);
    s.setSaved();
    expect(s.unsavedTour()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter hdtw-vscode test`
Expected: FAIL — `saveState.js` not found.

- [ ] **Step 3: Write `src/clients/vscode/src/saveState.ts`** (pure — no vscode)

```ts
import type { Tour } from "@made-i-t/hdtw-protocol";

/** Tracks whether the active walk is an unsaved (ephemeral "Ask") walk and, if so, the tour to save. */
export interface SaveState {
  setUnsaved(tour: Tour): void;
  setSaved(): void;
  /** The tour awaiting save, or undefined when the active walk is already saved. */
  unsavedTour(): Tour | undefined;
}

export function createSaveState(): SaveState {
  let pending: Tour | undefined;
  return {
    setUnsaved(tour) {
      pending = tour;
    },
    setSaved() {
      pending = undefined;
    },
    unsavedTour() {
      return pending;
    },
  };
}
```

- [ ] **Step 4: Add the client method + save passthrough in `src/clients/vscode/src/engineClient.ts`.** Extend the protocol import with `SAVE_TOUR_METHOD`, `type SaveTourResult`, `type Tour`. Add after `generateTour`:

```ts
  async saveTour(workspaceRoot: string, tour: Tour): Promise<SaveTourResult> {
    return this.request<SaveTourResult>(SAVE_TOUR_METHOD, { workspaceRoot, tour });
  }
```

(`generateTour` already forwards its `params` object; the `save` flag rides along since `GenerateTourParams` now includes it — no change needed there.)

- [ ] **Step 5: Manifest — `src/clients/vscode/package.json`.** Add commands:

```json
      { "command": "hdtw.ask", "title": "HDTW: Ask…", "icon": "$(comment-discussion)" },
      { "command": "hdtw.saveWalk", "title": "HDTW: Save Current Walk to Catalog" }
```

Add `hdtw.ask` to the `view/title` menu (before refresh), e.g. group `navigation@0`:

```json
        { "command": "hdtw.ask", "when": "view == hdtwTours", "group": "navigation@0" },
```

- [ ] **Step 6: Wire `src/clients/vscode/src/extension.ts`.** Read the file first. Make these changes:

(a) Imports + module state:
```ts
import { createSaveState } from "./saveState.js";
```
```ts
const saveState = createSaveState();
let saveStatusItem: vscode.StatusBarItem | undefined;
```

(b) In `activate`, create the status-bar item and register the commands. After the channel/observer setup, add:
```ts
  saveStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  saveStatusItem.command = "hdtw.saveWalk";
  saveStatusItem.text = "$(save) Save tour";
  saveStatusItem.tooltip = "Save this walk to .hdtw/tours/";
  context.subscriptions.push(saveStatusItem);
```
In the `context.subscriptions.push(...)` command block add:
```ts
    vscode.commands.registerCommand("hdtw.ask", () => askWalk()),
    vscode.commands.registerCommand("hdtw.saveWalk", () => saveWalk()),
```

(c) A helper to reflect save state in the UI:
```ts
function refreshSaveAffordance(): void {
  if (saveState.unsavedTour()) {
    saveStatusItem?.show();
  } else {
    saveStatusItem?.hide();
  }
}
```

(d) Mark saved-from-catalog walks as saved. In `startTour` and `followRelated`, right before/after starting the walk, call `saveState.setSaved(); refreshSaveAffordance();`. In `generateTour` (Chunk 2's immediate-commit flow) likewise call `saveState.setSaved(); refreshSaveAffordance();` after the walk starts.

(e) Add `askWalk`:
```ts
async function askWalk(): Promise<void> {
  const root = workspaceRoot();
  if (!root || !client) {
    void vscode.window.showErrorMessage("HDTW: open a folder to ask about its code.");
    return;
  }
  if (generating) {
    void vscode.window.showWarningMessage("HDTW: a tour is already being generated.");
    return;
  }
  const question = await vscode.window.showInputBox({
    title: "Ask HDTW",
    prompt: "What do you want to understand?",
    placeHolder: "e.g. how does drift detection work?",
  });
  if (!question) {
    return;
  }
  observer?.logger.info("ask.requested", { question });
  const config = vscode.workspace.getConfiguration("hdtw.generation");
  const model = config.get<string>("model", "");
  const maxBudgetUsd = config.get<number>("maxBudgetUsd", 2);
  generating = true;
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "HDTW: exploring", cancellable: true },
      (progress, token) =>
        client!.generateTour(
          { workspaceRoot: root, topic: question, model: model || undefined, maxBudgetUsd, save: false },
          (update) =>
            progress.report({
              message: `${update.message} (${Math.round((update.tokensIn + update.tokensOut) / 1000)}k tokens · ~$${update.estimatedCostUsd.toFixed(2)})`,
            }),
          token
        )
    );
    observer?.logger.info("ask.generated", { id: result.tour.id });
    await refreshTourTitles(root);
    walk?.dispose();
    walk = new WalkController(root, (id) => tourTitles.get(id));
    walk.setReanchorContext(result.tour.id);
    await walk.start(result.tour);
    await applyDrift(root, result.tour.id);
    saveState.setUnsaved(result.tour);
    refreshSaveAffordance();
  } catch (error) {
    handleGenerationError(error);
  } finally {
    generating = false;
  }
}
```

(f) Add `saveWalk`:
```ts
async function saveWalk(): Promise<void> {
  const root = workspaceRoot();
  const tour = saveState.unsavedTour();
  if (!root || !client || !tour) {
    return;
  }
  try {
    const { savedPath } = await client.saveTour(root, tour);
    observer?.logger.info("tour.saved", { savedPath });
    saveState.setSaved();
    refreshSaveAffordance();
    tree?.refresh();
    void vscode.window.showInformationMessage(`HDTW: saved to ${savedPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`HDTW: could not save tour: ${message}`);
  }
}
```

(g) In `deactivate`, hide/clear is handled by subscriptions; also call `saveState.setSaved()` is unnecessary. Ensure `walk?.exit()`-style cleanup is unchanged.

- [ ] **Step 7: Full verification**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: build clean; all tests pass (report counts); lint clean.

- [ ] **Step 8: Commit**

```bash
git add src/clients/vscode
git commit -m "feat(vscode): Ask… ephemeral walk with Save-to-catalog affordance"
```

---

### Task 5: Docs

**Files:**
- Modify: `docs/product-roadmap.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Roadmap.** Change the Chunk 3a heading from `🔄 spec'd, next up` to `✅ shipped 2026-06-13`.

- [ ] **Step 2: AGENTS.md Current state.** Add after the drift-detection bullet:

```markdown
- **Conversational Ask shipped (Chunk 3a):** "HDTW: Ask…" runs `generateTour{save:false}` (ephemeral — nothing written) and auto-walks the result; a status-bar "Save tour" promotes it via `hdtw/saveTour` into `.hdtw/tours/`. Catalog-write logic lives in the shared `src/engine/server/src/tourStorage.ts` (`slugify`/`uniqueTourId`/`writeTourToCatalog`), used by both generation and save. "Generate Tour…" still commits immediately; "Ask…" is the ephemeral path.
```

- [ ] **Step 3: Full verification**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add docs/product-roadmap.md AGENTS.md
git commit -m "docs: mark conversational ask (chunk 3a) shipped"
```

- [ ] **Step 5: Human F5 dogfood (flag in report)**

1. F5 → Extension Dev Host. Run **HDTW: Ask…** → type "how does drift detection work?" → watch generation → the walk auto-starts and a **`$(save) Save tour`** item appears in the status bar.
2. Confirm **no** file was written yet (`git status` shows no new `.hdtw/tours/` file).
3. Click **Save tour** → a new `.hdtw/tours/<slug>.tour.json` appears; the status-bar item disappears; the sidebar lists it.
4. Ask again and **close the walk without saving** → confirm nothing was written.
```
