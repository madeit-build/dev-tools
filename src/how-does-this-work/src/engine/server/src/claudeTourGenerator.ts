import { query } from "@anthropic-ai/claude-agent-sdk";
import { createCodemapMcpServer } from "./codemapTools.js";
import {
  AuthRequiredError,
  GenerationCancelledError,
  GenerationFailedError,
  type DraftTour,
  type GenerationHooks,
  type TourGenerator,
} from "./tourGenerator.js";
import {
  SYSTEM_PROMPT,
  generatePrompt,
  repairPrompt,
  parseDraft,
} from "./generationPrompt.js";

export { parseDraft } from "./generationPrompt.js";

// Rough mid-flight estimate only; the SDK's final result cost is authoritative.
// Sonnet-class list pricing per million tokens.
const ESTIMATED_USD_PER_INPUT_TOKEN = 3 / 1_000_000;
const ESTIMATED_USD_PER_OUTPUT_TOKEN = 15 / 1_000_000;

const MAX_GENERATE_TURNS = 40;
const MAX_REPAIR_TURNS = 15;

export class ClaudeAgentTourGenerator implements TourGenerator {
  async generate(
    workspaceRoot: string,
    topic: string,
    model: string | undefined,
    catalog: import("@made-i-t/hdtw-protocol").TourSummary[],
    hooks: GenerationHooks,
  ): Promise<DraftTour> {
    const prompt = generatePrompt(topic, catalog);
    return this.runQuery(
      workspaceRoot,
      prompt,
      model,
      MAX_GENERATE_TURNS,
      "exploring",
      hooks,
    );
  }

  async repair(
    workspaceRoot: string,
    topic: string,
    model: string | undefined,
    _catalog: import("@made-i-t/hdtw-protocol").TourSummary[],
    draft: DraftTour,
    anchorErrors: string[],
    hooks: GenerationHooks,
  ): Promise<DraftTour> {
    const prompt = repairPrompt(topic, draft, anchorErrors);
    return this.runQuery(
      workspaceRoot,
      prompt,
      model,
      MAX_REPAIR_TURNS,
      "repairing",
      hooks,
    );
  }

  private async runQuery(
    workspaceRoot: string,
    prompt: string,
    model: string | undefined,
    maxTurns: number,
    phase: "exploring" | "repairing",
    hooks: GenerationHooks,
  ): Promise<DraftTour> {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    hooks.signal.addEventListener("abort", onAbort, { once: true });

    let tokensIn = 0;
    let tokensOut = 0;
    let resultText: string | undefined;

    try {
      const codemap = createCodemapMcpServer(workspaceRoot);
      const response = query({
        prompt,
        options: {
          cwd: workspaceRoot,
          model,
          maxTurns,
          // Use `tools` to restrict the agent to read-only exploration tools.
          // `allowedTools` only controls auto-approval; `tools` controls availability.
          tools: [
            "Read",
            "Grep",
            "Glob",
            "mcp__codemap__fileOutline",
            "mcp__codemap__findSymbol",
          ],
          mcpServers: { codemap },
          systemPrompt: SYSTEM_PROMPT,
          abortController,
        },
      });

      for await (const message of response) {
        if (message.type === "assistant") {
          const usage = message.message.usage;
          tokensIn += usage?.input_tokens ?? 0;
          tokensOut += usage?.output_tokens ?? 0;
          for (const block of message.message.content) {
            if (block.type === "tool_use") {
              hooks.observer.logger.debug("agent.tool", {
                tool: block.name,
                input: block.input,
              });
            }
          }
          hooks.observer.logger.debug("agent.usage", {
            phase,
            tokensIn,
            tokensOut,
          });
          hooks.onProgress({
            phase,
            message:
              phase === "exploring"
                ? "Agent exploring the codebase"
                : "Agent repairing anchors",
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
        throw new GenerationCancelledError("generation aborted");
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

    if (resultText === undefined) {
      throw new GenerationFailedError("agent run produced no final result");
    }
    try {
      return parseDraft(resultText);
    } catch (error) {
      hooks.observer.logger.error("agent.parse_failed", {
        resultPreview: resultText.slice(0, 2000),
      });
      throw error;
    }
  }
}

function isAuthError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /api key|authentication|unauthorized|401|not logged in|credential|billing/i.test(
    text,
  );
}
