# Code-Map Grounding (Chunk 4b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the generation agent a tree-sitter structural index (new `@made-i-t/hdtw-codemap` package) and add a self-healing **symbol-relative anchor** kind whose line range the engine resolves from a durable symbol identity.

**Architecture:** A new impure `hdtw-codemap` package parses TS/JS with `web-tree-sitter` (WASM) and exposes a pure `parseSymbols(content)` plus a thin fs facade. `engine-server` consumes it for (a) two read-only SDK MCP tools the agent calls during generation and (b) symbol→range resolution at verify/getTour/drift. `engine-core` stays pure — its symbol-anchor verify/drift branch operates on a range the server already resolved. The anchor schema gains an additive optional `symbol` field (no `schemaVersion` bump); the cached line fields keep playback engine-free.

**Tech Stack:** TypeScript (Node16 modules, `.js` import suffixes), pnpm workspaces + Turborepo, `web-tree-sitter` + `tree-sitter-wasms` (prebuilt TS/TSX grammars), Vitest, `@anthropic-ai/claude-agent-sdk` in-process MCP tools.

---

## File Structure

**New package `src/codemap/`** (`@made-i-t/hdtw-codemap`, CJS, mirrors `src/engine/core/` layout):

- `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint`-inherited
- `src/symbols.ts` — `Symbol`, `SymbolKind`, pure `parseSymbols(content, language)`
- `src/grammars.ts` — WASM grammar loading + registry, `languageForPath(path)`
- `src/index.ts` — fs facade `fileOutline(absPath)`, `findSymbol(absPath, name)`; re-exports
- `src/symbols.test.ts`, `src/index.test.ts`

**Modified:**

- `src/protocol/src/tours.ts` — add `symbol?` to `TourAnchor`
- `src/engine/core/src/anchors.ts` — `"symbol-missing"` freshness + `checkSymbolAnchorFreshness`
- `src/engine/server/src/symbolResolver.ts` _(new)_ — server-side resolve + path guard + tiebreak
- `src/engine/server/src/generationPipeline.ts` — `verifyStep` symbol branch
- `src/engine/server/src/tourHandlers.ts` — `getTour` re-resolution; drift symbol states
- `src/engine/server/src/codemapTools.ts` _(new)_ — in-process SDK MCP tools
- `src/engine/server/src/claudeTourGenerator.ts` — register tools + system-prompt rule
- `src/engine/server/src/fakeTourGenerator.ts` — symbol-anchor draft path
- `src/clients/vscode/src/driftBadge.ts` — `symbol-missing` badge
- `docs/product-roadmap.md` — mark 4b shipped

---

## Task 1: Spike — scaffold `hdtw-codemap` and lock the web-tree-sitter API

**Goal:** Prove `web-tree-sitter` init + TS grammar load + a query that yields symbol line ranges, on one fixture, before any real code depends on the API shape.

**Files:**

- Create: `src/codemap/package.json`, `src/codemap/tsconfig.json`, `src/codemap/vitest.config.ts`
- Create: `src/codemap/src/spike.test.ts` (temporary — deleted in Task 2)

- [ ] **Step 1: Create the package manifest**

`src/codemap/package.json`:

```json
{
  "name": "@made-i-t/hdtw-codemap",
  "version": "0.0.1",
  "private": true,
  "type": "commonjs",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "eslint src"
  },
  "dependencies": {
    "web-tree-sitter": "^0.25.0",
    "tree-sitter-wasms": "^0.1.11"
  },
  "devDependencies": {
    "@types/node": "^20.17.0",
    "typescript": "^5.8.3",
    "vitest": "^2.1.0"
  }
}
```

`src/codemap/tsconfig.json` (copy `src/engine/core/tsconfig.json` verbatim — same CJS Node16 settings):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

`src/codemap/vitest.config.ts` (copy `src/engine/core/vitest.config.ts`):

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 2: Install deps**

Run: `pnpm install`
Expected: `web-tree-sitter` and `tree-sitter-wasms` resolve and link into `src/codemap/node_modules`. If `tree-sitter-wasms@^0.1.11` is unavailable, run `pnpm --filter @made-i-t/hdtw-codemap add tree-sitter-wasms` to pin the latest and note the version in the commit message.

- [ ] **Step 3: Write the spike test that locks the API**

`src/codemap/src/spike.test.ts`:

```ts
import path from "node:path";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { Parser, Language } from "web-tree-sitter";

const require = createRequire(import.meta.url);

test("web-tree-sitter loads the TS grammar and reports symbol line ranges", async () => {
  await Parser.init();
  const parser = new Parser();
  // tree-sitter-wasms ships prebuilt grammars under its package dir.
  const wasmPath = path.join(
    path.dirname(require.resolve("tree-sitter-wasms/package.json")),
    "out",
    "tree-sitter-typescript.wasm",
  );
  const TS = await Language.load(wasmPath);
  parser.setLanguage(TS);

  const source = [
    "export function alpha() {",
    "  return 1;",
    "}",
    "",
    "class Beta {}",
  ].join("\n");
  const tree = parser.parse(source);
  const query = new Query(
    TS,
    "(function_declaration name: (identifier) @name) (class_declaration name: (type_identifier) @name)",
  );
  const captures = query.captures(tree.rootNode);
  const names = captures.map((c) => c.node.text);
  expect(names).toContain("alpha");
  expect(names).toContain("Beta");

  // Lock the line-range API: rows are 0-based; we will +1 for 1-based inclusive.
  const alpha = captures.find((c) => c.node.text === "alpha")!;
  const decl = alpha.node.parent!; // function_declaration
  expect(decl.startPosition.row + 1).toBe(1);
  expect(decl.endPosition.row + 1).toBe(3);
});
```

> **Implementer note:** `web-tree-sitter@0.25` exports named `Parser`, `Language`, and `Query` classes (ESM/CJS interop). If the installed version differs, adjust the imports/constructors here and record the exact working API in the commit body — every later task references `parseSymbols`, which wraps whatever this spike proves. If `new Query(Language, source)` is not the constructor in the installed version, use `TS.query(source)` and update Task 2 to match.

- [ ] **Step 4: Add the missing import and run the spike**

Add `Query` to the import in the spike test: `import { Parser, Language, Query } from "web-tree-sitter";`

