# Design: Code-Map Grounding (Chunk 4b)

**Date:** 2026-06-14
**Status:** Approved
**Context:** Split from the original "Chunk 4 — Grounding & drift" (4a shipped drift detection + re-anchor). This is the generation-side half: give the agent verified structural facts so it anchors to real symbols instead of guessing, and make those anchors self-healing. Reuses the Chunk 2 `TourGenerator`/Agent SDK pipeline and the engine-core purity model.

## Goal

Introduce a **structural code-map** (tree-sitter) the generation agent can query, and a new **symbol-relative anchor** kind that names a durable symbol identity instead of raw line numbers. The engine resolves the symbol to a line range — so anchors are accurate at birth and **auto-follow code as it moves**, turning most drift from a warning into a silent self-heal.

This is the **foundation-first slice**: a syntactic (tree-sitter) structural index serving anchor precision + cheap structure now. The semantic call-graph / entrypoint layer (LSP-grade) is explicitly deferred to a later chunk.

**Definition of done (dogfood):** generate a tour of a TS subsystem; confirm at least one step anchors by symbol (`{ file, symbol }`); move that symbol's code (add lines above it) and re-run drift; confirm the symbol-anchor reports `relocated` (self-healed to the new range) rather than `drifted`, while a line-anchor in the same tour still uses the 4a hash-window path.

## Decisions

- **Foundation-first (tree-sitter, not LSP).** V1 builds a syntactic structural index. Call graphs / entrypoints / cross-file semantics are a deferred layer. (User pick: "Foundation for all three.")
- **Symbol-relative anchors, with line-anchors retained.** Two anchor kinds coexist: symbol-anchors (whole named declaration, self-healing) and today's line-anchors (hash-window drift, unchanged). Each anchor is one kind or the other. (User pick: "Symbol + line-anchor fallback.")
- **WASM tree-sitter (`web-tree-sitter`), not native bindings.** The engine runs on arbitrary user machines; WASM avoids per-platform native builds. Standard choice for editor tooling.
- **V1 language scope: TypeScript/JavaScript only** (`.ts/.tsx/.js/.jsx`, one grammar). The package is structured so adding a grammar later is a registration, not a redesign.
- **The engine still owns every line number.** The agent proposes a *symbol name*; the engine resolves it to a range via the code-map. The "never trust agent-supplied anchors" rule is preserved and strengthened.

## Architecture

```
@made-i-t/hdtw-codemap   (NEW — impure: fs + web-tree-sitter WASM)
    Pure parse layer:   parseSymbols(content, lang) -> Symbol[]   (string-in, ranges-out)
    Thin fs facade:     fileOutline(absPath), findSymbol(absPath, name)
        │  consumed by
        ▼
engine-server            (impure: SDK, transport, fs)
    • exposes code-map as in-process SDK MCP tools (fileOutline, findSymbol) to the agent
    • resolves symbol-anchors -> ranges at generate / verify / drift / getTour
    • hands RESOLVED ranges + file content into ↓
        ▼
engine-core              (PURE — unchanged purity; never imports tree-sitter)
    • verifyAnchor / drift gain a symbol-anchor branch operating on a range
      the server already resolved
```

**Why this shape:** `engine-core` stays pure by receiving resolved ranges and doing the same hash/verify math as today. The impure parsing lives in one new focused package. Tool handlers + symbol resolution live in `engine-server`, already impure. Mirrors how Chunk 2 kept the SDK out of core.

## Protocol (`@made-i-t/hdtw-protocol`)

Anchor gains an optional `symbol` field — additive, so `schemaVersion` stays `1` (same precedent as `relatedTours`):

```jsonc
// line-anchor (today, unchanged):
{ "file": "main.ts", "startLine": 54, "endLine": 60, "snippetHash": "sha256:…" }

// symbol-anchor (new): `symbol` = durable identity; the line fields are an
// engine-maintained CACHE of the last resolved range.
{ "file": "pipeline.ts", "symbol": "runGeneration",
  "startLine": 30, "endLine": 143, "snippetHash": "sha256:…" }
```

- Presence of `symbol` discriminates the kind.
- The cached line fields stay populated, so **old clients and the future engine-free browser client render via lines** with no engine.
- New drift state `"symbol-missing"` added to the drift-state union (alongside `fresh`/`drifted`/`out-of-range`/`file-missing`).
- `parseTour` validates: a symbol-anchor still requires valid `startLine`/`endLine`/`snippetHash` (the cache) plus a non-empty `symbol` string.

**Symbol identity = qualified path** within the file (`ClassName.method`, or top-level `name`). Ambiguity handling:
- At **generation**, `findSymbol` returns the candidate list so the agent qualifies further; if the emitted anchor's symbol is still ambiguous, verification errors → existing repair round.
- At **verify/drift** of an existing anchor, ties break toward the candidate nearest the cached range.

## `@made-i-t/hdtw-codemap` (new package)

