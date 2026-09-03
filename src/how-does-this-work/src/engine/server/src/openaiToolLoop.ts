import {
  AuthRequiredError,
  GenerationCancelledError,
  GenerationFailedError,
  type GenerationHooks,
} from "./tourGenerator.js";
import type { GenerationProgressParams } from "@made-i-t/hdtw-protocol";
import { EXPLORE_TOOL_DEFS, dispatchExploreTool } from "./exploreTools.js";

export interface ChatClient {
  chat: { completions: { create(body: { model: string; messages: ChatMessage[]; tools: typeof EXPLORE_TOOL_DEFS; tool_choice: "auto" }, options?: { signal?: AbortSignal }): Promise<ChatResponse> } };
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

export interface ToolLoopOptions {
  maxTurns: number;
  phase: GenerationProgressParams["phase"];
  progressMessage: string;
  usdPer1kInput?: number;
  usdPer1kOutput?: number;
  workspaceRoot: string;
}

/** Run the OpenAI tool-calling explore loop; return the model's final assistant text. */
export async function runOpenAiToolLoop(
  client: ChatClient,
  model: string | undefined,
  systemPrompt: string,
  userPrompt: string,
  opts: ToolLoopOptions,
  hooks: GenerationHooks
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
  let tokensIn = 0;
  let tokensOut = 0;
  for (let turn = 0; turn < opts.maxTurns; turn += 1) {
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
      phase: opts.phase,
      message: opts.progressMessage,
      tokensIn,
      tokensOut,
      estimatedCostUsd: (tokensIn / 1000) * (opts.usdPer1kInput ?? 0) + (tokensOut / 1000) * (opts.usdPer1kOutput ?? 0),
    });
    const message = res.choices[0]?.message;
    if (message?.tool_calls?.length) {
      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });
      for (const call of message.tool_calls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments) as Record<string, unknown>; } catch { args = {}; }
        const text = await dispatchExploreTool(opts.workspaceRoot, call.function.name, args);
        hooks.observer.logger.debug("agent.tool", { tool: call.function.name, args });
        messages.push({ role: "tool", tool_call_id: call.id, content: text });
      }
      continue;
    }
    return message?.content ?? "";
  }
  throw new GenerationFailedError(`model did not finish within ${opts.maxTurns} turns`);
}

export function isAuthError(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  if (status === 401 || status === 403) return true;
  const text = error instanceof Error ? error.message : String(error);
  return /api key|authentication|unauthorized|401|403|credential/i.test(text);
}
