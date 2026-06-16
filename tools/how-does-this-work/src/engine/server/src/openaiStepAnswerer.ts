import { GenerationFailedError, type GenerationHooks } from "./tourGenerator.js";
import type { StepQaContext } from "@made-i-t/hdtw-protocol";
import type { StepAnswerer } from "./stepAnswerer.js";
import { STEP_ANSWER_SYSTEM_PROMPT, buildStepAnswerPrompt } from "./stepAnswerer.js";
import { runOpenAiToolLoop, type ChatClient } from "./openaiToolLoop.js";

export interface OpenAiAnswererOptions {
  usdPer1kInput?: number;
  usdPer1kOutput?: number;
}

export class OpenAiStepAnswerer implements StepAnswerer {
  constructor(
    private readonly clientFactory: () => ChatClient,
    private readonly options: OpenAiAnswererOptions
  ) {}

  async answer(
    workspaceRoot: string,
    context: StepQaContext,
    question: string,
    model: string | undefined,
    hooks: GenerationHooks
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
      hooks
    );
    if (text.trim().length === 0) {
      throw new GenerationFailedError("model returned an empty answer");
    }
    return text;
  }
}
