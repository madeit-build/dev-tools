import type { StepQaContext } from "@made-i-t/hdtw-protocol";
import { GenerationCancelledError } from "./tourGenerator.js";
import type { GenerationHooks } from "./tourGenerator.js";
import type { StepAnswerer } from "./stepAnswerer.js";

export interface FakeStepAnswererOptions {
  answer?: string;
  costPerEvent?: number;
}

export class FakeStepAnswerer implements StepAnswerer {
  constructor(private readonly options: FakeStepAnswererOptions = {}) {}

  async answer(
    _workspaceRoot: string,
    _context: StepQaContext,
    question: string,
    _model: string | undefined,
    hooks: GenerationHooks
  ): Promise<string> {
    hooks.onProgress({
      phase: "answering",
      message: "Answering",
      tokensIn: 500,
      tokensOut: 200,
      estimatedCostUsd: this.options.costPerEvent ?? 0.01,
    });
    if (hooks.signal.aborted) {
      throw new GenerationCancelledError("answer aborted");
    }
    return this.options.answer ?? `Fake answer to: ${question}`;
  }
}
