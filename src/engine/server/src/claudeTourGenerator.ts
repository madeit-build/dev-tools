import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  AuthRequiredError,
  GenerationCancelledError,
  GenerationFailedError,
  type DraftTour,
  type GenerationHooks,
  type TourGenerator,
} from "./tourGenerator.js";

// Rough mid-flight estimate only; the SDK's final result cost is authoritative.
// Sonnet-class list pricing per million tokens.
const ESTIMATED_USD_PER_INPUT_TOKEN = 3 / 1_000_000;
const ESTIMATED_USD_PER_OUTPUT_TOKEN = 15 / 1_000_000;

const MAX_GENERATE_TURNS = 40;
const MAX_REPAIR_TURNS = 15;

const SYSTEM_PROMPT = `You are a principal engineer creating a guided tour of a codebase for a new team member.

You will be given a topic. Explore the codebase with your tools (Read, Grep, Glob) until you genuinely understand how that topic works, from entrypoint to exit. Then produce a tour: 4 to 8 steps, each anchored to a specific range of lines in a specific file, ordered so a newcomer can follow the flow.

Rules for anchors:
- Before anchoring a step, Read the file and confirm the exact CURRENT line numbers of the code you are anchoring. Line numbers must be 1-based and inclusive.
- Anchor the smallest range that contains the construct you are explaining (a function, a block, a declaration) — typically 3 to 25 lines.
- File paths must be relative to the workspace root, using forward slashes.

Rules for narration:
- 2 to 4 sentences per step, in Markdown.
- Explain WHY the code is the way it is — patterns, architecture, intent — not just what it does. Speak like a senior engineer walking someone through the system.

Your FINAL message must be ONLY a fenced JSON block in exactly this shape, with no other prose:

\`\`\`json
{
  "title": "Short tour title",
  "summary": "One-sentence summary",
  "steps": [
    {
      "title": "Step title",
      "narration": "Markdown narration.",
      "anchor": { "file": "relative/path.ts", "startLine": 10, "endLine": 24 }
    }
  ]
}
\`\`\``;

export class ClaudeAgentTourGenerator implements TourGenerator {
  async generate(
    workspaceRoot: string,
    topic: string,
    model: string | undefined,
    _catalog: import("@made-i-t/hdtw-protocol").TourSummary[],
    hooks: GenerationHooks
  ): Promise<DraftTour> {
    const prompt = `Create a guided tour for this topic: ${topic}`;
    return this.runQuery(workspaceRoot, prompt, model, MAX_GENERATE_TURNS, "exploring", hooks);
  }

  async repair(
    workspaceRoot: string,
    topic: string,
    model: string | undefined,
    _catalog: import("@made-i-t/hdtw-protocol").TourSummary[],
    draft: DraftTour,
    anchorErrors: string[],
    hooks: GenerationHooks
  ): Promise<DraftTour> {
    const prompt = `You previously drafted this tour for the topic "${topic}":

\`\`\`json
${JSON.stringify(draft, null, 2)}
\`\`\`

These anchors failed verification against the actual files:
${anchorErrors.map((error) => `- ${error}`).join("\n")}

Re-read the affected files, fix ONLY the broken anchors (adjust line ranges or choose a better location), and output the corrected complete tour in the required fenced JSON format.`;
    return this.runQuery(workspaceRoot, prompt, model, MAX_REPAIR_TURNS, "repairing", hooks);
  }

  private async runQuery(
    workspaceRoot: string,
    prompt: string,
    model: string | undefined,
    maxTurns: number,
    phase: "exploring" | "repairing",
    hooks: GenerationHooks
  ): Promise<DraftTour> {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    hooks.signal.addEventListener("abort", onAbort, { once: true });

    let tokensIn = 0;
    let tokensOut = 0;
    let resultText: string | undefined;

    try {
      const response = query({
        prompt,
        options: {
          cwd: workspaceRoot,
          model,
          maxTurns,
          // Use `tools` to restrict the agent to read-only exploration tools.
          // `allowedTools` only controls auto-approval; `tools` controls availability.
          tools: ["Read", "Grep", "Glob"],
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
          hooks.observer.logger.debug("agent.usage", { phase, tokensIn, tokensOut });
          hooks.onProgress({
            phase,
            message: phase === "exploring" ? "Agent exploring the codebase" : "Agent repairing anchors",
            tokensIn,
            tokensOut,
            estimatedCostUsd:
              tokensIn * ESTIMATED_USD_PER_INPUT_TOKEN + tokensOut * ESTIMATED_USD_PER_OUTPUT_TOKEN,
          });
        }
        if (message.type === "result") {
          if (message.subtype === "success") {
            resultText = message.result;
          } else {
            throw new GenerationFailedError(
              `agent run ended without a result (${message.subtype})`
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
          "No Anthropic credentials found. Set an API key (HDTW: Set Anthropic API Key) or log in to Claude Code."
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
  return /api key|authentication|unauthorized|401|not logged in|credential|billing/i.test(text);
}

export function parseDraft(resultText: string): DraftTour {
  const fenced =
    [...resultText.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1] ?? resultText;
  let raw: unknown;
  try {
    raw = JSON.parse(fenced.trim());
  } catch {
    throw new GenerationFailedError("agent output was not valid JSON in the required format");
  }
  const errors = validateDraft(raw);
  if (errors.length > 0) {
    throw new GenerationFailedError(`agent output failed draft validation: ${errors.join("; ")}`);
  }
  return raw as DraftTour;
}

function validateDraft(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["draft must be a JSON object"];
  }
  const draft = value as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof draft.title !== "string" || draft.title.length === 0) errors.push("title missing");
  if (typeof draft.summary !== "string") errors.push("summary missing");
  if (!Array.isArray(draft.steps) || draft.steps.length === 0 || draft.steps.length > 12) {
    errors.push("steps must be a non-empty array of at most 12");
    return errors;
  }
  draft.steps.forEach((step, index) => {
    if (typeof step !== "object" || step === null) {
      errors.push(`steps[${index}] must be an object`);
      return;
    }
    const candidate = step as Record<string, unknown>;
    if (typeof candidate.title !== "string" || candidate.title.length === 0)
      errors.push(`steps[${index}].title missing`);
    if (typeof candidate.narration !== "string" || candidate.narration.length === 0)
      errors.push(`steps[${index}].narration missing`);
    const anchor = candidate.anchor as Record<string, unknown> | undefined;
    if (
      anchor === undefined ||
      typeof anchor.file !== "string" ||
      !Number.isInteger(anchor.startLine) ||
      !Number.isInteger(anchor.endLine)
    ) {
      errors.push(`steps[${index}].anchor incomplete`);
    }
  });
  return errors;
}