Run: `pnpm --filter @made-i-t/hdtw-codemap test`
Expected: PASS — proving init, grammar load, captures, and the `row + 1` line convention. If it fails on the `Query` constructor, switch to `TS.query(...)` per the implementer note and re-run until green.

- [ ] **Step 5: Register the package in the workspace build and commit**

Confirm `pnpm-workspace.yaml` globs `src/*` (it already includes the other `src/**` packages — verify `@made-i-t/hdtw-codemap` appears in `pnpm install` output). Then:

```bash
git add src/codemap pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "feat(codemap): scaffold hdtw-codemap, lock web-tree-sitter API via spike"
```

---

## Task 2: Pure `parseSymbols(content, language)`

**Files:**

- Create: `src/codemap/src/symbols.ts`
- Create: `src/codemap/src/grammars.ts`
- Create: `src/codemap/src/symbols.test.ts`
- Delete: `src/codemap/src/spike.test.ts`

- [ ] **Step 1: Write the grammar loader**

`src/codemap/src/grammars.ts`:

```ts
import path from "node:path";
import { createRequire } from "node:module";
import { Parser, Language } from "web-tree-sitter";

const require = createRequire(import.meta.url);

export type CodemapLanguage = "ts" | "tsx";

const WASM_FILE: Record<CodemapLanguage, string> = {
  ts: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
};

const cache = new Map<CodemapLanguage, Promise<Language>>();
let initialized: Promise<void> | undefined;

/** Map a file path to a grammar, or undefined when unsupported. */
export function languageForPath(filePath: string): CodemapLanguage | undefined {
  if (filePath.endsWith(".tsx") || filePath.endsWith(".jsx")) return "tsx";
  if (
    filePath.endsWith(".ts")
    || filePath.endsWith(".mts")
    || filePath.endsWith(".cts")
  )
    return "ts";
  if (
    filePath.endsWith(".js")
    || filePath.endsWith(".mjs")
    || filePath.endsWith(".cjs")
  )
    return "ts";
  return undefined;
}

/** Load and cache a grammar Language; idempotent across calls. */
export async function loadLanguage(
  language: CodemapLanguage,
): Promise<Language> {
  initialized ??= Parser.init();
  await initialized;
  let pending = cache.get(language);
  if (!pending) {
    const wasmPath = path.join(
      path.dirname(require.resolve("tree-sitter-wasms/package.json")),
      "out",
      WASM_FILE[language],
    );
    pending = Language.load(wasmPath);
    cache.set(language, pending);
  }
  return pending;
}

export async function newParser(language: CodemapLanguage): Promise<Parser> {
  const lang = await loadLanguage(language);
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}
```

> **Implementer note:** if the Task 1 spike proved a different constructor/import, mirror it here exactly.

- [ ] **Step 2: Write the failing test for `parseSymbols`**

`src/codemap/src/symbols.test.ts`:

```ts
import { expect, test } from "vitest";
import { parseSymbols } from "./symbols.js";

test("parseSymbols finds top-level functions, classes, methods, and exported consts with 1-based inclusive ranges", async () => {
  const source = [
    "export function alpha() {", //1
    "  return 1;", //2
    "}", //3
    "", //4
    "export class Beta {", //5
    "  gamma() {", //6
    "    return 2;", //7
    "  }", //8
    "}", //9
    "", //10
    "export const delta = 3;", //11
  ].join("\n");

  const symbols = await parseSymbols(source, "ts");
  const byName = (n: string) => symbols.find((s) => s.name === n);

  expect(byName("alpha")).toMatchObject({
    kind: "function",
    startLine: 1,
    endLine: 3,
  });
  expect(byName("Beta")).toMatchObject({
    kind: "class",
    startLine: 5,
    endLine: 9,
  });
  expect(byName("gamma")).toMatchObject({
    kind: "method",
    startLine: 6,
    endLine: 8,
    qualifiedName: "Beta.gamma",
  });
  expect(byName("delta")).toMatchObject({
    kind: "const",
    startLine: 11,
    endLine: 11,
  });
});

test("parseSymbols disambiguates duplicate method names by qualifiedName", async () => {
  const source = [
    "class A { run() { return 1; } }",
    "class B { run() { return 2; } }",
  ].join("\n");
  const symbols = await parseSymbols(source, "ts");
  const runs = symbols.filter((s) => s.name === "run");
  expect(runs.map((s) => s.qualifiedName).sort()).toEqual(["A.run", "B.run"]);
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm --filter @made-i-t/hdtw-codemap test`
Expected: FAIL — `parseSymbols` not defined.

- [ ] **Step 4: Implement `parseSymbols`**

`src/codemap/src/symbols.ts`:

```ts
import { Query } from "web-tree-sitter";
import { loadLanguage, newParser, type CodemapLanguage } from "./grammars.js";

export type SymbolKind =
  "function" | "method" | "class" | "interface" | "const" | "enum" | "type";

export interface CodeSymbol {
  name: string;
  /** Enclosing-scope-qualified, e.g. "ClassName.method" or top-level "name". */
  qualifiedName: string;
  kind: SymbolKind;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
}

// Capture the named declarations we anchor to. The @name capture identifies the
// symbol; its parent declaration node gives the full line range.
const QUERY_SOURCE = `
(function_declaration name: (identifier) @function)
(class_declaration name: (type_identifier) @class)
(interface_declaration name: (type_identifier) @interface)
(enum_declaration name: (identifier) @enum)
(type_alias_declaration name: (type_identifier) @type)
(method_definition name: (property_identifier) @method)
(public_field_definition name: (property_identifier) @field)
(lexical_declaration (variable_declarator name: (identifier) @const))
`;

const CAPTURE_KIND: Record<string, SymbolKind> = {
  function: "function",
  class: "class",
  interface: "interface",
  enum: "enum",
  type: "type",
  method: "method",
  field: "method",
  const: "const",
};

/** Pure: parse source text into the named symbols we can anchor to. */
export async function parseSymbols(
  content: string,
  language: CodemapLanguage,
): Promise<CodeSymbol[]> {
  const lang = await loadLanguage(language);
  const parser = await newParser(language);
  const tree = parser.parse(content);
  const query = new Query(lang, QUERY_SOURCE);
  const symbols: CodeSymbol[] = [];

  for (const capture of query.captures(tree.rootNode)) {
    const kind = CAPTURE_KIND[capture.name];
    if (!kind) continue;
    const nameNode = capture.node;
    // The declaration node is the nearest ancestor that owns the full construct.
    const declaration = declarationFor(capture.name, nameNode);
    if (!declaration) continue;
    const name = nameNode.text;
    symbols.push({
      name,
      qualifiedName: qualify(name, declaration),
      kind,
      startLine: declaration.startPosition.row + 1,
      endLine: declaration.endPosition.row + 1,
    });
  }
  return symbols;
}

function declarationFor(capture: string, nameNode: { parent: unknown }) {
  // For const, the declaration is the lexical_declaration (grandparent of the
  // identifier through variable_declarator); for others, the name's parent.
  const node = nameNode as unknown as TsNode;
  if (capture === "const") {
    return node.parent?.parent ?? node.parent ?? undefined;
  }
  return node.parent ?? undefined;
}

function qualify(name: string, declaration: TsNode): string {
  // Walk up to an enclosing class/interface to build "Owner.name".
  let cursor: TsNode | null = declaration.parent ?? null;
  while (cursor) {
    if (
      cursor.type === "class_declaration"
      || cursor.type === "interface_declaration"
    ) {
      const owner = ownerName(cursor);
      if (owner) return `${owner}.${name}`;
      break;
    }
    cursor = cursor.parent ?? null;
  }
  return name;
}

function ownerName(classNode: TsNode): string | undefined {
  for (const child of classNode.namedChildren) {
    if (child.type === "type_identifier" || child.type === "identifier") {
      return child.text;
    }
  }
  return undefined;
}

// Minimal structural type for the tree-sitter nodes we touch (avoids `any`).
interface TsNode {
  type: string;
  text: string;
  parent: TsNode | null;
  namedChildren: TsNode[];
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
}
```

