# Design: Conversational Ask (Chunk 3a)

**Date:** 2026-06-13
**Status:** Approved
**Context:** First half of the roadmap's "Chunk 3 — Conversational walks", split out. The "Why?" detour (live Q&A on a step) is Chunk 3b, designed/built right after. This chunk delivers the ask-first entry: ask a question, get an ephemeral walk, save the good ones to the catalog. It reuses the Chunk 2 generation engine and the existing rails playback.

## Goal

A new **"Ask…"** entry: the user asks "how does X work?" in an input box; the agent explores and produces a tour exactly as in Chunk 2, but the tour is **ephemeral** (not written to the repo). It auto-walks; a **"Save to catalog"** action promotes it into `.hdtw/tours/`. Casual questions leave no trace; good walks become durable artifacts.

**Definition of done (dogfood):** run "HDTW: Ask…" with a real question, walk the result, click "Save tour", and confirm a new `.hdtw/tours/<slug>.tour.json` appears (and that closing an unsaved walk persists nothing).

## Decisions

- **A conversational walk is a generated tour, staged not committed.** "Ask" is `generateTour` with `save: false` and the question as the topic. The verified `Tour` is returned in memory and walked directly (the WalkController already walks an in-memory `Tour`); nothing is written until the user saves. This honors "tours are the universal currency" and reuses the entire Chunk 2 pipeline.
- **In-editor UI only.** The question is an input box; the walk is the existing rails. No webview or chat panel.
- **Ephemeral by default, save promotes.** Generation writes nothing when `save: false`; a separate `hdtw/saveTour` writes a client-held `Tour` into the catalog with a unique id.

## Protocol (`@made-i-t/hdtw-protocol`)

- `GenerateTourParams` gains `save?: boolean` (default `true` — preserves Chunk 2's commit-immediately behavior).
- `GenerateTourResult.savedPath` becomes optional (`savedPath?: string`) — absent when `save: false`.
- New `SAVE_TOUR_METHOD = "hdtw/saveTour"`; `SaveTourParams { workspaceRoot, tour: Tour }`; `SaveTourResult { savedPath: string }`. New error code `SAVE_TOUR_FAILED_ERROR_CODE = -32005`.

## Engine-server

### Shared storage module (`src/engine/server/src/tourStorage.ts`)

Extract the catalog-write logic that currently lives inside the generation pipeline so both the pipeline and the new save path use one implementation:

- `TOURS_DIR_SEGMENTS`, `slugify(title)`, `uniqueTourId(toursDir, baseId)`.
- `class TourSaveError extends Error`.
- `writeTourToCatalog(workspaceRoot, tour): Promise<{ savedPath; tour }>` — computes a unique id from `slugify(tour.title)`, sets it, gates the result with `parseTour` (throws `TourSaveError` on failure), atomically writes (temp + rename) to `.hdtw/tours/`, and returns the written tour (with its final id) + the relative `savedPath`.

### Generation honors `save`

`runGeneration` assembles + gates the `Tour` (provisional `id = slugify(title)`) as today, then:

- `save === false` → log `generate.done` (unsaved), end the span, return `{ tour, savedPath: undefined }` — **no write, no "saving" progress phase**.
- otherwise → emit the "saving" phase, call `writeTourToCatalog`, return `{ tour: <written>, savedPath }`. A `TourSaveError` here maps to `GENERATION_FAILED`.

### Save handler

`hdtw/saveTour({ workspaceRoot, tour })` → `writeTourToCatalog` → `{ savedPath }`. `TourSaveError` maps to `SAVE_TOUR_FAILED_ERROR_CODE`. Path/id safety comes from `slugify` (only `[a-z0-9-]`) — a client-supplied title can never escape `.hdtw/tours/`.

## VS Code client

- **`HDTW: Ask…`** command + a `$(comment-discussion)` button on the Tours view title → `showInputBox` ("What do you want to understand? e.g. _how does drift detection work?_") → `generateTour({ …, save: false })` (same `withProgress`/cost UI as Chunk 2) → auto-walk the returned (unsaved) tour.
- **Unsaved-walk affordance:** the extension tracks the current walk's tour + an `unsaved` flag. While a walk is unsaved, a status-bar **`$(save) Save tour`** item shows, and `HDTW: Save Current Walk to Catalog` is enabled. Saving → `saveTour(tour)` → success message + sidebar refresh; the walk becomes saved (the affordance hides). Closing/exiting an unsaved walk persists nothing.
- Walks started from the catalog (`startTour`/`followRelated`) or from "Generate Tour…" (which still commits immediately) are `saved` from the start and never show the affordance.

## Observability

`ask.requested` (with the question), `ask.generated` (unsaved), `tour.saved` (savedPath) via the injected observer.

## Error handling

Auth / budget / cancel reuse Chunk 2's typed-error flow exactly (the Ask path is the same generation request). A save failure surfaces `SAVE_TOUR_FAILED_ERROR_CODE` with a legible message. An unsaved walk that is never saved leaves the repo untouched.

## Testing

- **engine-server:** pipeline — `generateTour{save:false}` returns the tour and writes nothing; `{save:true}` still writes (regression). `writeTourToCatalog`/`slugify`/`uniqueTourId` unit-tested (collision → `-2`, slug of an awkward title). Save handler over stdio e2e: generate `save:false` then `saveTour` writes the file; a second save of the same title gets a `-2` suffix.
- **vscode:** the unsaved↔saved status logic in a small pure helper (unit-tested); the Ask → walk → save round trip is the F5 dogfood.

## Out of scope (→ Chunk 3b)

The "Why?" detour: enabling replies on the narration thread, a new `hdtw/askAboutStep` agent Q&A method, and appending the answer to the thread. Its own spec → plan → build.

## Conventions carried forward

`@made-i-t/hdtw-*` scope; `.js` relative imports; engine-core stays pure; the engine never trusts agent/client data (the saved tour is re-gated; slug confines the path); observability via the injected observer; clients import only from the protocol package.
