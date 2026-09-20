# Design: Anchor Drift Detection + Re-anchor (Chunk 4a)

**Date:** 2026-06-13
**Status:** Approved
**Context:** First half of the roadmap's "Chunk 4 — Grounding & drift", split out. Code-map grounding (tree-sitter/LSP call graphs for the generation agent) is deferred to a separate chunk (4b). This chunk finally uses the `snippetHash` stored on every anchor since Chunk 1.

## Goal

On loading a tour, detect when a step's anchor has drifted (the code it points at has moved or changed) by recomputing the snippet hash against the current file. Surface drift clearly in the walk and offer a deterministic, no-agent **re-anchor** that relocates a verbatim-moved step.

**Definition of done (dogfood):** edit a file so a tour step's anchored code shifts to new line numbers; reload/walk the tour and see the step badged "drifted"; click "Re-anchor this step" and watch the engine rewrite that step's line range + hash to the new location (reviewable as a git diff); the step then walks clean.

## The key insight

Anchors store `snippetHash` (a SHA-256) but **not** the snippet text. This is a feature, not a gap: re-anchoring searches **by hash**. Slide a window of the anchor's original length across the file, hash each window; the window whose hash equals the stored `snippetHash` _is_ the original code, verbatim, at its new location. No schema change, fully deterministic, and it cleanly separates "same code, just moved" (a window matches → re-anchor) from "the code genuinely changed" (no match → stays badged, manual fix).

## engine-core (pure — no fs/transport; TDD)

In `src/engine/core/src/anchors.ts` (alongside the existing `computeSnippetHash`, `extractAnchoredText`, `verifyAnchor`):

- `type AnchorFreshness = "fresh" | "drifted" | "out-of-range"`.
- `checkAnchorFreshness(anchor, fileContent): AnchorFreshness` — `out-of-range` if `endLine > lineCount`; else recompute the anchored lines' hash and return `fresh` when it equals `anchor.snippetHash`, `drifted` otherwise. (File-missing is decided by the server, which knows the filesystem.)
- `type ReanchorResult = { outcome: "reanchored"; startLine; endLine; snippetHash } | { outcome: "not-found" } | { outcome: "ambiguous" }`.
- `findReanchor(anchor, fileContent): ReanchorResult` — let `length = anchor.endLine - anchor.startLine + 1`; slide a `length`-line window across the file, hashing each; if exactly one window's hash equals `anchor.snippetHash`, return its new 1-based range + the (identical) hash; `ambiguous` if more than one matches; `not-found` if none (including when the file has fewer than `length` lines).

## engine-server

Two new protocol methods (the engine is the authoritative reader of repo files and keeps `engine-core` the single source of truth; the client never re-implements freshness):

- **`hdtw/checkTourDrift`** — params `{ workspaceRoot, tourId }` → `{ statuses: StepDriftStatus[] }` where `StepDriftStatus = { index: number; status: "fresh" | "drifted" | "out-of-range" | "file-missing" }`. Loads the tour (via the existing tour read), reads each step's anchored file (reusing the Chunk-2 workspace-escape guard), and runs `checkAnchorFreshness`; a step whose file can't be read is `file-missing`. Unknown/invalid tour → the existing `TOUR_NOT_FOUND` error.
- **`hdtw/reanchorStep`** — params `{ workspaceRoot, tourId, stepIndex }` → `{ outcome: "reanchored" | "not-found" | "ambiguous" | "file-missing"; anchor?: TourAnchor }`. Reads the step's anchored file, runs `findReanchor`; on `reanchored`, **atomically rewrites** that one step's `anchor` (startLine/endLine/snippetHash) in the `.tour.json` (temp-file + rename, like generation's `saveTour`) and returns the new anchor. Other outcomes write nothing.

Both are stateless (workspaceRoot per request) and path-guarded.

## VS Code client

- **On walk start:** call `checkTourDrift(tourId)` once and keep the per-step status map. This **replaces** the WalkController's current crude `endLine > document.lineCount` heuristic with hash-accurate truth.
- **In the narration thread:** a `drifted` / `out-of-range` / `file-missing` step shows a badge line at the top of the narration and, when the step is re-anchorable (drifted or out-of-range, i.e. the file exists), a `Re-anchor this step` command link (`command:hdtw.reanchorStep?<encoded [tourId, stepIndex]>`, on the same trusted-scoped MarkdownString as `followRelated`, with `hdtw.reanchorStep` added to `enabledCommands`). Clicking calls `reanchorStep`; on `reanchored`, re-fetch the now-changed tour and re-render the step (it shows fresh); on `ambiguous`/`not-found`/`file-missing`, an information message ("Couldn't locate the moved code — edit the tour by hand.").
- **Sidebar:** a tour that has been checked shows a `⚠ N drifted` description on its tree item. Drift is computed **on demand** — when the tour is walked, or via a new command **`HDTW: Check Tour for Drift`** (runs `checkTourDrift` for the selected/active tour and updates its badge). The sidebar deliberately does **not** eagerly scan every tour's every file on each refresh — that is an expensive path; it reflects the last on-demand check.
- New commands: `hdtw.reanchorStep`, `hdtw.checkTourDrift`.

## Observability

Engine logs via the injected observer: `drift.checked` (per tour, with counts by status), `reanchor.attempt` / `reanchor.result` (outcome). No bare `console.*`.

## Error handling

- Re-anchor never guesses: a unique hash match or nothing. Atomic write means a `.tour.json` is never half-rewritten.
- A step whose file is missing is reported `file-missing` and is not re-anchorable.
- `checkTourDrift` on an unknown/invalid tour returns the existing not-found error; the client handles it like any getTour failure.

## Testing

- **engine-core (TDD):** `checkAnchorFreshness` (fresh, drifted, out-of-range); `findReanchor` (verbatim-moved → reanchored with correct new range; changed code → not-found; file too short → not-found; duplicated identical block → ambiguous; unchanged → reanchored to the same place, harmless).
- **engine-server:** stdio e2e against a fixture workspace — write a tour + file, mutate the file to shift the anchored lines, assert `checkTourDrift` reports `drifted`, call `reanchorStep`, assert the on-disk tour now has the corrected range/hash and a re-check reports `fresh`.
- **vscode:** the drift-status → badge/link mapping logic lives in a pure helper (unit-tested); the thread rendering + re-anchor round trip is the F5 dogfood.

## Conventions carried forward

`@made-i-t/hdtw-*` scope; `.js` relative imports; engine-core stays pure (`node:crypto` allowed, no fs); clients import only from the protocol package; engine never trusts agent data; observability via the injected observer; trusted-markdown command links scoped to named commands only.

## Out of scope (→ Chunk 4b / follow-ons)

Code-map grounding (tree-sitter/LSP entrypoints + call graphs the generation agent cites) — its own chunk. Length-tolerant / fuzzy re-anchor (matching when the construct grew or shrank a line). Agent-assisted re-anchor for renamed/refactored code. Eager whole-catalog drift scanning with caching.
