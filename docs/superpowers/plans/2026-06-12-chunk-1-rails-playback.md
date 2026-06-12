# Chunk 1: Tour Artifacts + Rails Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Walk a hand-authored tour end-to-end in VS Code — tours sidebar, step-by-step rails with inline narration threads — with no agent and no tokens, dogfooded on this repo's own architecture tour.

**Architecture:** Tour artifacts (`.hdtw/tours/*.tour.json`) are the core data model. `@made-i-t/hdtw-protocol` gains tour types + two stateless request methods; `engine-core` gains pure parse/validation (no fs); `engine-server` reads tour files and serves them; the VS Code client gains a tours TreeView, a pure walk-state module, and a WalkController that maps state onto editor decorations, Comments-API narration threads, and the status bar. Spec: `docs/superpowers/specs/2026-06-12-chunk-1-rails-playback-design.md`.

**Tech Stack:** Existing monorepo stack (TypeScript Node16/CJS, pnpm, Turborepo, Vitest, vscode-jsonrpc). New VS Code APIs: TreeView, Comments, decorations, status bar.

**Conventions (established, follow exactly):** package scope `@made-i-t/hdtw-*`; `exports` maps with `types` condition first; `.js` extensions on ALL relative imports; engine-core has no fs/transport; clients import code only from the protocol package; commands run from repo root `/Users/mattdeclercq/code/made-it/ide-how-does-this-work`.

---

### Task 1: Tour types and method constants in `@made-i-t/hdtw-protocol`

**Files:**
- Create: `src/protocol/src/tours.ts`
- Modify: `src/protocol/src/index.ts`
- Test: `src/protocol/src/tours.test.ts`

- [ ] **Step 1: Write the failing test — `src/protocol/src/tours.test.ts`**

```ts
import { expect, test } from "vitest";
import {
  GET_TOUR_METHOD,
  LIST_TOURS_METHOD,
  TOUR_NOT_FOUND_ERROR_CODE,
} from "./index.js";

test("tour protocol constants are stable", () => {
  expect(LIST_TOURS_METHOD).toBe("hdtw/listTours");
  expect(GET_TOUR_METHOD).toBe("hdtw/getTour");
  expect(TOUR_NOT_FOUND_ERROR_CODE).toBe(-32001);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @made-i-t/hdtw-protocol test`
Expected: FAIL — `tours.test.ts` errors because `index.js` does not export the new constants (the existing `index.test.ts` still passes).

- [ ] **Step 3: Write `src/protocol/src/tours.ts`**

```ts
export const LIST_TOURS_METHOD = "hdtw/listTours";
export const GET_TOUR_METHOD = "hdtw/getTour";

/** JSON-RPC error code returned by hdtw/getTour for an unknown or invalid tour id. */
export const TOUR_NOT_FOUND_ERROR_CODE = -32001;

export interface TourAnchor {
  /** Workspace-root-relative path, POSIX separators. */
  file: string;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive; >= startLine. */
  endLine: number;
  /** "sha256:<hex>" of the anchored text at authoring time (drift detection in Chunk 4). */
  snippetHash: string;
}

export interface TourStep {
  title: string;
  anchor: TourAnchor;
  /** Markdown. */
  narration: string;
}

export interface Tour {
  schemaVersion: 1;
  id: string;
  title: string;
  summary: string;
  steps: TourStep[];
}

export interface TourSummary {
  id: string;
  title: string;
  summary: string;
  stepCount: number;
  /** Present when the tour file failed validation; such a tour cannot be started. */
  error?: string;
}

export interface ListToursParams {
  workspaceRoot: string;
}

export interface ListToursResult {
  tours: TourSummary[];
}

export interface GetTourParams {
  workspaceRoot: string;
  tourId: string;
}

export interface GetTourResult {
  tour: Tour;
}
```

- [ ] **Step 4: Re-export from `src/protocol/src/index.ts`** — append this line at the end of the file:

```ts
export * from "./tours.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @made-i-t/hdtw-protocol test && pnpm --filter @made-i-t/hdtw-protocol build`
Expected: 2 test files pass (2 tests total); build exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/protocol
git commit -m "feat(protocol): add tour types and listTours/getTour methods"
```

---

### Task 2: Pure tour parsing/validation in `@made-i-t/hdtw-engine-core`

**Files:**
- Create: `src/engine/core/src/tours.ts`
- Modify: `src/engine/core/src/index.ts`
- Modify: `src/engine/core/package.json` (add protocol dependency)
- Test: `src/engine/core/src/tours.test.ts`

- [ ] **Step 1: Add the protocol dependency to `src/engine/core/package.json`** — add a `dependencies` block after `"scripts"`:

```json
  "dependencies": {
    "@made-i-t/hdtw-protocol": "workspace:*"
  },
```

Then run: `pnpm install && pnpm --filter @made-i-t/hdtw-protocol build`
Expected: install succeeds; protocol dist/ is fresh (core's tests import its types through the workspace symlink).

- [ ] **Step 2: Write the failing test — `src/engine/core/src/tours.test.ts`**

```ts
import { describe, expect, test } from "vitest";
import { parseTour, toErrorSummary, toTourSummary } from "./tours.js";

function validTourJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    id: "demo",
    title: "Demo tour",
    summary: "A demo",
    steps: [
      {
        title: "Step one",
        anchor: {
          file: "src/index.ts",
          startLine: 1,
          endLine: 3,
          snippetHash: "sha256:abc123",
        },
        narration: "Hello.",
      },
    ],
    ...overrides,
  });
}

