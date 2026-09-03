# Design: OpenAI-Compatible BYOM — Generation (Chunk 5a)

**Date:** 2026-06-15
**Status:** Approved
**Context:** "Bring your own model." Adds a second tour-generation backend behind the existing `TourGenerator` port (Chunk 2) that drives any **OpenAI-compatible** endpoint — OpenAI, OpenRouter, Gemini's compat API, or a **local Ollama** (free, private, offline generation). Generation only; the "Why?" detour Q&A (`StepAnswerer`) stays Claude for now. Part of the marketplace v1 launch ("works with any model" headline), alongside a separate packaging chunk.

## Goal

Let a tour author generate tours with a non-Claude model by pointing HDTW at an OpenAI-compatible base URL. The Claude Agent SDK can't drive these, so we reimplement the read-only explore loop against the OpenAI tool-calling protocol — behind the same port, so **anchor verification, symbol resolution, the repair round, and drift are all unchanged and backend-blind**. Playback stays model-free; only authors are affected.

**Definition of done (dogfood):** with `hdtw.generation.provider = "openai"` and a local Ollama (or OpenAI key) configured, run "Generate Tour…" and get a verified, walkable tour — including at least one symbol-anchored step — with live token/cost progress and working cancel; then flip back to `provider = "anthropic"` and confirm the Claude path is unchanged.

## Decisions

- **One code path via the `openai` SDK + configurable `baseURL`.** "OpenAI-compatible" = the `openai` npm client pointed at any base URL. OpenAI, OpenRouter, Ollama, Gemini-compat are configuration, not new code.
- **Tool-calling required.** The explore loop depends on function-calling; a model/endpoint without it can't explore and errors clearly (no JSON-mode fallback in V1).
- **Shared read-only tool layer.** Extract provider-agnostic handlers so symbol-anchoring works on every backend: `read_file`/`grep`/`glob` (we now own these — the Claude SDK provided them built-in) plus the Chunk 4b `fileOutline`/`findSymbol`. All path-guarded, always return text.
- **Shared generation prompt.** The system prompt (anchor rules, symbol-anchor preference, final-JSON shape) and the fenced-JSON parse move to one module both backends use — byte-identical instructions; only the transport differs.
- **The engine still owns every line number.** A `DraftTour` from any backend goes through the same verify + symbol-resolve + repair. The trust model is backend-independent.
- **Generation only.** Q&A BYOM (an `OpenAiStepAnswerer`) is a deferred follow-up.

## Architecture

```
src/engine/server/src/
  exploreTools.ts        (NEW) provider-agnostic read-only handlers:
       read_file, grep, glob (in-process, path-guarded) +
       runFileOutlineTool, runFindSymbolTool (reused from Chunk 4b)
       each: (workspaceRoot, args) => Promise<string>   (always returns text)
  generationPrompt.ts    (NEW) shared SYSTEM_PROMPT + parseTourJson(text) -> DraftTour
       (extracted from claudeTourGenerator; Claude path switches to import it)
  openaiTourGenerator.ts (NEW) OpenAiAgentTourGenerator implements TourGenerator
       openai SDK { baseURL, apiKey, model }; manual explore loop; injected client
  tourGeneratorFactory   (selection) HDTW_GENERATOR=fake -> fake;
       else provider -> "openai" | "anthropic" (default)
```

`engine-core` is untouched (pure). The verification pipeline (`runGeneration`, `verifyStep`, symbol resolution, repair, drift) is unchanged.

## The explore loop (`OpenAiAgentTourGenerator`)

```
client = new OpenAI({ baseURL, apiKey })
messages = [ system(SYSTEM_PROMPT), user(topic + catalogSection(catalog)) ]
for turn in 1..maxTurns:                         // maxTurns is the hard guard
  res = await client.chat.completions.create(
          { model, messages, tools: TOOL_DEFS, tool_choice: "auto" },
          { signal })
  msg = res.choices[0].message
  accumulate res.usage.prompt_tokens / completion_tokens
  hooks.onProgress({ phase, message, tokensIn, tokensOut, estimatedCostUsd })
  if msg.tool_calls?.length:
    messages.push(msg)                            // assistant turn WITH tool_calls first (required)
    for call of msg.tool_calls:
      const text = await exploreTools[call.function.name](workspaceRoot, JSON.parse(call.function.arguments))
      messages.push({ role: "tool", tool_call_id: call.id, content: text })
    continue
  return parseTourJson(msg.content ?? "")         // shared fence-parse -> DraftTour
throw new GenerationFailedError("agent did not produce a tour within N turns")
```