> **Implementer note:** node-type names (`function_declaration`, `type_identifier`, `lexical_declaration`, `method_definition`, `public_field_definition`) are from the tree-sitter-typescript grammar. If a capture yields nothing in the test, inspect `tree.rootNode.toString()` for the real node types in the installed grammar and adjust `QUERY_SOURCE`. Keep the public `CodeSymbol` shape unchanged.

- [ ] **Step 5: Run the tests, delete the spike**

Run: `pnpm --filter @made-i-t/hdtw-codemap test`
Expected: PASS (both tests). Then `rm src/codemap/src/spike.test.ts`.

- [ ] **Step 6: Build + lint + commit**

Run: `pnpm --filter @made-i-t/hdtw-codemap build && pnpm --filter @made-i-t/hdtw-codemap lint`
Expected: clean.

```bash
git add src/codemap
git commit -m "feat(codemap): pure parseSymbols over TS/JS via tree-sitter"
```

---

## Task 3: fs facade — `fileOutline` and `findSymbol`

**Files:**

- Create: `src/codemap/src/index.ts`
- Create: `src/codemap/src/index.test.ts`

- [ ] **Step 1: Write the failing test**

`src/codemap/src/index.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { fileOutline, findSymbol } from "./index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "codemap-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(name: string, content: string): Promise<string> {
  const p = path.join(dir, name);
  await writeFile(p, content);
  return p;
}

test("fileOutline lists symbols; unsupported extension yields []", async () => {
  const p = await write("a.ts", "export function alpha() { return 1; }\n");
  const outline = await fileOutline(p);
  expect(outline.map((s) => s.name)).toContain("alpha");

  const md = await write("readme.md", "# hi\n");
  expect(await fileOutline(md)).toEqual([]);
});

test("findSymbol resolves a unique name, flags ambiguity, and reports not-found", async () => {
  const p = await write(
    "b.ts",
    [
      "export function only() {}",
      "class A { dup() {} }",
      "class B { dup() {} }",
    ].join("\n"),
  );
  expect(await findSymbol(p, "only")).toMatchObject({
    ok: true,
    symbol: { name: "only" },
  });
  expect(await findSymbol(p, "dup")).toMatchObject({ ok: "ambiguous" });
  // qualifiedName resolves uniquely
  expect(await findSymbol(p, "A.dup")).toMatchObject({
    ok: true,
    symbol: { qualifiedName: "A.dup" },
  });
  expect(await findSymbol(p, "missing")).toEqual({ ok: false });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @made-i-t/hdtw-codemap test`
Expected: FAIL — module `./index.js` has no `fileOutline`/`findSymbol`.

- [ ] **Step 3: Implement the facade**

`src/codemap/src/index.ts`:

```ts
import { readFile } from "node:fs/promises";
import { parseSymbols, type CodeSymbol } from "./symbols.js";
import { languageForPath } from "./grammars.js";

export type { CodeSymbol, SymbolKind } from "./symbols.js";
export { languageForPath } from "./grammars.js";

export type FindSymbolResult =
  | { ok: true; symbol: CodeSymbol }
  | { ok: "ambiguous"; candidates: CodeSymbol[] }
  | { ok: false };

/** Parse a file into its symbols. Returns [] for unsupported file types. */
export async function fileOutline(absolutePath: string): Promise<CodeSymbol[]> {
  const language = languageForPath(absolutePath);
  if (!language) return [];
  const content = await readFile(absolutePath, "utf8");
  return parseSymbols(content, language);
}

/** Resolve a symbol by name or qualifiedName. */
export async function findSymbol(
  absolutePath: string,
  name: string,
): Promise<FindSymbolResult> {
  const symbols = await fileOutline(absolutePath);
  const matches = symbols.filter(
    (s) => s.name === name || s.qualifiedName === name,
  );
  if (matches.length === 0) return { ok: false };
  if (matches.length === 1) return { ok: true, symbol: matches[0] };
  // Exact qualifiedName match wins over bare-name collisions.
  const exact = matches.filter((s) => s.qualifiedName === name);
  if (exact.length === 1) return { ok: true, symbol: exact[0] };
  return { ok: "ambiguous", candidates: matches };
}
```

- [ ] **Step 4: Run tests, build, lint**

