# Design: OpenAI-Compatible BYOM — Q&A ("Why?" detours)

**Date:** 2026-06-15
**Status:** Approved
**Context:** Completes BYOM consistency. Generation BYOM shipped; this gives the **`StepAnswerer` port** (Chunk 3b "Why?" detours) an OpenAI-compatible backend so the `provider` setting governs Q&A too. A near-exact mirror of the generation BYOM, sharing the explore-tool layer and the OpenAI tool-calling loop.

## Goal

When a user replies to a step's narration with a follow-up, route the Q&A to the configured provider (OpenAI / OpenRouter / Ollama / Gemini-compat) instead of always Claude. The `StepAnswerer.answer(...)` returns prose (the model's final text), so the Q&A loop is the generation loop with a different finalizer (return the text vs. `parseDraft` it) and a tighter turn cap.

**Definition of done (dogfood):** with `hdtw.generation.provider = "openai"` + a configured endpoint, walk a tour, reply "why is it done this way?" to a step, and get a grounded answer from the OpenAI-compatible model; flip back to `anthropic` and confirm Q&A still uses Claude.

## Decisions

- **Share the loop.** Extract the OpenAI tool-calling explore loop out of `OpenAiAgentTourGenerator` into a reusable `runOpenAiToolLoop(...)`; generation finalizes with `parseDraft`, Q&A returns the text directly. One loop, two finalizers — no duplication, the backends stay consistent.
- **Reuse everything else:** the `exploreTools` layer, the `ChatClient` injected-factory pattern, the `STEP_ANSWER_SYSTEM_PROMPT` + `buildStepAnswerPrompt` (Chunk 3b), the `runStepAnswer` budget/cancel pipeline, and the OpenAI key already flowing to the engine env (from generation BYOM — no new secret).
- **maxTurns 6** for Q&A (capped, per Chunk 3b — a quick "why" stays quick).
- **Generation parity:** `AskAboutStepParams` gains the same additive `provider`/`baseUrl`/pricing fields as `GenerateTourParams`.

## Architecture

```
src/engine/server/src/
  openaiToolLoop.ts        (NEW) runOpenAiToolLoop(client, model, systemPrompt,
        userPrompt, { maxTurns, phase, progressMessage }, hooks) => Promise<string>
        — the messages/tool-dispatch/usage-progress/cancel/auth loop; returns the
        final assistant text. Exports ChatClient/ChatMessage/ToolCall/ChatResponse.
  openaiTourGenerator.ts   (REFACTOR) runLoop -> runOpenAiToolLoop(...) then parseDraft(result)
  openaiStepAnswerer.ts    (NEW) OpenAiStepAnswerer implements StepAnswerer:
        answer(...) -> runOpenAiToolLoop(client, model, STEP_ANSWER_SYSTEM_PROMPT,
        buildStepAnswerPrompt(context, question), { maxTurns: 6, phase: "answering",
        progressMessage: "Model answering" }, hooks); empty result -> GenerationFailedError
  stepAnswerPipeline.ts    (MODIFY) createStepAnswerer(params) provider-aware
  main.ts                  (MODIFY) askAboutStep handler -> createStepAnswerer(params)
```

`engine-core` untouched (pure). `runStepAnswer` (budget/cancel/observer) unchanged — the answerer is just selected by provider.

## `runOpenAiToolLoop` (extracted)

Signature:

```ts
export async function runOpenAiToolLoop(
  client: ChatClient,
  model: string | undefined,
  systemPrompt: string,
  userPrompt: string,
  opts: {
    maxTurns: number;
    phase: GenerationProgressParams["phase"];
    progressMessage: string;
    usdPer1kInput?: number;
    usdPer1kOutput?: number;
    workspaceRoot: string;
  },
  hooks: GenerationHooks,
): Promise<string>;
```

Body = today's `OpenAiAgentTourGenerator.runLoop` verbatim, except the terminal `return parseDraft(content)` becomes `return content` (the final assistant text). Generation's `runLoop` becomes: `const text = await runOpenAiToolLoop(...); return parseDraft(text);`. The `ChatClient`/message types move here; `openaiTourGenerator.ts` imports them.

## `OpenAiStepAnswerer`

