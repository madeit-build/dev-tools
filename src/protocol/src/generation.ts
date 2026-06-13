import type { Tour } from "./tours.js";

/** JSON-RPC method name: client→engine, long-running cancellable tour generation. */
export const GENERATE_TOUR_METHOD = "hdtw/generateTour";

/** JSON-RPC notification: engine→client, progress for an in-flight generation. */
export const GENERATION_PROGRESS_NOTIFICATION = "hdtw/generationProgress";

/** Generation cannot run: no API key and no Claude Code credentials found. */
export const GENERATION_AUTH_REQUIRED_ERROR_CODE = -32002;

/** The agent could not produce a verifiable tour (message carries detail). */
export const GENERATION_FAILED_ERROR_CODE = -32003;

/** Estimated spend crossed maxBudgetUsd; generation was aborted (message carries spend). */
export const GENERATION_BUDGET_EXCEEDED_ERROR_CODE = -32004;

export type GenerationPhase =
  | "exploring"
  | "drafting"
  | "verifying"
  | "repairing"
  | "saving";

export interface GenerateTourParams {
  workspaceRoot: string;
  topic: string;
  /** Model override; omitted/empty means the agent SDK default. */
  model?: string;
  /** Abort when estimated cost crosses this (USD). Engine default applies when omitted. */
  maxBudgetUsd?: number;
}

export interface GenerateTourResult {
  tour: Tour;
  /** Workspace-root-relative path of the written tour file. */
  savedPath: string;
}

export interface GenerationProgressParams {
  phase: GenerationPhase;
  message: string;
  tokensIn: number;
  tokensOut: number;
  /** Rough mid-flight estimate; the final result message is authoritative. */
  estimatedCostUsd: number;
}