Run: `pnpm --filter @made-i-t/hdtw-codemap test && pnpm --filter @made-i-t/hdtw-codemap build && pnpm --filter @made-i-t/hdtw-codemap lint`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/codemap
git commit -m "feat(codemap): fs facade fileOutline + findSymbol with ambiguity"
```

---

## Task 4: Protocol — additive `symbol` field on the anchor

**Files:**

- Modify: `src/protocol/src/tours.ts` (the `TourAnchor` interface shown above)
- Test: `src/protocol/src/tours.test.ts` (or the existing protocol test file)

- [ ] **Step 1: Add the field**

In `src/protocol/src/tours.ts`, change `TourAnchor` to:

```ts
export interface TourAnchor {
  /** Workspace-root-relative path, POSIX separators. */
  file: string;
  /** 1-based, inclusive. For a symbol-anchor this is the engine-maintained cache. */
  startLine: number;
  /** 1-based, inclusive; >= startLine. */
  endLine: number;
  /** "sha256:<hex>" of the anchored text at last resolution (drift detection). */
  snippetHash: string;
  /**
   * When present, this is a SYMBOL-ANCHOR: `symbol` is the durable identity
   * (qualifiedName or bare name) and the line fields above are a cache the engine
   * refreshes by re-resolving the symbol. Absent = classic line-anchor. Additive.
   */
  symbol?: string;
}
```

- [ ] **Step 2: Add a type-level test**

Append to the existing protocol test file (find it: `ls src/protocol/src/*.test.ts`). Add:

```ts
import { test, expect } from "vitest";
import type { TourAnchor } from "./tours.js";

test("TourAnchor accepts an optional symbol (symbol-anchor) without breaking line-anchors", () => {
  const lineAnchor: TourAnchor = {
    file: "a.ts",
    startLine: 1,
    endLine: 2,
    snippetHash: "sha256:x",
  };
  const symbolAnchor: TourAnchor = {
    file: "a.ts",
    startLine: 1,
    endLine: 2,
    snippetHash: "sha256:x",
    symbol: "alpha",
  };
  expect(symbolAnchor.symbol).toBe("alpha");
  expect((lineAnchor as TourAnchor).symbol).toBeUndefined();
});
```

- [ ] **Step 3: Build + test + commit**

Run: `pnpm --filter @made-i-t/hdtw-protocol build && pnpm --filter @made-i-t/hdtw-protocol test`
Expected: PASS.

```bash
git add src/protocol/src/tours.ts src/protocol/src/*.test.ts
git commit -m "feat(protocol): additive symbol field on TourAnchor (symbol-anchors)"
```

---

## Task 5: engine-core — `symbol-missing` freshness + symbol-anchor branch (pure)

**Files:**

- Modify: `src/engine/core/src/anchors.ts`
- Test: `src/engine/core/src/anchors.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/engine/core/src/anchors.test.ts`:

```ts
import { checkSymbolAnchorFreshness } from "./anchors.js";

test("checkSymbolAnchorFreshness: resolved range hash match = fresh, mismatch = relocated, no range = symbol-missing", () => {
  const file = ["function a() {", "  return 1;", "}"].join("\n");
  const hash = computeSnippetHash("function a() {\n  return 1;\n}");

  // resolved to the same lines, hash matches -> fresh
  expect(
    checkSymbolAnchorFreshness(
      { snippetHash: hash },
      { startLine: 1, endLine: 3 },
      file,
    ),
  ).toEqual({ state: "fresh", startLine: 1, endLine: 3, snippetHash: hash });

  // resolved to a new range whose content differs from the cached hash -> relocated (cache refreshed)
  const moved = ["", "", "function a() {", "  return 1;", "}"].join("\n");
  const result = checkSymbolAnchorFreshness(
    { snippetHash: hash },
    { startLine: 3, endLine: 5 },
    moved,
  );
  expect(result.state).toBe("relocated");
  expect(result).toMatchObject({ startLine: 3, endLine: 5 });

  // symbol did not resolve -> symbol-missing
  expect(
    checkSymbolAnchorFreshness({ snippetHash: hash }, undefined, file),
  ).toEqual({
    state: "symbol-missing",
  });
});
```

> Note: `computeSnippetHash` is already imported at the top of this test file (used by existing tests). If not, add `import { computeSnippetHash } from "./anchors.js";`.

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @made-i-t/hdtw-engine-core test`
Expected: FAIL — `checkSymbolAnchorFreshness` not defined.

- [ ] **Step 3: Implement the pure branch**

In `src/engine/core/src/anchors.ts`, extend the freshness type and add the function. After the existing `AnchorFreshness` type add:

```ts
/** A range the server resolved for a symbol-anchor; undefined when the symbol is gone. */
export interface ResolvedRange {
  startLine: number;
  endLine: number;
}

export type SymbolFreshness =
  | { state: "fresh"; startLine: number; endLine: number; snippetHash: string }
  | {
      state: "relocated";
      startLine: number;
      endLine: number;
      snippetHash: string;
    }
  | { state: "symbol-missing" };

/**
 * Freshness for a symbol-anchor, given the range the server resolved from the
 * code-map. Pure — never touches tree-sitter or fs. `resolved === undefined`
 * means the symbol no longer exists.
 */
export function checkSymbolAnchorFreshness(
  anchor: { snippetHash: string },
  resolved: ResolvedRange | undefined,
  fileContent: string,
): SymbolFreshness {
  if (!resolved) {
    return { state: "symbol-missing" };
  }
  const snippetHash = computeSnippetHash(
    extractAnchoredText(fileContent, resolved.startLine, resolved.endLine),
  );
  const state = snippetHash === anchor.snippetHash ? "fresh" : "relocated";
  return {
    state,
    startLine: resolved.startLine,
    endLine: resolved.endLine,
    snippetHash,
  };
}
```

- [ ] **Step 4: Run tests, build, lint**

Run: `pnpm --filter @made-i-t/hdtw-engine-core test && pnpm --filter @made-i-t/hdtw-engine-core build && pnpm --filter @made-i-t/hdtw-engine-core lint`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/engine/core/src/anchors.ts src/engine/core/src/anchors.test.ts
git commit -m "feat(engine-core): pure symbol-anchor freshness (fresh/relocated/symbol-missing)"
```

---

## Task 6: engine-server — `SymbolResolver` (codemap + path guard + tiebreak)

**Files:**

- Create: `src/engine/server/src/symbolResolver.ts`
- Test: `src/engine/server/src/symbolResolver.test.ts`
- Add dependency: `@made-i-t/hdtw-codemap` to `src/engine/server/package.json`

- [ ] **Step 1: Add the workspace dependency**

In `src/engine/server/package.json` `dependencies`, add:

```json
    "@made-i-t/hdtw-codemap": "workspace:*",
```