- **Tools.** `read_file`, `grep`, `glob`, `fileOutline`, `findSymbol` as OpenAI function schemas; handlers are `exploreTools` (path-guarded; a bad/absent path returns an error string, never throws, so the loop continues).
- **`generate` vs `repair`.** Same loop; `repair` seeds the messages with the repair prompt (the existing repair-prompt text moves to `generationPrompt.ts`).
- **Cancel.** `hooks.signal` → the SDK `signal`; an aborted request throws → `GenerationCancelledError`.
- **Budget.** Reuses `runGeneration`'s hook: `estimatedCostUsd > maxBudgetUsd` → abort → `BudgetExceededError`. Cost = tokens × optional `usdPer1k{Input,Output}`; unset (e.g. Ollama) → cost 0, so **`maxTurns` is the guard**. The loop is always bounded.
- **Auth.** A 401 / authentication error → `AuthRequiredError` (the existing Set-Key flow generalizes). Other failures → `GenerationFailedError`. Unparseable final JSON → `GenerationFailedError` (the engine's repair round still applies, as for Claude).
- **Testability.** The OpenAI client is **injected** (constructor), so unit tests pass a mock that scripts `tool_calls` → final tour JSON — fully offline.

## Configuration & auth

All additive under `hdtw.generation` (Claude users change nothing — defaults preserve today's behavior):

- `provider`: `"anthropic"` (default) | `"openai"`.
- `baseUrl`: OpenAI-compatible endpoint (`https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, `http://localhost:11434/v1`, …).
- `model`: existing setting, reused (the provider's model id).
- `usdPer1kInput` / `usdPer1kOutput`: optional budget pricing; omit for free/local.

**Auth flow mirrors the Claude path:** the API key lives in VS Code SecretStorage and is passed to the engine as an env var at spawn (like `ANTHROPIC_API_KEY` today) — secrets never ride the JSON-RPC wire. `hdtw.setApiKey` becomes provider-aware (stores the OpenAI key when provider is openai; Ollama needs no key). `GenerateTourParams` gains optional `provider` and `baseUrl` (model already present); the engine's factory selects the generator and reads the key from env. Pricing fields flow via params.

## Error handling

- No/invalid key → `AuthRequiredError` → the existing "Set API Key" affordance (provider-aware copy).
- Endpoint unreachable / model not found → `GenerationFailedError` with the provider's message surfaced.
- Model lacks tool-calling (no `tool_calls` ever, returns prose that isn't a tour) → the turn budget expires → `GenerationFailedError` advising a tool-calling-capable model.
- Tool execution failures return an error string into the loop (never throw) — the model can recover.
- Budget / cancel → the existing codes (`GENERATION_BUDGET_EXCEEDED` / cancellation), backend-independent.

## Testing

- **`OpenAiAgentTourGenerator`** (injected mock client): the loop executes tool calls, appends results in the required order (assistant-with-tool_calls before tool results), parses the draft, accumulates usage, honors abort + budget, and maps auth/failure errors. Fully offline.
- **`exploreTools`**: `read_file`/`grep`/`glob` correctness + path-traversal/absolute-path rejection; the codemap handlers already tested (Chunk 4b).
- **Factory**: provider selection (`fake` / `openai` / default `anthropic`).
- **Shared prompt**: `parseTourJson` extracts the fenced JSON (reuses/relocates the Claude path's parsing test).
- **e2e**: the full stdio path stays on `HDTW_GENERATOR=fake` (provider-blind). Real provider calls are F5/manual, exactly like the Claude SDK path today.

## Out of scope (deferred)

- Q&A BYOM — an `OpenAiStepAnswerer` for the "Why?" detours (next; reuses the loop + tool layer).
- Non-tool-calling models / JSON-mode fallback.
- Per-provider model catalogs and built-in pricing tables (pricing is user config).
- Streaming token output (single completion per turn is sufficient; progress is per-turn).
- Marketplace packaging / wasm bundling — a **separate v1-gating chunk** (the tree-sitter `.wasm` `require.resolve` lookups must survive a bundled `.vsix`).

## Conventions carried forward

`@made-i-t/hdtw-*` scope; engine-server stays the only impure home (new `openai` dependency lives there); engine-core untouched (pure); the engine never trusts agent-supplied anchors (every backend only drafts; the engine resolves/verifies); read-only, path-guarded exploration tools; observability via the injected observer; clients import code only from the protocol package; additive protocol/config (no `schemaVersion` bump; Claude defaults unchanged).
```
