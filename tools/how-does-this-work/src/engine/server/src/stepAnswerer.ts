import type { StepQaContext } from "@made-i-t/hdtw-protocol";
import type { GenerationHooks } from "./tourGenerator.js";

export interface StepAnswerer {
  answer(
    workspaceRoot: string,
    context: StepQaContext,
    question: string,
    model: string | undefined,
    hooks: GenerationHooks
  ): Promise<string>;
}

export const STEP_ANSWER_SYSTEM_PROMPT = `You are a principal engineer answering a teammate's follow-up question about a specific piece of code they are looking at during a guided code tour.

- Answer in Markdown, concisely — a short paragraph, occasionally a tiny snippet.
- Ground every claim in code you actually read with your tools: read the anchored file, and follow references (Grep/Glob/Read) only as far as needed to answer.
- If the question is outside the scope of this code, say so briefly rather than speculating.`;

/** Pure: build the user prompt from the step context + question. */
export function buildStepAnswerPrompt(context: StepQaContext, question: string): string {
  return `A teammate paused on this step of the tour "${context.tourTitle ?? "(untitled)"}".

File: ${context.file} (lines ${context.startLine}-${context.endLine})

The step's narration:
"""
${context.narration}
"""

Their follow-up question:
"""
${question}
"""

Read the anchored code (follow references if needed) and answer it.`;
}
