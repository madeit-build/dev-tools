# Design: Chunk 2 — Embedded Agent + Tour Generation

**Date:** 2026-06-12
**Status:** Approved
**Context:** Second capability chunk of the product roadmap (`docs/product-roadmap.md`). Builds on Chunk 1's tour artifacts and rails playback (`2026-06-12-chunk-1-rails-playback-design.md`). The agent generates tours; the existing rails replay them.

## Goal

From the Tours sidebar: **"Generate Tour…"** → topic prompt → live progress with token/cost readout → an anchor-verified tour written to `.hdtw/tours/` that immediately auto-walks.

**Definition of done (dogfood):** generate a real tour of this repo through the author's Claude Code subscription auth, walk it on the existing rails, and commit the artifact. Cancellation works mid-generation; the budget cap aborts cleanly with spend reported.

## Non-goals (later chunks)

Conversational walks and mid-tour "Why?" detours (Chunk 3); bring-your-own-agent providers beyond the reserved port (future chunk — see Decisions); anchor-drift re-anchoring (Chunk 4); multi-root workspaces.

## Key decisions

- **Agent runtime:** `@anthropic-ai/claude-agent-sdk` runs **in-process in `engine-server`**. Intelligence stays in the engine, so every IDE client gets generation through the same protocol. Rejected: shelling out to headless `claude -p` (brittle bridge, CLI hard-dependency) and client-side generation (intelligence trapped in one IDE).
- **The engine never trusts the agent's anchors.** The agent drafts steps *without hashes*; the engine independently reads each anchored file, validates ranges, and computes `snippetHash` itself. One repair round, then fail loudly. Hallucinated anchors are the product's biggest trust risk.
- **BYOA seam reserved:** generation runs behind a narrow `TourGenerator` port so future chunks can add other agent backends (Codex, Copilot, etc.) without touching the pipeline, protocol, or clients.
- **Landing flow:** save + auto-walk immediately. Git is the review mechanism; deleting the file is the rejection.

## Protocol additions (`@made-i-t/hdtw-protocol`)

- **`hdtw/generateTour`** (request, long-running): params `{ workspaceRoot: string, topic: string, model?: string, maxBudgetUsd?: number }` → result `{ tour: Tour, savedPath: string }`. Cancellable via vscode-jsonrpc's native cancellation (`$/cancelRequest`); the engine wires the cancellation token to the SDK's AbortController.
- **`hdtw/generationProgress`** (notification, engine→client): `{ phase: "exploring" | "drafting" | "verifying" | "repairing" | "saving", message: string, tokensIn: number, tokensOut: number, estimatedCostUsd: number }`.
- **Error codes** (extending `-32001`): `-32002` `GENERATION_AUTH_REQUIRED_ERROR_CODE`, `-32003` `GENERATION_FAILED_ERROR_CODE` (message carries detail, e.g. unanchorable steps after repair), `-32004` `GENERATION_BUDGET_EXCEEDED_ERROR_CODE` (message carries spend).
- Clients pass `model`/`maxBudgetUsd` from their own settings; the engine holds no configuration.

## Engine responsibilities

### `engine-core` (pure — no fs, no SDK; TDD)

- `computeSnippetHash(text: string): string` — canonical hash: `"sha256:" + hex(SHA-256(anchored lines joined with "\n"))`. This codifies the convention used by the Chunk 1 dogfood tour.
- `verifyAnchor(anchor, fileContent): { ok: true } | { ok: false, errors: string[] }` — range within file, sane bounds; precise error strings (they are fed back to the agent in the repair round).

### `engine-server`

- **`TourGenerator` port:** `generate(request, hooks): Promise<DraftStep[]>` where `DraftStep = { title, narration, anchor: { file, startLine, endLine } }` (no hash) and `hooks = { onProgress, signal }`. Implementations:
  - `ClaudeAgentTourGenerator` — Agent SDK loop: principal-engineer system prompt with an explicit output contract; read-only tools (Read/Grep/Glob) scoped to `workspaceRoot`; `maxTurns` cap; streams SDK usage into `onProgress`; honors the abort signal.
  - `FakeTourGenerator` — deterministic, for pipeline tests and stdio e2e (selected via `HDTW_GENERATOR=fake` env).
- **Generation pipeline** (generator-agnostic): draft steps → engine reads each anchored file, validates via `verifyAnchor`, computes hashes via `computeSnippetHash` → verification failures collected and sent to the agent for **one repair round** → re-verify → assemble full `Tour` (id slugified from title; `-2`, `-3` suffix on filename collision) → final gate through `parseTour` → **atomic write** (temp file + rename) to `.hdtw/tours/<id>.tour.json` → result returned.
- **Budget:** cumulative SDK usage tracked against `maxBudgetUsd` (client default $2); crossing it aborts the SDK query and raises BUDGET_EXCEEDED with tokens/cost spent. Default model comes from the client setting (defaults to the current Sonnet model).

## Auth

The engine inherits its environment from the extension's spawn. Resolution order:

1. `ANTHROPIC_API_KEY` — set via the new **"HDTW: Set Anthropic API Key"** command (stored in VS Code SecretStorage, injected into the engine's spawn env).
2. SDK fallback to Claude Code CLI credentials (subscription auth) when present on the machine.
3. Neither → the generate request fails with AUTH_REQUIRED; the client shows an actionable notification with a "Set API Key" action.

No preflight auth checks — the typed error is the flow. Tour consumers never need auth (Chunk 1 playback is untouched).

## VS Code client

- **Entry points:** sparkle button on the Tours view title + command palette **"HDTW: Generate Tour…"** → `showInputBox` for the topic (placeholder: a real example question).
- **Progress:** `vscode.window.withProgress` (notification area, cancellable) updating from `hdtw/generationProgress`, e.g. *"Exploring codebase… (14k tokens · ~$0.11)"*. Cancel propagates JSON-RPC cancellation to the engine, which aborts the SDK loop; no file is written.
- **Success:** sidebar refreshes; the new tour auto-walks via the existing WalkController.
- **Settings:** `hdtw.generation.model` (string, default current Sonnet), `hdtw.generation.maxBudgetUsd` (number, default 2).

## Error handling

Every failure is typed and user-legible: AUTH_REQUIRED (actionable: set key), BUDGET_EXCEEDED (shows spend), GENERATION_FAILED after the repair round (shows what could not be anchored), cancellation (silent cleanup). A half-written tour file can never appear: writes are atomic and happen only after the `parseTour` gate passes.

## Testing

- `engine-core`: TDD units for `computeSnippetHash` (known vectors, CRLF normalization) and `verifyAnchor` (each failure class).
- `engine-server`: pipeline units with `FakeTourGenerator` — verification, repair round (fake returns one bad anchor then a fixed one), budget abort, filename collision, atomic write, cancellation. Zero API calls.
- stdio e2e: engine spawned with `HDTW_GENERATOR=fake` — full wire test: request → progress notifications observed → tour saved in a temp fixture workspace → result matches.
- Real-SDK path: manual F5 dogfood (spends real tokens — the human verification step, like Chunk 1's F5).

## Conventions carried forward

`@made-i-t/hdtw-*` scope; exports maps (`types` first); `.js` relative imports; clients import only from the protocol package; engine-core stays pure; fail fast and visibly.
