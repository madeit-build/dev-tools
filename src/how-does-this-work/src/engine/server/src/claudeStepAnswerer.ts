import { query } from "@anthropic-ai/claude-agent-sdk";
import type { StepQaContext } from "@made-i-t/hdtw-protocol";
import {
  AuthRequiredError,
  GenerationCancelledError,
  GenerationFailedError,
  type GenerationHooks,
} from "./tourGenerator.js";
import {
  buildStepAnswerPrompt,
  STEP_ANSWER_SYSTEM_PROMPT,
  type StepAnswerer,
} from "./stepAnswerer.js";

const ESTIMATED_USD_PER_INPUT_TOKEN = 3 / 1_000_000;
const ESTIMATED_USD_PER_OUTPUT_TOKEN = 15 / 1_000_000;
const MAX_ANSWER_TURNS = 6;

export class ClaudeStepAnswerer implements StepAnswerer {
  async answer(
    workspaceRoot: string,
    context: StepQaContext,
    question: string,
    model: string | undefined,
    hooks: GenerationHooks,
  ): Promise<string> {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    hooks.signal.addEventListener("abort", onAbort, { once: true });

    let tokensIn = 0;
    let tokensOut = 0;
    let resultText: string | undefined;

    try {
      const response = query({
        prompt: buildStepAnswerPrompt(context, question),
        options: {
          cwd: workspaceRoot,
          model,
          maxTurns: MAX_ANSWER_TURNS,
          tools: ["Read", "Grep", "Glob"],
          systemPrompt: STEP_ANSWER_SYSTEM_PROMPT,
          abortController,
        },
      });

      for await (const message of response) {
        if (message.type === "assistant") {
          const usage = message.message.usage;
          tokensIn += usage?.input_tokens ?? 0;
          tokensOut += usage?.output_tokens ?? 0;
          hooks.observer.logger.debug("qa.usage", { tokensIn, tokensOut });
          hooks.onProgress({
            phase: "answering",
            message: "Answering your question",
            tokensIn,
            tokensOut,
            estimatedCostUsd:
              tokensIn * ESTIMATED_USD_PER_INPUT_TOKEN
              + tokensOut * ESTIMATED_USD_PER_OUTPUT_TOKEN,
          });
        }
        if (message.type === "result") {
          if (message.subtype === "success") {
            resultText = message.result;
          } else {
            throw new GenerationFailedError(
              `agent run ended without a result (${message.subtype})`,
            );
          }
        }
      }
    } catch (error) {
      if (hooks.signal.aborted) {
        throw new GenerationCancelledError("answer aborted");
      }
      if (isAuthError(error)) {
        throw new AuthRequiredError(
          "No Anthropic credentials found. Set an API key (HDTW: Set Anthropic API Key) or log in to Claude Code.",
        );
      }
      throw error;
    } finally {
      hooks.signal.removeEventListener("abort", onAbort);
    }

    if (resultText === undefined || resultText.trim().length === 0) {
      throw new GenerationFailedError("the agent produced no answer");
    }
    return resultText;
  }
}

function isAuthError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /api key|authentication|unauthorized|401|not logged in|credential|billing/i.test(
    text,
  );
}
