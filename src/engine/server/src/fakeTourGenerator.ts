import type {
  DraftTour,
  GenerationHooks,
  TourGenerator,
} from "./tourGenerator.js";
import { GenerationCancelledError } from "./tourGenerator.js";

export interface FakeTourGeneratorOptions {
  /** First generate() returns this draft; defaults to a valid one-step draft. */
  draft?: DraftTour;
  /** Draft returned by repair(); defaults to the same valid draft. */
  repairedDraft?: DraftTour;
  /** Cost reported per progress event (drives budget tests). */
  costPerEvent?: number;
}

const DEFAULT_DRAFT: DraftTour = {
  title: "Fake tour",
  summary: "A deterministic tour for tests",
  steps: [
    {
      title: "The readme",
      narration: "This is the readme of the workspace.",
      anchor: { file: "README.md", startLine: 1, endLine: 1 },
    },
  ],
};

export class FakeTourGenerator implements TourGenerator {
  private runningCostUsd = 0;

  constructor(private readonly options: FakeTourGeneratorOptions = {}) {}

  async generate(
    _workspaceRoot: string,
    topic: string,
    _model: string | undefined,
    hooks: GenerationHooks
  ): Promise<DraftTour> {
    this.emit(hooks, "exploring", `Exploring for "${topic}"`, 1000, 200);
    this.throwIfAborted(hooks);
    this.emit(hooks, "drafting", "Drafting tour", 2000, 800);
    this.throwIfAborted(hooks);
    return this.options.draft ?? DEFAULT_DRAFT;
  }

  async repair(
    _workspaceRoot: string,
    _topic: string,
    _draft: DraftTour,
    _anchorErrors: string[],
    hooks: GenerationHooks
  ): Promise<DraftTour> {
    this.emit(hooks, "repairing", "Repairing anchors", 500, 200);
    this.throwIfAborted(hooks);
    return this.options.repairedDraft ?? DEFAULT_DRAFT;
  }

  private emit(
    hooks: GenerationHooks,
    phase: "exploring" | "drafting" | "repairing",
    message: string,
    tokensIn: number,
    tokensOut: number
  ): void {
    hooks.onProgress({
      phase,
      message,
      tokensIn,
      tokensOut,
      estimatedCostUsd: (this.runningCostUsd += this.options.costPerEvent ?? 0.01),
    });
  }

  private throwIfAborted(hooks: GenerationHooks): void {
    if (hooks.signal.aborted) {
      throw new GenerationCancelledError("fake generator aborted");
    }
  }
}