```ts
export class OpenAiStepAnswerer implements StepAnswerer {
  constructor(
    private readonly clientFactory: () => ChatClient,
    private readonly options: {
      usdPer1kInput?: number;
      usdPer1kOutput?: number;
    },
  ) {}
  async answer(
    workspaceRoot,
    context,
    question,
    model,
    hooks,
  ): Promise<string> {
    const text = await runOpenAiToolLoop(
      this.clientFactory(),
      model,
      STEP_ANSWER_SYSTEM_PROMPT,
      buildStepAnswerPrompt(context, question),
      {
        maxTurns: 6,
        phase: "answering",
        progressMessage: "Model answering",
        usdPer1kInput: this.options.usdPer1kInput,
        usdPer1kOutput: this.options.usdPer1kOutput,
        workspaceRoot,
      },
      hooks,
    );
    if (text.trim().length === 0)
      throw new GenerationFailedError("model returned an empty answer");
    return text;
  }
}
```

Mirrors `ClaudeStepAnswerer` (empty-guard included). Read-only tools, capped, cancellable, budget-guarded by `runStepAnswer`.

## Protocol

`AskAboutStepParams` gains (additive, mirroring `GenerateTourParams`):

```ts
  provider?: "anthropic" | "openai";
  baseUrl?: string;
  usdPer1kInput?: number;
  usdPer1kOutput?: number;
```

## Factory

```ts
export function createStepAnswerer(params: AskAboutStepParams): StepAnswerer {
  if (process.env.HDTW_GENERATOR === "fake")
    return new FakeStepAnswerer({
      throwAuth: process.env.HDTW_FAKE_AUTH_ERROR === "1",
    });
  if (params.provider === "openai") {
    return new OpenAiStepAnswerer(
      () =>
        new OpenAI({
          apiKey: process.env.OPENAI_API_KEY ?? "ollama",
          baseURL: params.baseUrl,
        }) as unknown as ChatClient,
      {
        usdPer1kInput: params.usdPer1kInput,
        usdPer1kOutput: params.usdPer1kOutput,
      },
    );
  }
  return new ClaudeStepAnswerer();
}
```

The `askAboutStep` handler in `main.ts` calls `createStepAnswerer(params)`.

## VS Code

`askWhy` reads the existing `hdtw.generation` provider config (already contributed for generation BYOM) and includes `provider`/`baseUrl`/`usdPer1k*` in the `askAboutStep` params (undefined for the anthropic default). No new settings, no new secret — the OpenAI key already reaches the engine env at spawn.

## Error handling

Identical to generation BYOM, mapped through the existing askAboutStep handler: auth (401/403) → `AuthRequiredError` → `GENERATION_AUTH_REQUIRED` (the provider-aware "Set API Key" affordance from Chunk 3b); budget → `GENERATION_BUDGET_EXCEEDED`; cancel → request-cancelled; other/empty → `GENERATION_FAILED` (the thinking placeholder becomes a legible notice; the walk never breaks).

## Testing

- **`runOpenAiToolLoop`** (mock `ChatClient`): tool-call → result → final text (correct message ordering); 401 → `AuthRequiredError`; maxTurns exhaustion → `GenerationFailedError`. (Moves/retargets the existing `openaiTourGenerator` loop tests.)
- **`openaiTourGenerator`**: still green after the refactor (generation path = loop + `parseDraft`).
- **`OpenAiStepAnswerer`** (mock client): returns the model's prose as the answer; empty → `GenerationFailedError`.
- **Factory:** `createStepAnswerer` selects fake / openai / claude default.
- **Protocol:** `AskAboutStepParams` accepts the new fields additively.
- **e2e:** the askAboutStep stdio path stays on `HDTW_GENERATOR=fake` (provider-blind). Real provider calls are F5/manual.

## Out of scope

Nothing new — this closes BYOM. (Marketplace packaging remains the other v1 gate.)

## Conventions carried forward

`@made-i-t/hdtw-*`; engine-server stays the only impure home; engine-core untouched (pure); the engine never trusts agent data (the answer is untrusted prose shown read-only, as in Chunk 3b); read-only path-guarded explore tools; additive protocol/config (no `schemaVersion` change; Claude defaults unchanged).