Run: `pnpm install`
Expected: links the workspace package.

- [ ] **Step 2: Write the failing test**

`src/engine/server/src/symbolResolver.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { resolveSymbol } from "./symbolResolver.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "resolver-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("resolveSymbol returns a range, picks nearest-to-cache on ambiguity, and guards path traversal", async () => {
  await writeFile(
    path.join(root, "a.ts"),
    ["class A { dup() { return 1; } }", "class B { dup() { return 2; } }"].join(
      "\n",
    ),
  );
  // unique
  expect(await resolveSymbol(root, "a.ts", "A.dup", undefined)).toMatchObject({
    kind: "resolved",
    startLine: 1,
    endLine: 1,
  });
  // ambiguous bare name, nearest to cached line 2 -> the B.dup on line 2
  expect(
    await resolveSymbol(root, "a.ts", "dup", { startLine: 2, endLine: 2 }),
  ).toMatchObject({
    kind: "resolved",
    startLine: 2,
  });
  // missing symbol
  expect(await resolveSymbol(root, "a.ts", "nope", undefined)).toEqual({
    kind: "missing",
  });
  // missing file
  expect(await resolveSymbol(root, "ghost.ts", "x", undefined)).toEqual({
    kind: "file-missing",
  });
  // path traversal is refused
  expect(await resolveSymbol(root, "../escape.ts", "x", undefined)).toEqual({
    kind: "file-missing",
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: FAIL — `resolveSymbol` not defined.

- [ ] **Step 4: Implement the resolver**

`src/engine/server/src/symbolResolver.ts`:

```ts
import path from "node:path";
import { fileOutline, type CodeSymbol } from "@made-i-t/hdtw-codemap";

export type ResolveSymbolResult =
  | { kind: "resolved"; startLine: number; endLine: number; symbol: CodeSymbol }
  | { kind: "missing" }
  | { kind: "ambiguous"; candidates: CodeSymbol[] }
  | { kind: "file-missing" };

/**
 * Resolve a symbol to a current line range. Reuses Chunk 2's path-traversal
 * guard. On ambiguity, if a cached range is provided, pick the candidate whose
 * start is nearest the cache; otherwise report ambiguous.
 */
export async function resolveSymbol(
  workspaceRoot: string,
  file: string,
  symbol: string,
  cached: { startLine: number; endLine: number } | undefined,
): Promise<ResolveSymbolResult> {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolved = path.resolve(resolvedRoot, ...file.split("/"));
  if (
    resolved !== resolvedRoot
    && !resolved.startsWith(resolvedRoot + path.sep)
  ) {
    return { kind: "file-missing" };
  }

  let symbols: CodeSymbol[];
  try {
    symbols = await fileOutline(resolved);
  } catch {
    return { kind: "file-missing" };
  }

  const matches = symbols.filter(
    (s) => s.name === symbol || s.qualifiedName === symbol,
  );
  const exact = matches.filter((s) => s.qualifiedName === symbol);
  const pool = exact.length > 0 ? exact : matches;

  if (pool.length === 0) return { kind: "missing" };
  let chosen: CodeSymbol;
  if (pool.length === 1) {
    chosen = pool[0];
  } else if (cached) {
    chosen = pool.reduce((best, s) =>
      Math.abs(s.startLine - cached.startLine)
      < Math.abs(best.startLine - cached.startLine)
        ? s
        : best,
    );
  } else {
    return { kind: "ambiguous", candidates: pool };
  }
  return {
    kind: "resolved",
    startLine: chosen.startLine,
    endLine: chosen.endLine,
    symbol: chosen,
  };
}
```

- [ ] **Step 5: Run tests, build, lint, commit**

Run: `pnpm --filter @made-i-t/hdtw-engine-server test && pnpm --filter @made-i-t/hdtw-engine-server build && pnpm --filter @made-i-t/hdtw-engine-server lint`
Expected: green.

```bash
git add src/engine/server/src/symbolResolver.ts src/engine/server/src/symbolResolver.test.ts src/engine/server/package.json pnpm-lock.yaml
git commit -m "feat(engine-server): SymbolResolver with path guard and nearest-cache tiebreak"
```

---

## Task 7: engine-server — `verifyStep` resolves symbol-anchors

**Context:** `verifyStep` in `src/engine/server/src/generationPipeline.ts` currently (see lines ~197-218) resolves a path, reads the file, runs `verifyAnchor`, and returns `{ title, narration, anchor: {...snippetHash} }` or an error string. A draft symbol-anchor arrives as `{ file, symbol }` with no line numbers; the engine must resolve symbol→range, then verify and fill the cache.

**Files:**

- Modify: `src/engine/server/src/generationPipeline.ts` (`verifyStep`, and the `DraftStep` anchor type in `tourGenerator.ts`)
- Test: `src/engine/server/src/generationPipeline.test.ts` (create if absent) or extend an existing pipeline test

- [ ] **Step 1: Allow a symbol on the draft anchor type**

In `src/engine/server/src/tourGenerator.ts`, find the `DraftStep`/draft anchor type. Add an optional `symbol?: string` and make `startLine`/`endLine` optional on the DRAFT anchor only (the agent may omit them for a symbol-anchor):

```ts
export interface DraftAnchor {
  file: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
}
```

(If the draft anchor is currently inlined in `DraftStep`, extract it to `DraftAnchor` and reference it.)

- [ ] **Step 2: Write the failing test**

Create `src/engine/server/src/generationPipeline.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { verifyStep } from "./generationPipeline.js";
import { computeSnippetHash } from "@made-i-t/hdtw-engine-core";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "verify-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("verifyStep resolves a symbol-anchor to a range, fills the cache, and keeps the symbol", async () => {
  await writeFile(
    path.join(root, "a.ts"),
    ["export function alpha() {", "  return 1;", "}"].join("\n"),
  );
  const step = {
    title: "t",
    narration: "n",
    anchor: { file: "a.ts", symbol: "alpha" },
  };
  const verified = await verifyStep(root, step);
  expect(typeof verified).not.toBe("string");
  expect(verified).toMatchObject({
    anchor: { file: "a.ts", symbol: "alpha", startLine: 1, endLine: 3 },
  });
  expect(
    (verified as { anchor: { snippetHash: string } }).anchor.snippetHash,
  ).toBe(computeSnippetHash("export function alpha() {\n  return 1;\n}"));
});

