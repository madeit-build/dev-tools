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
  | "saving"
  | "answering";

export interface GenerateTourParams {
  workspaceRoot: string;
  topic: string;
  /** Model override; omitted/empty means the agent SDK default. */
  model?: string;
  /** Abort when estimated cost crosses this (USD). Engine default applies when omitted. */
  maxBudgetUsd?: number;
  /** When false, generate without writing the tour to the catalog (ephemeral). Defaults to true. */
  save?: boolean;
  /** Generation backend. Defaults to "anthropic" (the Claude Agent SDK). */
  provider?: "anthropic" | "openai";
  /** OpenAI-compatible base URL (only when provider is "openai"). */
  baseUrl?: string;
  /** Optional budget pricing for non-Anthropic providers (USD per 1k tokens). */
  usdPer1kInput?: number;
  /** Optional budget pricing for non-Anthropic providers (USD per 1k tokens). */
  usdPer1kOutput?: number;
}

export interface GenerateTourResult {
  tour: Tour;
  /** Workspace-root-relative path of the written tour file; absent when save was false. */
  savedPath?: string;
}

export interface GenerationProgressParams {
  phase: GenerationPhase;
  message: string;
  tokensIn: number;
  tokensOut: number;
  /** Rough mid-flight estimate; the final result message is authoritative. */
  estimatedCostUsd: number;
}

/** JSON-RPC method: client→engine, persist a (previously generated, in-memory) tour into the catalog. */
export const SAVE_TOUR_METHOD = "hdtw/saveTour";

/** A tour could not be saved to the catalog (message carries detail). */
export const SAVE_TOUR_FAILED_ERROR_CODE = -32005;

export interface SaveTourParams {
  workspaceRoot: string;
  tour: Tour;
}

export interface SaveTourResult {
  savedPath: string;
}

/** JSON-RPC method: client→engine, answer a follow-up question about the current tour step. */
export const ASK_ABOUT_STEP_METHOD = "hdtw/askAboutStep";

export interface StepQaContext {
  file: string;
  startLine: number;
  endLine: number;
  narration: string;
  tourTitle?: string;
}

export interface AskAboutStepParams {
  workspaceRoot: string;
  question: string;
  context: StepQaContext;
  model?: string;
  maxBudgetUsd?: number;
  /** Generation backend. Defaults to "anthropic". */
  provider?: "anthropic" | "openai";
  /** OpenAI-compatible base URL (only when provider is "openai"). */
  baseUrl?: string;
  usdPer1kInput?: number;
  usdPer1kOutput?: number;
}

export interface AskAboutStepResult {
  answer: string;
}