- CJS package (like protocol/engine-core), depends on `web-tree-sitter` + the TS/JS WASM grammar.
- **Pure parse layer** `parseSymbols(content: string, language: "ts" | "tsx"): Symbol[]` where `Symbol = { name, qualifiedName, kind, startLine, endLine }`. `kind ∈ { function, method, class, interface, const, enum, type }`. 1-based inclusive line ranges. No fs — unit-testable from content strings.
- **Thin fs facade:**
  - `fileOutline(absPath): Symbol[]` — read + parse, language inferred from extension.
  - `findSymbol(absPath, name): { ok: true; symbol: Symbol } | { ok: "ambiguous"; candidates: Symbol[] } | { ok: false }` — match by `name` or `qualifiedName`.
- Grammar registry keyed by extension so adding a language is one entry.
- WASM init is async + cached (load the grammar once per process).

## Engine-server

- **`SymbolResolver`** (new module) wraps `hdtw-codemap` for the server: `resolve(workspaceRoot, file, symbol): Resolved | "missing" | "ambiguous"`, applying the workspace path-traversal guard (reuse Chunk 2's `verifyStep` resolve+startsWith check) and the nearest-to-cached tiebreak.
- **Generation tools:** an in-process SDK MCP server exposing `fileOutline` and `findSymbol`, handlers backed by `SymbolResolver`/codemap, read-only, path-guarded. Registered in `claudeTourGenerator`'s `query()` (`mcpServers` + `tools` allowlist). `FakeTourGenerator` is extended to emit a symbol-anchor draft when a sentinel topic/env is set, so the fake path exercises symbol resolution deterministically.
- **Verify (`verifyStep`):** for a symbol-anchor, resolve symbol→range first, then run the existing `verifyAnchor` over the resolved range; write the resolved `startLine`/`endLine`/`snippetHash` into the cached fields. Symbol missing/ambiguous → a verification error string (feeds the repair round exactly like a bad line range does today).
- **getTour:** re-resolve symbol-anchors against current file content and return refreshed ranges, so a live walk highlights correctly even if code moved since commit. (Resolution failure falls back to the cached range + surfaces drift; never breaks playback.)
- **Drift (`checkTourDrift` / re-anchor):** symbol-anchor whose cache is stale but symbol resolves → `relocated` (cache auto-updated); symbol gone → `symbol-missing`. The drift command may write refreshed caches back to disk (same explicit-write model as 4a re-anchor), keeping committed tours current for engine-free consumers. Line-anchors: 4a behavior unchanged.
- **System prompt:** add the rule to prefer symbol-anchors for whole named declarations, line-anchors only for sub-regions.

## VS Code client

- Symbol-anchor walking is transparent: the engine serves resolved ranges, so playback stays line-based and dumb.
- `symbol-missing` gets a drift badge + message (extend `driftBadge`); unit-tested like the existing states. Re-anchor affordance applies where sensible (a missing symbol is surfaced like a missing file).

## Error handling

- Symbol not found / ambiguous during generation → verification error → repair round (capped, as today). If still unresolved after repair → the existing `GENERATION_FAILED` path.
- Symbol resolution failure at walk/drift time → fall back to the cached range, surface drift (`symbol-missing` or `drifted`); the walk never breaks.
- Codemap/WASM init failure → log via the observer and degrade to line-anchor behavior (symbol-anchors report drift rather than crashing generation/playback).

## Testing

- **hdtw-codemap:** unit tests on the pure `parseSymbols` (functions/methods/classes/interfaces/exported consts → correct ranges; qualified names; ambiguity yields multiple; `.tsx/.jsx`; not-found). Thin-facade tests over fixture files in a tmp dir.
- **engine-server:** symbol-anchor resolves + caches in verify; `symbol-missing` → verification error → repair; drift: symbol moved → `relocated`/self-heal, symbol deleted → `symbol-missing`; tool handlers incl. path-traversal rejection; `HDTW_GENERATOR=fake` e2e covers the symbol-anchor generate→verify path end to end.
- **engine-core:** the symbol-anchor verify/drift branch operating on a pre-resolved range (pure, content-in).
- **vscode:** `symbol-missing` drift badge unit test; real symbol-anchor walking is the F5 dogfood.

## Out of scope (deferred)

- Semantic call graphs, entrypoint detection, cross-file definition/reference resolution (the LSP-grade layer — its own chunk).
- Languages beyond TS/JS.
- Repo-wide map / index tools for the agent (V1 ships per-file `fileOutline`/`findSymbol` only).
- Symbol-relative *sub-ranges* (a symbol + line offset) — sub-regions use line-anchors in V1.

## Known V1 limitations (parse layer)

These are acceptable because symbol-anchors target ordinary single, named declarations; anything else uses a line-anchor.

- **Multi-declarator statements** (`const a = 1, b = 2;`) resolve every name to the same shared `lexical_declaration` range. Distinct by `name`, but same range — don't symbol-anchor these.
- **Object-literal methods** (`const obj = { meth() {} }`) are captured as `kind: "method"` with an unqualified `qualifiedName` (the qualifier walk only recognizes `class`/`interface` ancestors). Slightly misleading; restrict or qualify later.

## Conventions carried forward

`@made-i-t/hdtw-*` scope; `.js` relative imports; engine-core stays pure (operates on resolved ranges handed in — never imports tree-sitter); the engine never trusts agent-supplied line numbers (it resolves symbols itself); observability via the injected observer; clients import code only from the protocol package; additive schema (no `schemaVersion` bump), so all existing tours and clients keep working.
