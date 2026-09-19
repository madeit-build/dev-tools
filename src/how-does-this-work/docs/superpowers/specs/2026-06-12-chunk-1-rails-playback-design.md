# Design: Chunk 1 — Tour Artifacts + Rails Playback

**Date:** 2026-06-12
**Status:** Approved
**Context:** First capability chunk of the product roadmap (`docs/product-roadmap.md` — read it for the full feature set and sequencing). Builds directly on the Chunk 0 skeleton (`2026-06-12-monorepo-structure-design.md`).

## Goal

Walk a hand-authored tour end-to-end in VS Code: pick a tour from a sidebar, step through code locations on rails with inline narration from "the principal engineer." No agent, no tokens, fully offline.

**Definition of done (dogfood):** a committed tour of this repo's own architecture (`.hdtw/tours/monorepo-architecture.tour.json`) walking protocol → engine-core → engine-server → extension, playable via F5.

## Non-goals (later chunks)

Tour generation and the agent (Chunk 2), conversation and "Why?" detours (Chunk 3 — the button does not exist in Chunk 1; no dead controls), drift detection logic and code-map grounding (Chunk 4), freshness CI and JetBrains (Chunk 5).

## Tour artifact

Path convention in any consumer repo: `.hdtw/tours/<id>.tour.json`, committed alongside source.

```json
{
  "schemaVersion": 1,
  "id": "monorepo-architecture",
  "title": "Monorepo architecture",
  "summary": "How the engine, protocol, and clients fit together",
  "steps": [
    {
      "title": "The contract",
      "anchor": {
        "file": "src/protocol/src/index.ts",
        "startLine": 4,
        "endLine": 9,
        "snippetHash": "sha256:<hex of anchored text>"
      },
      "narration": "Markdown narration — the principal engineer's voice."
    }
  ]
}
```

Rules:

- `id` must match the filename stem and be unique per repo.
- `anchor.file` is workspace-root-relative, POSIX separators.
- `startLine`/`endLine` are 1-based, inclusive; `startLine <= endLine`.
- `snippetHash` is the SHA-256 of the exact anchored text at authoring time. **Unused in Chunk 1** beyond storage — recorded from day one so Chunk 4's drift detection works retroactively on every tour ever written.
- `narration` is Markdown (rendered by the Comments API).

## Protocol additions (`@made-i-t/hdtw-protocol`)

Two request methods; the engine stays **stateless** (workspaceRoot travels in each request — no session state until a chunk needs it):

- `hdtw/listTours` — params `{ workspaceRoot: string }` → `{ tours: TourSummary[] }` where `TourSummary = { id, title, summary, stepCount, error? }`. Invalid tour files are _included_ with `error` populated (message + offending file) so clients can badge them.
- `hdtw/getTour` — params `{ workspaceRoot: string, tourId: string }` → `{ tour: Tour }` or a JSON-RPC error if the id is unknown/invalid.

New exported types: `Tour`, `TourStep`, `TourAnchor`, `TourSummary`, plus method-name constants following the existing `PING_METHOD` pattern.

## Engine responsibilities

- **`engine-core` (pure, no filesystem):** tour domain model; `parseTour(json, filename)` returning either a validated `Tour` or a structured list of validation errors (schema shape, id/filename match, line-range sanity). Unit-tested exhaustively.
- **`engine-server`:** reads `.hdtw/tours/*.tour.json` under the requested workspaceRoot, delegates parsing/validation to core, implements both request handlers. Malformed requests rejected at the boundary per existing convention.

## VS Code client

- **Tours sidebar:** HDTW activity-bar icon → native TreeView listing the workspace's tours (title + step count). Invalid tours appear with an error badge and a tooltip giving the precise failure; they cannot be started.
- **Walking a tour:** starting a tour drives a step loop — open the anchored file, reveal and highlight the anchor range (editor decoration), and render narration as an **inline thread under the code** via the Comments API (markdown body, natively collapsible so the user can see full code scope). Thread carries the controls: `◀ Back`, `Next ▶`, `Exit tour`. Exactly one narration thread exists at a time; navigating disposes the old one.
- **Status bar:** `🧭 <tour title> · <n>/<total>` while a walk is active.
- **Walk-state module:** current tour/step and navigation transitions live in a pure TypeScript module (no `vscode` imports) so it's vitest-testable; the extension shell maps state changes onto editor/Comments/status-bar APIs.

## Error handling

- Invalid tour file → listed with error badge; precise message (file, what failed); cannot start.
- Anchor file missing or line range out of bounds at walk time → the step renders a "this step's anchor has drifted — code may have changed since authoring" notice in the thread instead of code highlight; Back/Next still work; the tour never hard-fails mid-walk.
- Engine spawn/request failures → existing fail-fast notification pattern from Chunk 0.

## Testing

- `engine-core`: TDD vitest units for `parseTour` (valid, each validation failure class).
- `engine-server`: handler units + stdio e2e against a fixture workspace containing valid + invalid tours (extends the existing e2e pattern).
- Extension: vitest units for the pure walk-state module; manual F5 verification against the dogfood tour. `@vscode/test-electron` remains deferred.

## Conventions carried forward

Package scope `@made-i-t/hdtw-*`; exports maps with `types` first; `.js` extensions on relative imports; clients import only from the protocol package; engine-core stays transport- and fs-free.