describe("parseTour", () => {
  test("accepts a valid tour", () => {
    const result = parseTour(validTourJson(), "demo");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tour.id).toBe("demo");
      expect(result.tour.steps).toHaveLength(1);
    }
  });

  test("rejects invalid JSON", () => {
    const result = parseTour("{nope", "demo");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("not valid JSON");
  });

  test("rejects wrong schemaVersion", () => {
    const result = parseTour(validTourJson({ schemaVersion: 2 }), "demo");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("schemaVersion must be 1");
  });

  test("rejects id/filename mismatch", () => {
    const result = parseTour(validTourJson(), "other-name");
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors).toContain('id "demo" must match filename stem "other-name"');
  });

  test("rejects empty steps", () => {
    const result = parseTour(validTourJson({ steps: [] }), "demo");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("steps must be a non-empty array");
  });

  test("rejects bad anchors", () => {
    const badAnchorStep = {
      title: "Bad",
      anchor: { file: "/abs/path.ts", startLine: 0, endLine: -1, snippetHash: "md5:zz" },
      narration: "x",
    };
    const result = parseTour(validTourJson({ steps: [badAnchorStep] }), "demo");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        "steps[0].anchor.file must be a workspace-relative POSIX path"
      );
      expect(result.errors).toContain("steps[0].anchor.startLine must be an integer >= 1");
      expect(result.errors).toContain(
        'steps[0].anchor.snippetHash must be a string starting with "sha256:"'
      );
    }
  });

  test("rejects endLine before startLine", () => {
    const step = {
      title: "Bad range",
      anchor: { file: "a.ts", startLine: 5, endLine: 2, snippetHash: "sha256:aa" },
      narration: "x",
    };
    const result = parseTour(validTourJson({ steps: [step] }), "demo");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("steps[0].anchor.endLine must be >= startLine");
  });
});