test("verifyStep returns an error string when the symbol is missing", async () => {
  await writeFile(path.join(root, "a.ts"), "export function alpha() {}\n");
  const step = {
    title: "t",
    narration: "n",
    anchor: { file: "a.ts", symbol: "ghost" },
  };
  expect(typeof (await verifyStep(root, step))).toBe("string");
});
```

> **Implementer note:** if `verifyStep` is not currently exported, export it. It is the natural unit seam here.

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: FAIL — symbol branch not handled (resolves as a normal path / undefined lines).

- [ ] **Step 4: Implement the symbol branch in `verifyStep`**

In `src/engine/server/src/generationPipeline.ts`, import the resolver and branch at the top of `verifyStep`:

```ts
import { resolveSymbol } from "./symbolResolver.js";
```

Replace the body of `verifyStep` so a symbol-anchor is resolved first:

```ts
async function verifyStep(
  workspaceRoot: string,
  step: DraftStep,
): Promise<TourStep | string> {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolved = path.resolve(resolvedRoot, ...step.anchor.file.split("/"));
  if (
    resolved !== resolvedRoot
    && !resolved.startsWith(resolvedRoot + path.sep)
  ) {
    return `${step.anchor.file}: anchor path escapes the workspace`;
  }
  let fileContent: string;
  try {
    fileContent = await readFile(resolved, "utf8");
  } catch {
    return `${step.anchor.file}: file does not exist in the workspace`;
  }

  // Symbol-anchor: resolve the symbol to a range, then verify that range.
  if (step.anchor.symbol) {
    const r = await resolveSymbol(
      workspaceRoot,
      step.anchor.file,
      step.anchor.symbol,
      undefined,
    );
    if (r.kind === "missing")
      return `${step.anchor.file}: symbol "${step.anchor.symbol}" not found`;
    if (r.kind === "file-missing")
      return `${step.anchor.file}: file does not exist in the workspace`;
    if (r.kind === "ambiguous") {
      const names = r.candidates.map((c) => c.qualifiedName).join(", ");
      return `${step.anchor.file}: symbol "${step.anchor.symbol}" is ambiguous (use one of: ${names})`;
    }
    const verification = verifyAnchor(
      { file: step.anchor.file, startLine: r.startLine, endLine: r.endLine },
      fileContent,
    );
    if (!verification.ok) return verification.errors.join("; ");
    return {
      title: step.title,
      narration: step.narration,
      anchor: {
        file: step.anchor.file,
        symbol: step.anchor.symbol,
        startLine: r.startLine,
        endLine: r.endLine,
        snippetHash: verification.snippetHash,
      },
    };
  }

  // Line-anchor (unchanged behavior).
  if (
    step.anchor.startLine === undefined
    || step.anchor.endLine === undefined
  ) {
    return `${step.anchor.file}: line-anchor missing startLine/endLine`;
  }
  const verification = verifyAnchor(
    {
      file: step.anchor.file,
      startLine: step.anchor.startLine,
      endLine: step.anchor.endLine,
    },
    fileContent,
  );
  if (!verification.ok) {
    return verification.errors.join("; ");
  }
  return {
    title: step.title,
    narration: step.narration,
    anchor: {
      file: step.anchor.file,
      startLine: step.anchor.startLine,
      endLine: step.anchor.endLine,
      snippetHash: verification.snippetHash,
    },
  };
}
```

> Preserve the existing `relatedTours` handling that wraps `verifyStep`'s result in `verifyDraft` — it is unchanged and lives in the caller, not here.

- [ ] **Step 5: Run tests, build, lint, commit**

Run: `pnpm --filter @made-i-t/hdtw-engine-server test && pnpm --filter @made-i-t/hdtw-engine-server build && pnpm --filter @made-i-t/hdtw-engine-server lint`
Expected: green (existing line-anchor tests still pass; two new symbol tests pass).

```bash
git add src/engine/server/src/generationPipeline.ts src/engine/server/src/tourGenerator.ts src/engine/server/src/generationPipeline.test.ts
git commit -m "feat(engine-server): verifyStep resolves and caches symbol-anchors"
```

---

## Task 8: engine-server — getTour re-resolution + drift `symbol-missing`/`relocated`

**Context:** `src/engine/server/src/tourHandlers.ts` holds `getTour` and `checkTourDrift`. Symbol-anchors must (a) re-resolve on `getTour` so a live walk highlights the current range, and (b) report `relocated`/`symbol-missing` in drift.

**Files:**

- Modify: `src/engine/server/src/tourHandlers.ts`
- Test: `src/engine/server/tests/drift.e2e.test.ts` (extend) or a new unit test on the drift helper

- [ ] **Step 1: Write the failing test**

Add to `src/engine/server/tests/drift.e2e.test.ts` (it already spawns the server + writes fixtures; mirror its setup). Add a case:

```ts
test("a symbol-anchor self-heals: moving code reports relocated, deleting the symbol reports symbol-missing", async () => {
  // ... using the same harness: write a source file with `function target(){...}`,
  // write a tour whose step anchor is { file, symbol: "target", startLine, endLine, snippetHash }
  // matching the ORIGINAL location, then:
  // 1) prepend blank lines to the source, call hdtw/checkTourDrift -> expect that step's
  //    state === "relocated" with the new startLine.
  // 2) delete the function from the source, call again -> expect state === "symbol-missing".
});
```

> **Implementer note:** follow the exact request/notification shapes already used in this file for `checkTourDrift`. Reuse its helper(s) for spawning and sending requests. Fill in the fixture bodies concretely (do not leave the `// ...`): a 3-line `target` function, a tour JSON with one symbol-anchored step, and two `checkTourDrift` calls.

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: FAIL — drift treats the symbol-anchor as a line-anchor (reports `drifted`, not `relocated`).

- [ ] **Step 3: Implement re-resolution in drift + getTour**

In `tourHandlers.ts`, where each step's drift state is computed, branch on `anchor.symbol`:

