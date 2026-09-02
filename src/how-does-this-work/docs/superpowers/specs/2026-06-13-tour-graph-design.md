# Design: Tour Graph — related-tour links + walk stack

**Date:** 2026-06-13
**Status:** Approved
**Context:** Pulls the roadmap "Tour graph" candidate forward as the next built chunk (ahead of conversational walks). Builds on Chunk 1 (tour artifacts + rails playback), Chunk 2 (agent generation), and Chunk 2.5 (observability).

## Goal

Tours stay flat top-level artifacts, but a step can surface **related tours**. Following one pushes the current walk onto a stack, walks the sub-tour, and auto-returns to the exact parent step. The generation agent proposes cross-links from the existing tour catalog; the engine validates them.

**Definition of done (dogfood):** hand-author a second small tour in this repo and a `relatedTours` link from the `monorepo-architecture` tour's "process boundary" step to it; press F5, follow the branch, and confirm auto-return to the parent step. F5 generation of a tour that proposes a valid cross-link is the agent step.

## The core idea

The graph is composed at **walk time**, not authored as nesting. A tour file never contains another tour — it contains lightweight references (`relatedTours`) that the client resolves and the user opts into. This keeps artifacts flat, shareable, and independently editable.

## Decisions

- **Link shape:** `relatedTours: { tourId: string; label?: string }[]` on a `TourStep`. The optional `label` is the link text; it falls back to the target tour's title. Schema-additive — `schemaVersion` stays `1`; old clients ignore the field.
- **Return UX:** auto-return. `Next` past a sub-tour's last step (and `Back` before its first step) pops the stack back to the parent's branch step, which is preserved on the stack. A status-bar breadcrumb shows the stack (`root › sub`). `Exit` abandons the whole stack. Arbitrary nesting depth.
- **Agent cross-linking is in scope:** the generation agent receives the existing catalog and may propose `relatedTours`; the engine drops links it can't resolve.

## Protocol (`@made-i-t/hdtw-protocol`)

Extend `TourStep`:

```ts
export interface RelatedTour {
  tourId: string;
  /** Link text; falls back to the target tour's title when absent. */
  label?: string;
}

export interface TourStep {
  title: string;
  anchor: TourAnchor;
  narration: string;
  relatedTours?: RelatedTour[];
}
```

No new RPC methods: the client already has `getTour` (fetch a sub-tour by id) and `listTours` (resolve link existence + titles).

## Engine-core (pure — no fs, no transport)

`parseTour` validates `relatedTours` _shape_ when present: it must be an array; each entry an object with a non-empty string `tourId` and an optional string `label`. Malformed → validation errors (the tour is badged invalid via the existing mechanism). Core does **not** verify that a target tour exists — that is cross-tour and belongs to the server/client.

## Engine-server (`@made-i-t/hdtw-engine-server`)

### Generation cross-linking

- `runGeneration` fetches the existing catalog with `listTours(workspaceRoot)` and passes the valid tours' `{ id, title, summary }` to the generator.
- `TourGenerator.generate`/`repair` gain a `catalog: TourSummary[]` parameter. `FakeTourGenerator` ignores it. `ClaudeAgentTourGenerator` injects the catalog into the prompt ("existing tours you may reference via `relatedTours`…") and may emit `relatedTours` in its draft JSON; `parseDraft`/`validateDraft` accept the optional field.
- **Engine-owned validation** (the trust rule, extended): during verification the pipeline keeps only `relatedTours` entries whose `tourId` is in the catalog **and** is not the tour being generated (no self-links). Every dropped link is logged via the observer (`verify.related_dropped`). Cross-tour cycles are allowed — a graph, not a tree.
- The `DraftStep` type gains optional `relatedTours`; verified steps carry the resolved (filtered) links.

## VS Code client

### Pure walk-stack module (`src/clients/vscode/src/walkStack.ts`)

Operates on `WalkState[]` (reuses the existing `walkState.ts` per-walk helpers). All branching logic lives here and is unit-tested:

- `activeWalk(stack): WalkState` — the top of stack.
- `pushWalk(stack, tour): WalkState[]` — begin a sub-tour at step 0.
- `advance(stack): WalkState[]` — if the active walk has a next step, advance it; else if depth > 1, pop to the parent (unchanged at its branch step); else unchanged (root last step).
- `retreat(stack): WalkState[]` — if the active walk has a previous step, retreat it; else if depth > 1, pop; else unchanged.
- `breadcrumbLabel(stack): string` — the stack's tour titles joined with `›`.

### WalkController (holds the stack; stays thin)

- `start(tour)` resets the stack to `[startWalk(tour)]`.
- `followRelated(tourId)` fetches the sub-tour via `EngineClient.getTour`, pushes it, and renders. On fetch failure: an error notification; the stack is unchanged.
- `next`/`previous` delegate to `advance`/`retreat` and re-render. `exit` clears the entire stack and all artifacts.
- The active step's narration thread appends a **"Related tours"** section: each resolvable link renders as a command-link button (`[🧭 label](command:hdtw.followRelated?["<tourId>"])`) on a `MarkdownString` with `isTrusted` scoped to the single `hdtw.followRelated` command. A link whose `tourId` is not in the `listTours` cache renders as a greyed "(tour not found: id)" note.
- Status bar shows the breadcrumb: `🧠 <root> › <sub> · n/m`.

### Manifest

New command `hdtw.followRelated` (argument: `tourId`). No new view or setting.

## Error handling

- Missing/invalid related target → non-link note; never breaks the walk.
- `getTour` failure when following → error toast; stack unchanged.
- Malformed `relatedTours` in a tour file → tour badged invalid (existing mechanism).
- Generation: unresolvable and self links are dropped (logged), not fatal.

## Testing

- **protocol:** types compile (no runtime assertion needed for the additive interface).
- **engine-core:** `parseTour` accepts a valid `relatedTours`; rejects malformed (non-array, non-string `tourId`, non-string `label`).
- **engine-server:** pipeline keeps catalog-resolvable links and drops unresolvable + self links, asserted via a capturing observer (`verify.related_dropped`); the catalog reaches the generator; `parseDraft` accepts `relatedTours`.
- **vscode:** `walkStack` pure units — push, advance-pops-at-end, retreat-pops-at-start, breadcrumb across depths. Thread link rendering + command wiring and F5 cross-link generation are the manual dogfood.
- **Dogfood artifact:** a second committed tour + a hand-authored cross-link from `monorepo-architecture`.

## Conventions carried forward

`@made-i-t/hdtw-*` scope; `.js` relative imports; engine-core stays pure; clients import only from the protocol package; the engine never trusts agent-proposed data (now extended to related links); observability via the injected observer (no bare `console.*`).

## Out of scope

A graph/overview visualization of tours; bidirectional back-links (only forward links authored on steps); related links at tour level (only per-step); deduping a tour that appears multiple times in one stack.
