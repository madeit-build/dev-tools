import {
  type DraftTour,
  type GenerationHooks,
  type TourGenerator,
} from "./tourGenerator.js";
import type { TourSummary } from "@made-i-t/hdtw-protocol";
import { SYSTEM_PROMPT, generatePrompt, repairPrompt, parseDraft } from "./generationPrompt.js";
import { runOpenAiToolLoop, type ChatClient } from "./openaiToolLoop.js";

export type { ChatClient } from "./openaiToolLoop.js";

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
    const text = await runOpenAiToolLoop(
      this.clientFactory(), model, SYSTEM_PROMPT, userPrompt,
      { maxTurns: this.options.maxTurns ?? DEFAULT_MAX_TURNS, phase,
        progressMessage: phase === "exploring" ? "Model exploring the codebase" : "Model repairing anchors",
        usdPer1kInput: this.options.usdPer1kInput, usdPer1kOutput: this.options.usdPer1kOutput, workspaceRoot },
      hooks
    );
    return parseDraft(text);
  }
}
