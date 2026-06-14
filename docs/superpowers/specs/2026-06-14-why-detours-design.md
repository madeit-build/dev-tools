# Design: "Why?" Detours (Chunk 3b)

**Date:** 2026-06-14
**Status:** Approved
**Context:** The second half of "Chunk 3 — Conversational walks", completing V1 (chunks 1–3). 3a delivered the ask-first entry; this delivers the mid-walk Q&A. Reuses the Chunk 2 agent (Agent SDK, read-only tools) and the rails playback.

## Goal

While walking a tour, the user replies to the narration thread with a follow-up question about the current step; the agent answers — grounded in the step and free to read more of the repo — and the answer appears in the thread. The Q&A is **ephemeral**: navigating away disposes it, and `[Next ▶]` resumes the rails untouched.

**Definition of done (dogfood):** during a walk, reply "why is it done this way?" to a step; see a "🧠 thinking…" placeholder, then a grounded answer in the thread; hit Next and confirm the Q&A is gone and the walk continues.

## Decisions

- **Read-only explore, capped.** The agent gets the step's `{ file, startLine, endLine, narration, tourTitle }` + the question, and the same read-only `Read`/`Grep`/`Glob` tools as generation, but with `maxTurns: 6` and a tight budget — so a quick "why" stays quick and cheap while still being able to follow a reference.
- **Single-shot with a thinking placeholder.** On reply, append the question + a "🧠 thinking…" comment immediately; replace it with the full answer when ready. The Comments API does not stream naturally, so this avoids fighting it; a cancellable `withProgress` covers the wait and shows tokens/cost.
- **In-editor via Comments API replies.** No new panel.

## Protocol (`@made-i-t/hdtw-protocol`)

- `ASK_ABOUT_STEP_METHOD = "hdtw/askAboutStep"`.
- `StepQaContext { file: string; startLine: number; endLine: number; narration: string; tourTitle?: string }`.
- `AskAboutStepParams { workspaceRoot: string; question: string; context: StepQaContext; model?: string; maxBudgetUsd?: number }`.
- `AskAboutStepResult { answer: string }`.
- Add `"answering"` to the `GenerationPhase` union (additive) so the existing `hdtw/generationProgress` notification carries token/cost during the answer. Auth / budget / cancel reuse the existing `GENERATION_AUTH_REQUIRED` / `GENERATION_BUDGET_EXCEEDED` / `GENERATION_FAILED` codes and JSON-RPC cancellation.

## Engine-server

- **`StepAnswerer` port** (mirrors `TourGenerator`): `answer(workspaceRoot, context, question, model, maxBudgetUsd, hooks): Promise<string>`.
  - **`ClaudeStepAnswerer`** — an Agent SDK `query` with `tools: ["Read","Grep","Glob"]`, `maxTurns: 6`, a Q&A system prompt ("You are a principal engineer answering a colleague's follow-up about a specific piece of code. Answer concisely in Markdown; ground every claim in what you read; if the question is outside this code, say so briefly."). The user prompt embeds the context (file, line range, the step narration) + the question. The agent's final result text **is** the answer (prose — no JSON parsing). Honors the abort signal; streams usage via `onProgress` (phase `"answering"`); maps auth errors to `AuthRequiredError`.
  - **`FakeStepAnswerer`** — deterministic, selected by `HDTW_GENERATOR=fake`.
- **`hdtw/askAboutStep` handler** runs the answerer with a per-request `AbortController` (fed by JSON-RPC cancellation) and a budget guard (progress hook aborts when `estimatedCostUsd > maxBudgetUsd`), reusing the Chunk 2 abort/budget shape. Maps `AuthRequiredError`/`BudgetExceededError`/`GenerationCancelledError`/`GenerationFailedError` to their existing codes. Observer: `qa.asked`, `qa.answered`.

## VS Code client

- `EngineClient.askAboutStep(params, onProgress, cancellation): Promise<AskAboutStepResult>` — mirrors `generateTour`'s progress-subscription + `CancellationTokenSource` wiring.
- **WalkController:**
  - Sets the narration thread `canReply = true` and the comment controller's reply prompt/placeholder.
  - Exposes `activeStepContext(): StepQaContext | undefined` (file + anchor range + narration + the active tour title).
  - `async askWhy(question: string, answer: (ctx: StepQaContext) => Promise<string>): Promise<void>` — appends the user's question comment + a "🧠 thinking…" comment to the active thread, awaits `answer(ctx)`, then replaces the placeholder with the answer comment; on failure replaces it with a legible error/auth comment. All thread manipulation stays in the controller; the engine call is injected (no `EngineClient` dependency in the controller — same pattern as `followRelated`/`reanchorStep`).
- **Reply wiring:** a `comments/commentThread/context` submit button (the documented VS Code comment-sample pattern, `commentController == hdtw-tour`) → a new `hdtw.askWhy` command that receives a `vscode.CommentReply`, wraps the engine call in a cancellable `withProgress` (showing tokens/cost), and calls `walk.askWhy(reply.text, (ctx) => client.askAboutStep(...))`.

## Error handling

- No auth → the thinking placeholder becomes "Set your Anthropic API key to ask follow-ups." with the existing **Set API Key** action.
- Budget exceeded / cancelled → the placeholder becomes a short notice; the walk is otherwise untouched.
- An engine/agent failure → a "couldn't answer that — try rephrasing" comment. The Q&A never breaks the walk.

## Testing

- **engine-server:** `askAboutStep` over stdio with `FakeStepAnswerer` (`HDTW_GENERATOR=fake`): a question returns the fake answer and emits an `answering` progress event; a fake configured to throw an auth/budget error maps to the right code. The answerer's prompt-building (context → user prompt string) is unit-tested as a pure helper.
- **vscode:** the reply → thinking → answer thread flow is the F5 dogfood (the Comments reply UI isn't unit-testable); any pure helper (e.g. building `StepQaContext` from a walk state, or formatting the thinking/answer bodies) gets a unit test.

## Out of scope

Persisting Q&A into the saved tour (it's deliberately ephemeral); multi-turn conversation memory across questions (each question is answered fresh with the step context); a generated sub-tour from a question (that's the related-tours path, already shipped).

## Conventions carried forward

`@made-i-t/hdtw-*` scope; `.js` relative imports; engine-core stays pure (untouched here); the engine never trusts agent data (the answer is prose shown read-only; the agent is read-only and capped); observability via the injected observer; clients import code only from the protocol package.
