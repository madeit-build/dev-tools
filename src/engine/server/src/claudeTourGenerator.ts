import {
  AuthRequiredError,
  type DraftTour,
  type GenerationHooks,
  type TourGenerator,
} from "./tourGenerator.js";

/** Replaced with the real Agent SDK implementation in the next task. */
export class ClaudeAgentTourGenerator implements TourGenerator {
  async generate(): Promise<DraftTour> {
    throw new AuthRequiredError("Claude agent generator not yet implemented");
  }

  async repair(
    _workspaceRoot: string,
    _topic: string,
    _draft: DraftTour,
    _anchorErrors: string[],
    _hooks: GenerationHooks
  ): Promise<DraftTour> {
    throw new AuthRequiredError("Claude agent generator not yet implemented");
  }
}