```ts
import { resolveSymbol } from "./symbolResolver.js";
import {
  checkSymbolAnchorFreshness,
  checkAnchorFreshness,
} from "@made-i-t/hdtw-engine-core";

// inside the per-step drift computation, given `fileContent` (or undefined if unreadable):
async function stepDriftState(workspaceRoot, anchor, fileContent) {
  if (fileContent === undefined) return { state: "file-missing" };
  if (anchor.symbol) {
    const r = await resolveSymbol(workspaceRoot, anchor.file, anchor.symbol, {
      startLine: anchor.startLine,
      endLine: anchor.endLine,
    });
    if (r.kind === "file-missing") return { state: "file-missing" };
    const resolved =
      r.kind === "resolved"
        ? { startLine: r.startLine, endLine: r.endLine }
        : undefined;
    return checkSymbolAnchorFreshness(anchor, resolved, fileContent);
  }
  return { state: checkAnchorFreshness(anchor, fileContent) };
}
```

Normalize the two shapes (`checkAnchorFreshness` returns a string; `checkSymbolAnchorFreshness` returns an object) into the drift-state payload the handler already sends — keep the wire field names identical to today, adding `relocated` and `symbol-missing` as new possible `state` values, and include the refreshed `startLine`/`endLine`/`snippetHash` when `relocated`.

For `getTour`: after loading+validating the tour, map symbol-anchored steps through `resolveSymbol`; when `kind === "resolved"`, replace the served anchor's `startLine`/`endLine` (and recompute `snippetHash` from the resolved range) so the client highlights the live location. On `missing`/`file-missing`, serve the cached range unchanged (the walk still works; drift surfaces the problem separately).

> **Implementer note:** keep `getTour` resolution best-effort and non-throwing — a resolution failure must never make `getTour` fail. Parse the source once per file; cache within the single `getTour` call.

- [ ] **Step 4: Run tests, build, lint, commit**

Run: `pnpm --filter @made-i-t/hdtw-engine-server test && pnpm --filter @made-i-t/hdtw-engine-server build && pnpm --filter @made-i-t/hdtw-engine-server lint`
Expected: green.

```bash
git add src/engine/server/src/tourHandlers.ts src/engine/server/tests/drift.e2e.test.ts
git commit -m "feat(engine-server): symbol-anchor self-heal in getTour + drift (relocated/symbol-missing)"
```

---

## Task 9: engine-server — code-map agent tools + system prompt + fake path

**Files:**

- Create: `src/engine/server/src/codemapTools.ts`
- Modify: `src/engine/server/src/claudeTourGenerator.ts` (register tools + prompt rule)
- Modify: `src/engine/server/src/fakeTourGenerator.ts` (emit a symbol-anchor)
- Test: `src/engine/server/src/codemapTools.test.ts`; extend `src/engine/server/tests/generation.e2e.test.ts`

- [ ] **Step 1: Write the failing test for the tool handlers**

`src/engine/server/src/codemapTools.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runFileOutlineTool, runFindSymbolTool } from "./codemapTools.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "tools-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("fileOutline tool lists symbols; findSymbol returns a range; path traversal is refused", async () => {
  await writeFile(
    path.join(root, "a.ts"),
    "export function alpha() { return 1; }\n",
  );
  const outline = await runFileOutlineTool(root, "a.ts");
  expect(outline).toContain("alpha");
  const found = await runFindSymbolTool(root, "a.ts", "alpha");
  expect(found).toMatch(/1-1|startLine/);
  const escaped = await runFindSymbolTool(root, "../x.ts", "alpha");
  expect(escaped.toLowerCase()).toContain("outside the workspace");
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tool helpers + the SDK MCP server**

`src/engine/server/src/codemapTools.ts`:

```ts
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { fileOutline, findSymbol } from "@made-i-t/hdtw-codemap";

function guard(workspaceRoot: string, file: string): string | undefined {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, ...file.split("/"));
  if (resolved !== root && !resolved.startsWith(root + path.sep))
    return undefined;
  return resolved;
}

/** Returned as plain text the agent reads. */
export async function runFileOutlineTool(
  workspaceRoot: string,
  file: string,
): Promise<string> {
  const resolved = guard(workspaceRoot, file);
  if (!resolved) return `Error: ${file} is outside the workspace.`;
  const symbols = await fileOutline(resolved);
  if (symbols.length === 0)
    return `No symbols found in ${file} (unsupported type or empty).`;
  return symbols
    .map(
      (s) => `${s.qualifiedName} (${s.kind}) lines ${s.startLine}-${s.endLine}`,
    )
    .join("\n");
}

export async function runFindSymbolTool(
  workspaceRoot: string,
  file: string,
  name: string,
): Promise<string> {
  const resolved = guard(workspaceRoot, file);
  if (!resolved) return `Error: ${file} is outside the workspace.`;
  const result = await findSymbol(resolved, name);
  if (result.ok === false) return `Symbol "${name}" not found in ${file}.`;
  if (result.ok === "ambiguous") {
    return `Symbol "${name}" is ambiguous in ${file}. Qualify with one of: ${result.candidates
      .map((c) => c.qualifiedName)
      .join(", ")}.`;
  }
  const s = result.symbol;
  return `${s.qualifiedName} (${s.kind}) lines ${s.startLine}-${s.endLine}. Anchor with symbol="${s.qualifiedName}".`;
}

/** In-process MCP server exposing the read-only code-map tools to the agent. */
export function createCodemapMcpServer(workspaceRoot: string) {
  return createSdkMcpServer({
    name: "codemap",
    version: "1.0.0",
    tools: [
      tool(
        "fileOutline",
        "List the named symbols (functions, classes, methods, consts) in a TS/JS file with their line ranges.",
        {
          file: z.string()
                 .describe("Workspace-relative path, POSIX separators."),
        },
        async (args) => ({
          content: [
            {
              type: "text",
              text: await runFileOutlineTool(workspaceRoot, args.file),
            },
          ],
        }),
      ),
      tool(
        "findSymbol",
        "Find a symbol by name (or Class.method) in a TS/JS file and get its current line range to anchor to.",
        { file: z.string(), name: z.string() },
        async (args) => ({
          content: [
            {
              type: "text",
              text: await runFindSymbolTool(
                workspaceRoot,
                args.file,
                args.name,
              ),
            },
          ],
        }),
      ),
    ],
  });
}
```

> **Implementer note:** confirm `createSdkMcpServer`/`tool` are exported by the installed `@anthropic-ai/claude-agent-sdk` (they are the documented in-process tool API). If `zod` is not already a dependency, add it (`pnpm --filter @made-i-t/hdtw-engine-server add zod`). The MCP tool names become `mcp__codemap__fileOutline` / `mcp__codemap__findSymbol` in the allowlist — see Step 5.

- [ ] **Step 4: Run the handler test**

Run: `pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: PASS for `codemapTools.test.ts`.