describe("summaries", () => {
  test("toTourSummary maps a tour", () => {
    const result = parseTour(validTourJson(), "demo");
    if (!result.ok) throw new Error("expected valid tour");
    expect(toTourSummary(result.tour)).toEqual({
      id: "demo",
      title: "Demo tour",
      summary: "A demo",
      stepCount: 1,
    });
  });

  test("toErrorSummary marks tour invalid", () => {
    const summary = toErrorSummary("broken", ["a", "b"]);
    expect(summary).toEqual({
      id: "broken",
      title: "broken",
      summary: "",
      stepCount: 0,
      error: "a; b",
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @made-i-t/hdtw-engine-core test`
Expected: FAIL — cannot find module `./tours.js`.

- [ ] **Step 4: Write `src/engine/core/src/tours.ts`**

```ts
import type { Tour, TourSummary } from "@made-i-t/hdtw-protocol";

export type ParseTourResult =
  | { ok: true; tour: Tour }
  | { ok: false; errors: string[] };

export function parseTour(jsonText: string, filenameStem: string): ParseTourResult {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (error) {
    return { ok: false, errors: [`not valid JSON: ${(error as Error).message}`] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["root must be a JSON object"] };
  }
  const candidate = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (candidate.schemaVersion !== 1) {
    errors.push("schemaVersion must be 1");
  }
  if (typeof candidate.id !== "string" || candidate.id.length === 0) {
    errors.push("id must be a non-empty string");
  } else if (candidate.id !== filenameStem) {
    errors.push(`id "${candidate.id}" must match filename stem "${filenameStem}"`);
  }
  if (typeof candidate.title !== "string" || candidate.title.length === 0) {
    errors.push("title must be a non-empty string");
  }
  if (typeof candidate.summary !== "string") {
    errors.push("summary must be a string");
  }
  if (!Array.isArray(candidate.steps) || candidate.steps.length === 0) {
    errors.push("steps must be a non-empty array");
  } else {
    candidate.steps.forEach((step, index) => errors.push(...validateStep(step, index)));
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, tour: candidate as unknown as Tour };
}

function validateStep(step: unknown, index: number): string[] {
  const label = `steps[${index}]`;
  if (typeof step !== "object" || step === null) {
    return [`${label} must be an object`];
  }
  const candidate = step as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof candidate.title !== "string" || candidate.title.length === 0) {
    errors.push(`${label}.title must be a non-empty string`);
  }
  if (typeof candidate.narration !== "string" || candidate.narration.length === 0) {
    errors.push(`${label}.narration must be a non-empty string`);
  }
  errors.push(...validateAnchor(candidate.anchor, label));
  return errors;
}

function validateAnchor(anchor: unknown, stepLabel: string): string[] {
  const label = `${stepLabel}.anchor`;
  if (typeof anchor !== "object" || anchor === null) {
    return [`${label} must be an object`];
  }
  const candidate = anchor as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof candidate.file !== "string" || candidate.file.length === 0) {
    errors.push(`${label}.file must be a non-empty string`);
  } else if (candidate.file.startsWith("/") || candidate.file.includes("\\")) {
    errors.push(`${label}.file must be a workspace-relative POSIX path`);
  }
  if (!Number.isInteger(candidate.startLine) || (candidate.startLine as number) < 1) {
    errors.push(`${label}.startLine must be an integer >= 1`);
  }
  if (!Number.isInteger(candidate.endLine)) {
    errors.push(`${label}.endLine must be an integer`);
  } else if (
    Number.isInteger(candidate.startLine) &&
    (candidate.endLine as number) < (candidate.startLine as number)
  ) {
    errors.push(`${label}.endLine must be >= startLine`);
  }
  if (
    typeof candidate.snippetHash !== "string" ||
    !candidate.snippetHash.startsWith("sha256:")
  ) {
    errors.push(`${label}.snippetHash must be a string starting with "sha256:"`);
  }
  return errors;
}

export function toTourSummary(tour: Tour): TourSummary {
  return {
    id: tour.id,
    title: tour.title,
    summary: tour.summary,
    stepCount: tour.steps.length,
  };
}

export function toErrorSummary(filenameStem: string, errors: string[]): TourSummary {
  return {
    id: filenameStem,
    title: filenameStem,
    summary: "",
    stepCount: 0,
    error: errors.join("; "),
  };
}
```

- [ ] **Step 5: Re-export from `src/engine/core/src/index.ts`** — append at the end:

```ts
export * from "./tours.js";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @made-i-t/hdtw-engine-core test && pnpm --filter @made-i-t/hdtw-engine-core build`
Expected: 2 test files pass (10 tests total); build exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/engine/core pnpm-lock.yaml
git commit -m "feat(engine-core): add pure tour parsing and validation"
```

---

### Task 3: Tour request handlers in `@made-i-t/hdtw-engine-server`

**Files:**
- Create: `src/engine/server/src/tourHandlers.ts`
- Modify: `src/engine/server/src/main.ts`
- Create: `src/engine/server/tests/fixtures/workspace/.hdtw/tours/good-tour.tour.json`
- Create: `src/engine/server/tests/fixtures/workspace/.hdtw/tours/broken-tour.tour.json`
- Create: `src/engine/server/tests/fixtures/workspace/README.md`
- Test: `src/engine/server/tests/tourHandlers.test.ts`
- Test: `src/engine/server/tests/server.e2e.test.ts` (extend)

- [ ] **Step 1: Create the fixture workspace**

`src/engine/server/tests/fixtures/workspace/README.md`:

```
fixture workspace for tour handler tests
```

`src/engine/server/tests/fixtures/workspace/.hdtw/tours/good-tour.tour.json`:

```json
{
  "schemaVersion": 1,
  "id": "good-tour",
  "title": "Good tour",
  "summary": "A valid fixture tour",
  "steps": [
    {
      "title": "The readme",
      "anchor": {
        "file": "README.md",
        "startLine": 1,
        "endLine": 1,
        "snippetHash": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
      },
      "narration": "This is the fixture readme."
    }
  ]
}
```

`src/engine/server/tests/fixtures/workspace/.hdtw/tours/broken-tour.tour.json`:

```json
{
  "schemaVersion": 999,
  "id": "broken-tour",
  "title": "Broken tour"
}
```

- [ ] **Step 2: Write the failing test — `src/engine/server/tests/tourHandlers.test.ts`**

```ts
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { getTour, listTours, TourNotFoundError } from "../src/tourHandlers.js";

const workspaceRoot = fileURLToPath(new URL("./fixtures/workspace", import.meta.url));

describe("listTours", () => {
  test("lists valid and invalid tours, sorted by filename", async () => {
    const result = await listTours({ workspaceRoot });
    expect(result.tours).toHaveLength(2);
    const [broken, good] = result.tours;
    expect(broken.id).toBe("broken-tour");
    expect(broken.error).toContain("schemaVersion must be 1");
    expect(good).toEqual({
      id: "good-tour",
      title: "Good tour",
      summary: "A valid fixture tour",
      stepCount: 1,
    });
  });

  test("returns empty list when .hdtw/tours is absent", async () => {
    const result = await listTours({ workspaceRoot: "/nonexistent/path" });
    expect(result.tours).toEqual([]);
  });
});

describe("getTour", () => {
  test("returns a valid tour", async () => {
    const result = await getTour({ workspaceRoot, tourId: "good-tour" });
    expect(result.tour.title).toBe("Good tour");
    expect(result.tour.steps[0].anchor.file).toBe("README.md");
  });

  test("throws TourNotFoundError for unknown id", async () => {
    await expect(getTour({ workspaceRoot, tourId: "nope" })).rejects.toBeInstanceOf(
      TourNotFoundError
    );
  });

  test("throws TourNotFoundError for an invalid tour", async () => {
    await expect(getTour({ workspaceRoot, tourId: "broken-tour" })).rejects.toBeInstanceOf(
      TourNotFoundError
    );
  });

  test("rejects path-traversal ids", async () => {
    await expect(
      getTour({ workspaceRoot, tourId: "../../../etc/passwd" })
    ).rejects.toBeInstanceOf(TourNotFoundError);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: `tourHandlers.test.ts` FAILS — cannot find module `../src/tourHandlers.js`. (Existing unit + e2e tests still pass; e2e needs a prior build, run `pnpm --filter @made-i-t/hdtw-engine-server build` first if dist/ is stale.)

- [ ] **Step 4: Write `src/engine/server/src/tourHandlers.ts`**

```ts
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  parseTour,
  toErrorSummary,
  toTourSummary,
} from "@made-i-t/hdtw-engine-core";
import type {
  GetTourParams,
  GetTourResult,
  ListToursParams,
  ListToursResult,
} from "@made-i-t/hdtw-protocol";

const TOURS_DIR_SEGMENTS = [".hdtw", "tours"];
const TOUR_FILE_SUFFIX = ".tour.json";
const SAFE_TOUR_ID = /^[\w.-]+$/;

export class TourNotFoundError extends Error {}

export async function listTours(params: ListToursParams): Promise<ListToursResult> {
  const toursDir = path.join(params.workspaceRoot, ...TOURS_DIR_SEGMENTS);
  let entries: string[];
  try {
    entries = await readdir(toursDir);
  } catch {
    return { tours: [] };
  }
  const tourFiles = entries.filter((name) => name.endsWith(TOUR_FILE_SUFFIX)).sort();
  const tours = await Promise.all(
    tourFiles.map(async (name) => {
      const stem = name.slice(0, -TOUR_FILE_SUFFIX.length);
      const jsonText = await readFile(path.join(toursDir, name), "utf8");
      const result = parseTour(jsonText, stem);
      return result.ok ? toTourSummary(result.tour) : toErrorSummary(stem, result.errors);
    })
  );
  return { tours };
}

export async function getTour(params: GetTourParams): Promise<GetTourResult> {
  if (!SAFE_TOUR_ID.test(params.tourId) || params.tourId.includes("..")) {
    throw new TourNotFoundError(`no tour with id "${params.tourId}"`);
  }
  const filePath = path.join(
    params.workspaceRoot,
    ...TOURS_DIR_SEGMENTS,
    `${params.tourId}${TOUR_FILE_SUFFIX}`
  );
  let jsonText: string;
  try {
    jsonText = await readFile(filePath, "utf8");
  } catch {
    throw new TourNotFoundError(`no tour with id "${params.tourId}"`);
  }
  const result = parseTour(jsonText, params.tourId);
  if (!result.ok) {
    throw new TourNotFoundError(
      `tour "${params.tourId}" is invalid: ${result.errors.join("; ")}`
    );
  }
  return { tour: result.tour };
}
```

- [ ] **Step 5: Register the handlers in `src/engine/server/src/main.ts`** — replace the entire file with:

```ts
import {
  createMessageConnection,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import {
  GET_TOUR_METHOD,
  LIST_TOURS_METHOD,
  PING_METHOD,
  TOUR_NOT_FOUND_ERROR_CODE,
  type GetTourParams,
  type ListToursParams,
  type PingParams,
} from "@made-i-t/hdtw-protocol";
import { handlePing } from "./pingHandler.js";
import { getTour, listTours, TourNotFoundError } from "./tourHandlers.js";

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout)
);

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

// Shutdown contract: the server exits when stdin reaches EOF, which doubles
// as orphan cleanup — if the parent client dies, the closed pipe tears us
// down. Keep this property if the transport ever changes.
connection.listen();
```

- [ ] **Step 6: Extend the e2e test — `src/engine/server/tests/server.e2e.test.ts`** — replace the entire file with:

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import {
  GET_TOUR_METHOD,
  LIST_TOURS_METHOD,
  PING_METHOD,
  PROTOCOL_VERSION,
  type GetTourResult,
  type ListToursResult,
  type PingResult,
} from "@made-i-t/hdtw-protocol";

const serverEntry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const fixtureWorkspace = fileURLToPath(new URL("./fixtures/workspace", import.meta.url));

let serverProcess: ChildProcess | undefined;
let connection: MessageConnection | undefined;

function startServer(): MessageConnection {
  serverProcess = spawn(process.execPath, [serverEntry], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  connection = createMessageConnection(
    new StreamMessageReader(serverProcess.stdout!),
    new StreamMessageWriter(serverProcess.stdin!)
  );
  connection.listen();
  return connection;
}

afterEach(() => {
  connection?.dispose();
  connection = undefined;
  serverProcess?.kill();
  serverProcess = undefined;
});

test("engine server responds to ping over stdio JSON-RPC", async () => {
  const conn = startServer();
  const result = await conn.sendRequest<PingResult>(PING_METHOD, {
    clientName: "e2e-test",
    protocolVersion: PROTOCOL_VERSION,
  });
  expect(result).toEqual({
    engineName: "hdtw-engine",
    engineVersion: "0.0.1",
    protocolVersion: PROTOCOL_VERSION,
  });
});

test("engine server lists and fetches tours over stdio", async () => {
  const conn = startServer();

  const list = await conn.sendRequest<ListToursResult>(LIST_TOURS_METHOD, {
    workspaceRoot: fixtureWorkspace,
  });
  expect(list.tours.map((tour) => tour.id)).toEqual(["broken-tour", "good-tour"]);

  const fetched = await conn.sendRequest<GetTourResult>(GET_TOUR_METHOD, {
    workspaceRoot: fixtureWorkspace,
    tourId: "good-tour",
  });
  expect(fetched.tour.title).toBe("Good tour");

  await expect(
    conn.sendRequest(GET_TOUR_METHOD, {
      workspaceRoot: fixtureWorkspace,
      tourId: "missing",
    })
  ).rejects.toMatchObject({ code: -32001 });
});
```

- [ ] **Step 7: Build and run all server tests to verify they pass**

Run: `pnpm --filter @made-i-t/hdtw-engine-server build && pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: 3 test files pass — pingHandler (1), tourHandlers (6), e2e (2). 9 tests total.

- [ ] **Step 8: Commit**

```bash
git add src/engine/server
git commit -m "feat(engine-server): serve tours via listTours/getTour"
```

---

### Task 4: Pure walk-state module in the VS Code client

**Files:**
- Create: `src/clients/vscode/src/walkState.ts`
- Modify: `src/clients/vscode/package.json` (add vitest + test script)
- Modify: `src/clients/vscode/tsconfig.json` (exclude tests from build)
- Test: `src/clients/vscode/src/walkState.test.ts`

- [ ] **Step 1: Add vitest to the vscode package** — in `src/clients/vscode/package.json`, add `"test": "vitest run",` to `scripts` (after `"build"`), and `"vitest": "^3.1.0"` to `devDependencies`. Then in `src/clients/vscode/tsconfig.json` add after `"include"`:

```json
  "exclude": ["src/**/*.test.ts"]
```

Run: `pnpm install`
Expected: succeeds.

- [ ] **Step 2: Write the failing test — `src/clients/vscode/src/walkState.test.ts`**

```ts
import { describe, expect, test } from "vitest";
import type { Tour } from "@made-i-t/hdtw-protocol";
import {
  currentStep,
  hasNext,
  hasPrevious,
  nextStep,
  previousStep,
  progressLabel,
  startWalk,
} from "./walkState.js";

const tour: Tour = {
  schemaVersion: 1,
  id: "t",
  title: "T",
  summary: "",
  steps: [
    { title: "one", anchor: { file: "a.ts", startLine: 1, endLine: 1, snippetHash: "sha256:a" }, narration: "1" },
    { title: "two", anchor: { file: "b.ts", startLine: 2, endLine: 3, snippetHash: "sha256:b" }, narration: "2" },
  ],
};

describe("walk state", () => {
  test("starts at the first step", () => {
    const state = startWalk(tour);
    expect(state.stepIndex).toBe(0);
    expect(currentStep(state).title).toBe("one");
    expect(hasPrevious(state)).toBe(false);
    expect(hasNext(state)).toBe(true);
    expect(progressLabel(state)).toBe("1/2");
  });

  test("advances and retreats within bounds", () => {
    let state = startWalk(tour);
    state = nextStep(state);
    expect(currentStep(state).title).toBe("two");
    expect(hasNext(state)).toBe(false);
    state = nextStep(state); // clamped at the end
    expect(state.stepIndex).toBe(1);
    state = previousStep(state);
    expect(state.stepIndex).toBe(0);
    state = previousStep(state); // clamped at the start
    expect(state.stepIndex).toBe(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter hdtw-vscode test`
Expected: FAIL — cannot find module `./walkState.js`.

- [ ] **Step 4: Write `src/clients/vscode/src/walkState.ts`** (pure — NO `vscode` imports)

```ts
import type { Tour, TourStep } from "@made-i-t/hdtw-protocol";

export interface WalkState {
  tour: Tour;
  stepIndex: number;
}

export function startWalk(tour: Tour): WalkState {
  return { tour, stepIndex: 0 };
}

export function currentStep(state: WalkState): TourStep {
  return state.tour.steps[state.stepIndex];
}

export function hasNext(state: WalkState): boolean {
  return state.stepIndex < state.tour.steps.length - 1;
}

export function hasPrevious(state: WalkState): boolean {
  return state.stepIndex > 0;
}

export function nextStep(state: WalkState): WalkState {
  return hasNext(state) ? { ...state, stepIndex: state.stepIndex + 1 } : state;
}

export function previousStep(state: WalkState): WalkState {
  return hasPrevious(state) ? { ...state, stepIndex: state.stepIndex - 1 } : state;
}

export function progressLabel(state: WalkState): string {
  return `${state.stepIndex + 1}/${state.tour.steps.length}`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter hdtw-vscode test && pnpm --filter hdtw-vscode build`
Expected: 1 test file passes (2 tests); build exit 0 and `dist/` contains no `walkState.test.*`.

- [ ] **Step 6: Commit**

```bash
git add src/clients/vscode pnpm-lock.yaml
git commit -m "feat(vscode): add pure walk-state module"
```

---

### Task 5: Extract `EngineClient` from extension.ts

**Files:**
- Create: `src/clients/vscode/src/engineClient.ts`
- Modify: `src/clients/vscode/src/extension.ts`

This is a refactor (no behavior change) that gives later tasks a typed client for tour requests. No new unit tests — the behavior is covered by the engine-server e2e and verified by build + F5.

- [ ] **Step 1: Write `src/clients/vscode/src/engineClient.ts`** — the connection logic moves here verbatim from extension.ts, wrapped in a class, plus typed tour requests:

```ts
import * as childProcess from "node:child_process";
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import {
  GET_TOUR_METHOD,
  LIST_TOURS_METHOD,
  PING_METHOD,
  PROTOCOL_VERSION,
  type GetTourParams,
  type GetTourResult,
  type ListToursParams,
  type ListToursResult,
  type PingParams,
  type PingResult,
} from "@made-i-t/hdtw-protocol";

const HANDSHAKE_TIMEOUT_MS = 5000;

export class EngineClient {
  private engineProcess: childProcess.ChildProcess | undefined;
  private connection: MessageConnection | undefined;

  get isConnected(): boolean {
    return this.connection !== undefined;
  }

  async connect(): Promise<PingResult> {
    // Resolves to the engine-server package's "main" (dist/main.js) via the
    // workspace symlink. The client never imports engine code — it only needs
    // the path to spawn the process.
    const serverEntry = require.resolve("@made-i-t/hdtw-engine-server");

    // The extension host is Electron; ELECTRON_RUN_AS_NODE makes the spawned
    // process behave as plain Node.js (same technique vscode-languageclient uses).
    // The piped stdin doubles as orphan cleanup: the engine exits on stdin EOF.
    const serverProcess = childProcess.spawn(process.execPath, [serverEntry], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.engineProcess = serverProcess;

    serverProcess.stderr?.on("data", (chunk: Buffer) => {
      console.error(`[hdtw-engine] ${chunk.toString().trimEnd()}`);
    });

    if (!serverProcess.stdout || !serverProcess.stdin) {
      throw new Error("engine process has no stdio streams");
    }

    const connection = createMessageConnection(
      new StreamMessageReader(serverProcess.stdout),
      new StreamMessageWriter(serverProcess.stdin)
    );
    this.connection = connection;
    connection.listen();

    const params: PingParams = {
      clientName: "vscode",
      protocolVersion: PROTOCOL_VERSION,
    };

    // Reject promptly and distinctly for each failure mode (spawn failure,
    // engine crash, request error) instead of letting them all degrade into
    // the generic handshake timeout.
    return new Promise<PingResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`engine handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms`));
      }, HANDSHAKE_TIMEOUT_MS);
      const settleWith = (callback: () => void) => {
        clearTimeout(timer);
        callback();
      };

      serverProcess.on("error", (error) =>
        settleWith(() => reject(new Error(`engine process failed to spawn: ${error.message}`)))
      );
      serverProcess.on("exit", (code) =>
        settleWith(() =>
          reject(new Error(`engine process exited before handshake completed (code ${code})`))
        )
      );
      connection.sendRequest<PingResult>(PING_METHOD, params).then(
        (result) => settleWith(() => resolve(result)),
        (error) => settleWith(() => reject(error instanceof Error ? error : new Error(String(error))))
      );
    });
  }

  async listTours(workspaceRoot: string): Promise<ListToursResult> {
    const params: ListToursParams = { workspaceRoot };
    return this.request<ListToursResult>(LIST_TOURS_METHOD, params);
  }

  async getTour(workspaceRoot: string, tourId: string): Promise<GetTourResult> {
    const params: GetTourParams = { workspaceRoot, tourId };
    return this.request<GetTourResult>(GET_TOUR_METHOD, params);
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    if (!this.connection) {
      return Promise.reject(new Error("engine not connected"));
    }
    return Promise.resolve(this.connection.sendRequest<T>(method, params));
  }

  dispose(): void {
    this.connection?.dispose();
    this.connection = undefined;
    this.engineProcess?.kill();
    this.engineProcess = undefined;
  }
}
```

- [ ] **Step 2: Slim down `src/clients/vscode/src/extension.ts`** — replace the entire file with:

```ts
import * as vscode from "vscode";
import { EngineClient } from "./engineClient.js";

let client: EngineClient | undefined;

export async function activate(_context: vscode.ExtensionContext): Promise<void> {
  if (client) {
    return;
  }
  client = new EngineClient();
  try {
    const result = await client.connect();
    void vscode.window.showInformationMessage(
      `HDTW engine connected (${result.engineName} v${result.engineVersion}, protocol v${result.protocolVersion})`
    );
  } catch (error) {
    client.dispose();
    client = undefined;
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`HDTW engine failed to start: ${message}`);
  }
}

export function deactivate(): void {
  client?.dispose();
  client = undefined;
}
```

- [ ] **Step 3: Verify build and tests**

Run: `pnpm build && pnpm test`
Expected: all packages build; all tests pass (protocol 2, core 10, server 9, vscode 2 — 23 total).

- [ ] **Step 4: Commit**

```bash
git add src/clients/vscode
git commit -m "refactor(vscode): extract EngineClient with typed tour requests"
```

---

### Task 6: Tours sidebar (TreeView + manifest contributions)

**Files:**
- Create: `src/clients/vscode/src/tourTree.ts`
- Create: `src/clients/vscode/media/compass.svg`
- Modify: `src/clients/vscode/package.json` (contributes)
- Modify: `src/clients/vscode/src/extension.ts`
- Modify: `src/clients/vscode/.vscodeignore`

No automated UI tests (per spec) — verified by build now and F5 in Task 8.

- [ ] **Step 1: Create `src/clients/vscode/media/compass.svg`**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
  <circle cx="12" cy="12" r="9"/>
  <path d="M15.5 8.5l-2.2 5-5 2.2 2.2-5z" fill="currentColor" stroke="none"/>
</svg>
```

- [ ] **Step 2: Write `src/clients/vscode/src/tourTree.ts`**

```ts
import * as vscode from "vscode";
import type { TourSummary } from "@made-i-t/hdtw-protocol";
import type { EngineClient } from "./engineClient.js";

export class TourTreeItem extends vscode.TreeItem {
  constructor(tour: TourSummary) {
    super(tour.title, vscode.TreeItemCollapsibleState.None);
    this.id = tour.id;
    if (tour.error) {
      this.description = "invalid";
      this.tooltip = tour.error;
      this.iconPath = new vscode.ThemeIcon("warning");
      this.contextValue = "hdtwTourInvalid";
    } else {
      this.description = `${tour.stepCount} steps`;
      this.tooltip = tour.summary;
      this.iconPath = new vscode.ThemeIcon("compass");
      this.contextValue = "hdtwTour";
      this.command = {
        command: "hdtw.startTour",
        title: "Start Tour",
        arguments: [tour.id],
      };
    }
  }
}

export class TourTreeProvider implements vscode.TreeDataProvider<TourTreeItem> {
  private readonly didChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.didChange.event;

  constructor(
    private readonly client: EngineClient,
    private readonly getWorkspaceRoot: () => string | undefined
  ) {}

  refresh(): void {
    this.didChange.fire();
  }

  getTreeItem(item: TourTreeItem): vscode.TreeItem {
    return item;
  }

  async getChildren(): Promise<TourTreeItem[]> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot || !this.client.isConnected) {
      return [];
    }
    const result = await this.client.listTours(workspaceRoot);
    return result.tours.map((tour) => new TourTreeItem(tour));
  }
}
```

- [ ] **Step 3: Add contributions to `src/clients/vscode/package.json`** — replace the existing `"contributes": {},` with:

```json
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "hdtw",
          "title": "How Does This Work",
          "icon": "media/compass.svg"
        }
      ]
    },
    "views": {
      "hdtw": [
        {
          "id": "hdtwTours",
          "name": "Tours"
        }
      ]
    },
    "commands": [
      { "command": "hdtw.refreshTours", "title": "HDTW: Refresh Tours", "icon": "$(refresh)" },
      { "command": "hdtw.startTour", "title": "HDTW: Start Tour" },
      { "command": "hdtw.tourPrevious", "title": "Back", "icon": "$(arrow-left)" },
      { "command": "hdtw.tourNext", "title": "Next", "icon": "$(arrow-right)" },
      { "command": "hdtw.tourExit", "title": "Exit Tour", "icon": "$(close)" }
    ],
    "menus": {
      "view/title": [
        { "command": "hdtw.refreshTours", "when": "view == hdtwTours", "group": "navigation" }
      ],
      "comments/commentThread/title": [
        { "command": "hdtw.tourPrevious", "when": "commentController == hdtw-tour", "group": "inline@1" },
        { "command": "hdtw.tourNext", "when": "commentController == hdtw-tour", "group": "inline@2" },
        { "command": "hdtw.tourExit", "when": "commentController == hdtw-tour", "group": "inline@3" }
      ]
    }
  },
```

(The comment-thread menu entries reference the `hdtw-tour` comment controller created in Task 7 — contributing them now is harmless and keeps the manifest change in one task.)

- [ ] **Step 4: Wire the tree into `src/clients/vscode/src/extension.ts`** — replace the entire file with:

```ts
import * as vscode from "vscode";
import { EngineClient } from "./engineClient.js";
import { TourTreeProvider } from "./tourTree.js";

let client: EngineClient | undefined;

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (client) {
    return;
  }
  client = new EngineClient();
  try {
    const result = await client.connect();
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

  const tree = new TourTreeProvider(client, workspaceRoot);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("hdtwTours", tree),
    vscode.commands.registerCommand("hdtw.refreshTours", () => tree.refresh())
  );
}

export function deactivate(): void {
  client?.dispose();
  client = undefined;
}
```

(`hdtw.startTour` and the walk commands register in Task 7; clicking a tour before then shows VS Code's "command not found" — acceptable mid-implementation state, resolved within this plan.)

- [ ] **Step 5: Exclude media from packaging noise check** — append `media/` is NOT excluded (the icon must ship); instead verify `.vscodeignore` still lists only `src/`, `tsconfig.json`, `.turbo/`. No change needed unless it drifted.

- [ ] **Step 6: Verify build**

Run: `pnpm build && pnpm test`
Expected: clean build; 23 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/clients/vscode
git commit -m "feat(vscode): add tours sidebar with activity-bar view"
```

---

### Task 7: WalkController — rails, decorations, inline narration thread

**Files:**
- Create: `src/clients/vscode/src/walkController.ts`
- Modify: `src/clients/vscode/src/extension.ts`

- [ ] **Step 1: Write `src/clients/vscode/src/walkController.ts`**

```ts
import path from "node:path";
import * as vscode from "vscode";
import type { Tour } from "@made-i-t/hdtw-protocol";
import {
  currentStep,
  hasNext,
  hasPrevious,
  nextStep,
  previousStep,
  progressLabel,
  startWalk,
  type WalkState,
} from "./walkState.js";

export class WalkController implements vscode.Disposable {
  private state: WalkState | undefined;
  private readonly commentController: vscode.CommentController;
  private thread: vscode.CommentThread | undefined;
  private readonly decoration: vscode.TextEditorDecorationType;
  private readonly statusBarItem: vscode.StatusBarItem;
  private decoratedEditor: vscode.TextEditor | undefined;

  constructor(private readonly workspaceRoot: string) {
    this.commentController = vscode.comments.createCommentController(
      "hdtw-tour",
      "HDTW Tour Guide"
    );
    this.decoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
    });
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  }

  async start(tour: Tour): Promise<void> {
    this.state = startWalk(tour);
    await this.renderCurrentStep();
  }

  async next(): Promise<void> {
    if (this.state && hasNext(this.state)) {
      this.state = nextStep(this.state);
      await this.renderCurrentStep();
    }
  }

  async previous(): Promise<void> {
    if (this.state && hasPrevious(this.state)) {
      this.state = previousStep(this.state);
      await this.renderCurrentStep();
    }
  }

  exit(): void {
    this.state = undefined;
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
    if (!this.state) {
      return;
    }
    this.clearStepArtifacts();
    const step = currentStep(this.state);
    const fileUri = vscode.Uri.file(
      path.join(this.workspaceRoot, ...step.anchor.file.split("/"))
    );

    let document: vscode.TextDocument | undefined;
    try {
      document = await vscode.workspace.openTextDocument(fileUri);
    } catch {
      document = undefined;
    }

    if (!document) {
      // Anchor file is gone: warn, keep the walk alive (spec: never hard-fail mid-walk).
      void vscode.window.showWarningMessage(
        `HDTW step "${step.title}": anchor file ${step.anchor.file} is missing — code may have changed since this tour was authored.`
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
      document.lineAt(endLine).text.length
    );

    const editor = await vscode.window.showTextDocument(document, { preserveFocus: false });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

    if (!drifted) {
      editor.setDecorations(this.decoration, [range]);
      this.decoratedEditor = editor;
    }

    const narration = new vscode.MarkdownString(
      (drifted
        ? "⚠️ _This step's anchor has drifted — code may have changed since authoring._\n\n"
        : "") + step.narration
    );
    this.thread = this.commentController.createCommentThread(fileUri, range, [
      {
        body: narration,
        mode: vscode.CommentMode.Preview,
        author: { name: `🧭 HDTW Guide — ${step.title} (${progressLabel(this.state)})` },
      },
    ]);
    this.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.thread.canReply = false;
    this.thread.label = this.state.tour.title;

    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    if (!this.state) {
      return;
    }
    this.statusBarItem.text = `🧭 ${this.state.tour.title} · ${progressLabel(this.state)}`;
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

- [ ] **Step 2: Register the walk commands in `src/clients/vscode/src/extension.ts`** — replace the entire file with:

```ts
import * as vscode from "vscode";
import { EngineClient } from "./engineClient.js";
import { TourTreeProvider } from "./tourTree.js";
import { WalkController } from "./walkController.js";

let client: EngineClient | undefined;
let walk: WalkController | undefined;

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (client) {
    return;
  }
  client = new EngineClient();
  try {
    const result = await client.connect();
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

  const tree = new TourTreeProvider(client, workspaceRoot);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("hdtwTours", tree),
    vscode.commands.registerCommand("hdtw.refreshTours", () => tree.refresh()),
    vscode.commands.registerCommand("hdtw.startTour", (tourId: string) => startTour(tourId)),
    vscode.commands.registerCommand("hdtw.tourNext", () => walk?.next()),
    vscode.commands.registerCommand("hdtw.tourPrevious", () => walk?.previous()),
    vscode.commands.registerCommand("hdtw.tourExit", () => walk?.exit())
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

export function deactivate(): void {
  walk?.dispose();
  walk = undefined;
  client?.dispose();
  client = undefined;
}
```

- [ ] **Step 3: Verify build and tests**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: clean build, 23 tests pass, lint clean.

- [ ] **Step 4: Commit**

```bash
git add src/clients/vscode
git commit -m "feat(vscode): add rails walk with inline narration threads"
```

---

### Task 8: Dogfood tour, manual verification, docs

**Files:**
- Create: `.hdtw/tours/monorepo-architecture.tour.json`
- Modify: `docs/product-roadmap.md` (chunk 1 status)
- Modify: `AGENTS.md` (current state)

- [ ] **Step 1: Author the dogfood tour**

The tour walks this repo's architecture in five steps. For each step below: find the anchor's current line numbers with the given search, then compute the snippet hash with this command (SHA-256 over the anchored lines joined with `\n`):

```bash
hash_lines() { node -e '
const fs=require("fs"),crypto=require("crypto");
const [file,start,end]=process.argv.slice(1);
const text=fs.readFileSync(file,"utf8").split(/\r?\n/).slice(Number(start)-1,Number(end)).join("\n");
console.log("sha256:"+crypto.createHash("sha256").update(text).digest("hex"));
' "$1" "$2" "$3"; }
# usage: hash_lines src/protocol/src/tours.ts 30 36
```

Steps (anchor targets; locate exact lines with `grep -n`):
1. **"The contract"** — `src/protocol/src/tours.ts`, the `Tour` interface declaration (grep `export interface Tour {` through its closing brace). Narration: `The protocol package is the only thing engine and clients share. A *tour* is the product's core artifact: steps anchored to real code, narration in markdown. Both sides depend on this contract — neither owns it.`
2. **"Pure domain"** — `src/engine/core/src/tours.ts`, the `parseTour` function signature line through the first JSON.parse block (grep `export function parseTour`). Narration: `engine-core never touches the filesystem or the transport — it validates and parses, nothing else. That keeps the domain testable in isolation and reusable under any transport.`
3. **"The process boundary"** — `src/engine/server/src/main.ts`, from `const connection =` through `connection.listen();`. Narration: `The engine ships as a *process*, not a library. stdio JSON-RPC means any IDE on any runtime can drive it — this is what makes the JetBrains client possible later. Note the shutdown contract comment: stdin EOF is the cleanup mechanism.`
4. **"The thin client"** — `src/clients/vscode/src/engineClient.ts`, the `require.resolve` + spawn lines (grep `require.resolve`). Narration: `The VS Code extension never imports engine code — it resolves the binary's path and spawns it. Clients depend only on the protocol; if a client needs engine data, the answer is a protocol addition, not an import.`
5. **"The rails you are on"** — `src/clients/vscode/src/walkController.ts`, the `createCommentThread` call. Narration: `This very narration thread is rendered by the code you are looking at. Each step opens a file, highlights the anchor, and pins the guide's voice under it — deterministic playback of a committed artifact, no agent required.`

Assemble `.hdtw/tours/monorepo-architecture.tour.json`:

```json
{
  "schemaVersion": 1,
  "id": "monorepo-architecture",
  "title": "Monorepo architecture",
  "summary": "How the engine, protocol, and clients fit together",
  "steps": [
    {
      "title": "The contract",
      "anchor": { "file": "src/protocol/src/tours.ts", "startLine": 0, "endLine": 0, "snippetHash": "sha256:FILL" },
      "narration": "The protocol package is the only thing engine and clients share. A *tour* is the product's core artifact: steps anchored to real code, narration in markdown. Both sides depend on this contract — neither owns it."
    },
    {
      "title": "Pure domain",
      "anchor": { "file": "src/engine/core/src/tours.ts", "startLine": 0, "endLine": 0, "snippetHash": "sha256:FILL" },
      "narration": "engine-core never touches the filesystem or the transport — it validates and parses, nothing else. That keeps the domain testable in isolation and reusable under any transport."
    },
    {
      "title": "The process boundary",
      "anchor": { "file": "src/engine/server/src/main.ts", "startLine": 0, "endLine": 0, "snippetHash": "sha256:FILL" },
      "narration": "The engine ships as a *process*, not a library. stdio JSON-RPC means any IDE on any runtime can drive it — this is what makes the JetBrains client possible later. Note the shutdown contract comment: stdin EOF is the cleanup mechanism."
    },
    {
      "title": "The thin client",
      "anchor": { "file": "src/clients/vscode/src/engineClient.ts", "startLine": 0, "endLine": 0, "snippetHash": "sha256:FILL" },
      "narration": "The VS Code extension never imports engine code — it resolves the binary's path and spawns it. Clients depend only on the protocol; if a client needs engine data, the answer is a protocol addition, not an import."
    },
    {
      "title": "The rails you are on",
      "anchor": { "file": "src/clients/vscode/src/walkController.ts", "startLine": 0, "endLine": 0, "snippetHash": "sha256:FILL" },
      "narration": "This very narration thread is rendered by the code you are looking at. Each step opens a file, highlights the anchor, and pins the guide's voice under it — deterministic playback of a committed artifact, no agent required."
    }
  ]
}
```

Replace every `startLine: 0, endLine: 0` with the real located lines and every `sha256:FILL` with the computed hash. The `0`/`FILL` values MUST NOT survive this step — the file must validate.

- [ ] **Step 2: Validate the dogfood tour with the engine itself**

```bash
node -e '
const { parseTour } = require("./src/engine/core/dist/index.js");
const fs = require("fs");
const text = fs.readFileSync(".hdtw/tours/monorepo-architecture.tour.json", "utf8");
const result = parseTour(text, "monorepo-architecture");
if (!result.ok) { console.error(result.errors); process.exit(1); }
console.log(`valid: ${result.tour.steps.length} steps`);
'
```

Expected: `valid: 5 steps`. (Run `pnpm build` first if `dist/` is stale.)

- [ ] **Step 3: Manual F5 verification**

1. Open the repo root in VS Code, press F5.
2. In the Extension Development Host: open the same repo folder, click the compass icon in the activity bar → "Tours" shows **Monorepo architecture · 5 steps**.
3. Click it: `src/protocol/src/tours.ts` opens with the `Tour` interface highlighted and the narration thread beneath; status bar shows `🧭 Monorepo architecture · 1/5`.
4. Use the thread's Next/Back/Exit buttons through all five steps; verify the thread collapses via its native collapse control; Exit clears highlight, thread, and status bar.
5. Negative checks: temporarily add `.hdtw/tours/bad.tour.json` containing `{"schemaVersion":2}` → refresh the tree → it appears with a warning icon, "invalid" description, tooltip showing the error, and cannot start. Delete it. Edit the dogfood tour's first `endLine` to `9999` → restart tour → step 1 shows the drift notice instead of a highlight and the walk continues. Restore it.

If executing headless: complete Steps 1–2, skip Step 3's click-through, and flag it for the human in your report.

- [ ] **Step 4: Update docs**

In `docs/product-roadmap.md`: change the Chunk 1 heading from `🔄 spec'd, next up` to `✅ shipped <today's date>`.

In `AGENTS.md` Current state, add after the runnable-skeleton bullet:

```markdown
- **Chunk 1 shipped — tour playback:** tours live in `.hdtw/tours/*.tour.json`; the engine serves `hdtw/listTours`/`hdtw/getTour`; the extension walks tours with inline narration threads. Dogfood tour: `.hdtw/tours/monorepo-architecture.tour.json` (plan: `docs/superpowers/plans/2026-06-12-chunk-1-rails-playback.md`).
```

- [ ] **Step 5: Full verification and commit**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: all green (23 tests).

```bash
git add .hdtw docs/product-roadmap.md AGENTS.md
git commit -m "feat: add dogfood architecture tour; mark chunk 1 shipped"
```
