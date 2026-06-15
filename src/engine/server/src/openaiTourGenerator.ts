import {
  AuthRequiredError,
  GenerationCancelledError,
  GenerationFailedError,
  type DraftTour,
  type GenerationHooks,
  type TourGenerator,
} from "./tourGenerator.js";
import type { TourSummary } from "@made-i-t/hdtw-protocol";
import { SYSTEM_PROMPT, generatePrompt, repairPrompt, parseDraft } from "./generationPrompt.js";
import { EXPLORE_TOOL_DEFS, dispatchExploreTool } from "./exploreTools.js";

export interface ChatClient {
  chat: {
    completions: {
      create(
        body: { model: string; messages: ChatMessage[]; tools: typeof EXPLORE_TOOL_DEFS; tool_choice: "auto" },
        options?: { signal?: AbortSignal }
      ): Promise<ChatResponse>;
    };
  };
}

interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
interface ChatResponse {
  choices: { message: { role: "assistant"; content: string | null; tool_calls?: ToolCall[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface OpenAiGeneratorOptions { maxTurns?: number; usdPer1kInput?: number; usdPer1kOutput?: number }

const DEFAULT_MAX_TURNS = 40;

export class OpenAiAgentTourGenerator implements TourGenerator {
  constructor(
    private readonly clientFactory: () => ChatClient,
    private readonly options: OpenAiGeneratorOptions
  ) {}

  generate(workspaceRoot: string, topic: string, model: string | undefined, catalog: TourSummary[], hooks: GenerationHooks): Promise<DraftTour> {
    return this.runLoop(workspaceRoot, model, generatePrompt(topic, catalog), "exploring", hooks);
  }

  repair(workspaceRoot: string, topic: string, model: string | undefined, _catalog: TourSummary[], draft: DraftTour, anchorErrors: string[], hooks: GenerationHooks): Promise<DraftTour> {
    return this.runLoop(workspaceRoot, model, repairPrompt(topic, draft, anchorErrors), "repairing", hooks);
  }

  private async runLoop(workspaceRoot: string, model: string | undefined, userPrompt: string, phase: "exploring" | "repairing", hooks: GenerationHooks): Promise<DraftTour> {
    const client = this.clientFactory();
    const maxTurns = this.options.maxTurns ?? DEFAULT_MAX_TURNS;
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ];
    let tokensIn = 0;
    let tokensOut = 0;

    for (let turn = 0; turn < maxTurns; turn += 1) {
      if (hooks.signal.aborted) throw new GenerationCancelledError("generation aborted");
      let res: ChatResponse;
      try {
        res = await client.chat.completions.create(
          { model: model ?? "gpt-4o", messages, tools: EXPLORE_TOOL_DEFS, tool_choice: "auto" },
          { signal: hooks.signal }
        );
      } catch (error) {
        if (hooks.signal.aborted) throw new GenerationCancelledError("generation aborted");
        if (isAuthError(error)) throw new AuthRequiredError("No credentials for the configured model provider. Set an API key (HDTW: Set API Key).");
        throw new GenerationFailedError(error instanceof Error ? error.message : String(error));
      }

      tokensIn += res.usage?.prompt_tokens ?? 0;
      tokensOut += res.usage?.completion_tokens ?? 0;
      hooks.onProgress({
        phase,
        message: phase === "exploring" ? "Model exploring the codebase" : "Model repairing anchors",
        tokensIn,
        tokensOut,
        estimatedCostUsd: (tokensIn / 1000) * (this.options.usdPer1kInput ?? 0) + (tokensOut / 1000) * (this.options.usdPer1kOutput ?? 0),
      });

      const message = res.choices[0]?.message;
      if (message?.tool_calls?.length) {
        messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });
        for (const call of message.tool_calls) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(call.function.arguments) as Record<string, unknown>; } catch { args = {}; }
          const text = await dispatchExploreTool(workspaceRoot, call.function.name, args);
          hooks.observer.logger.debug("agent.tool", { tool: call.function.name, args });
          messages.push({ role: "tool", tool_call_id: call.id, content: text });
        }
        continue;
      }

      return parseDraft(message?.content ?? "");
    }
    throw new GenerationFailedError(`model did not produce a tour within ${maxTurns} turns`);
  }
}

function isAuthError(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  if (status === 401 || status === 403) return true;
  const text = error instanceof Error ? error.message : String(error);
  return /api key|authentication|unauthorized|401|403|credential/i.test(text);
}