- [ ] **Step 5: Register the tools + prompt rule in `claudeTourGenerator`**

In `src/engine/server/src/claudeTourGenerator.ts` `runQuery`, build the server and extend options:

```ts
import { createCodemapMcpServer } from "./codemapTools.js";
// ...
const codemap = createCodemapMcpServer(workspaceRoot);
const response = query({
  prompt,
  options: {
    cwd: workspaceRoot,
    model,
    maxTurns,
    tools: [
      "Read",
      "Grep",
      "Glob",
      "mcp__codemap__fileOutline",
      "mcp__codemap__findSymbol",
    ],
    mcpServers: { codemap },
    systemPrompt: SYSTEM_PROMPT,
    abortController,
  },
});
```

Add to `SYSTEM_PROMPT` (after the anchor rules) — and update the JSON shape note so the agent knows it may emit `symbol`:

```
Prefer a SYMBOL-ANCHOR when the code you are anchoring is a whole named declaration
(function, class, method, exported const): use findSymbol to confirm it exists, then
emit the anchor as { "file": "relative/path.ts", "symbol": "Name" } (or "Class.method")
WITHOUT line numbers — the engine resolves and tracks it as code evolves. Use a
line-anchor { "file", "startLine", "endLine" } only for a sub-region that is not a
single named symbol.
```

- [ ] **Step 6: Make the fake generator emit a symbol-anchor**

In `src/engine/server/src/fakeTourGenerator.ts`, when the topic contains the sentinel `symbol` (or always, for one step), emit a draft step whose anchor is `{ file: <an existing fixture file>, symbol: <an existing symbol> }`. Keep it deterministic. The e2e harness writes the fixture, so the fake must anchor to a file/symbol the test guarantees exists (the test passes the file+symbol via the topic string, or the fake targets a conventional `src/sample.ts` the test creates). Choose the simplest: the fake reads the topic as `symbol:<file>:<name>` and emits `{ file, symbol: name }`; otherwise falls back to its current line-anchor behavior.

- [ ] **Step 7: Extend the generation e2e to cover the symbol path**

In `src/engine/server/tests/generation.e2e.test.ts`, add a test that: writes `sample.ts` with `export function sample() {…}`, runs `hdtw/generateTour` (with `HDTW_GENERATOR=fake`, `save:false`, topic `symbol:sample.ts:sample`), and asserts the returned tour has a step whose anchor has `symbol === "sample"` and a resolved `startLine`/`endLine`/`snippetHash`.

- [ ] **Step 8: Run the whole server suite, build, lint, commit**

Run: `pnpm --filter @made-i-t/hdtw-engine-server test && pnpm --filter @made-i-t/hdtw-engine-server build && pnpm --filter @made-i-t/hdtw-engine-server lint`
Expected: green.

```bash
git add src/engine/server pnpm-lock.yaml
git commit -m "feat(engine-server): code-map agent tools, symbol-anchor prompt, fake symbol path"
```

---

## Task 10: VS Code — `symbol-missing` drift badge

**Files:**

- Modify: `src/clients/vscode/src/driftBadge.ts`
- Test: `src/clients/vscode/src/driftBadge.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/clients/vscode/src/driftBadge.test.ts`:

```ts
test("symbol-missing yields a badge and is not reanchorable; relocated is treated as fresh", () => {
  expect(driftBadge("symbol-missing")).toMatch(/symbol/i);
  expect(isReanchorable("symbol-missing")).toBe(false);
  // a self-healed symbol-anchor needs no badge
  expect(driftBadge("relocated")).toBe("");
});
```

> **Implementer note:** check the current signature of `driftBadge`/`isReanchorable` (they take a drift-state string today). Add `"symbol-missing"` and `"relocated"` to whatever union the client mirrors from the protocol/engine drift states.

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter hdtw-vscode test`
Expected: FAIL — unhandled states.

- [ ] **Step 3: Implement**

In `src/clients/vscode/src/driftBadge.ts`, extend the badge map: `"symbol-missing"` → a warning badge like `"⚠ symbol moved or removed"`; `"relocated"` → `""` (no badge — it self-healed); ensure `isReanchorable("symbol-missing")` is `false` (a missing symbol is not hash-window reanchorable). Keep existing states (`fresh`/`drifted`/`out-of-range`/`file-missing`) unchanged.

- [ ] **Step 4: Run tests, build, lint, commit**

Run: `pnpm --filter hdtw-vscode test && pnpm --filter hdtw-vscode build && pnpm --filter hdtw-vscode lint`
Expected: green.

```bash
git add src/clients/vscode/src/driftBadge.ts src/clients/vscode/src/driftBadge.test.ts
git commit -m "feat(vscode): symbol-missing drift badge; relocated renders clean"
```

---

## Task 11: Docs — mark Chunk 4b shipped

**Files:**

- Modify: `docs/product-roadmap.md`

- [ ] **Step 1: Update the roadmap**

Change the "Chunk 4b — Code-map grounding" entry from `⬜ candidate` to `✅ shipped 2026-06-14`, add the spec link (`docs/superpowers/specs/2026-06-14-codemap-grounding-design.md`), and update its feature table to reflect what shipped: tree-sitter structural index (new `@made-i-t/hdtw-codemap`), `fileOutline`/`findSymbol` agent tools, self-healing symbol-relative anchors (additive `symbol` field), `relocated`/`symbol-missing` drift states. Add a note that the semantic call-graph / entrypoint layer remains deferred.

- [ ] **Step 2: Commit**

```bash
git add docs/product-roadmap.md
git commit -m "docs: mark Chunk 4b code-map grounding shipped"
```

---

## Final verification (after all tasks)

Run from repo root:

```bash
pnpm build && pnpm test && pnpm lint
```

Expected: all packages build; full suite green (6 packages now — protocol, observability, engine-core, **codemap**, engine-server, vscode); lint clean.

**Dogfood (manual, F5):** generate a tour of a TS subsystem; confirm ≥1 step anchored by `symbol`; prepend lines above that symbol; run drift; confirm `relocated` (self-healed) while a line-anchor still uses 4a hash-window. Then re-walk the dogfood tours (anchors may have drifted from this chunk's own edits) before merge.
