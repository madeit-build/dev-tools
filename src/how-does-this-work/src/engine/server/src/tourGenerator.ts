import type { GenerationProgressParams, RelatedTour, TourSummary } from "@made-i-t/hdtw-protocol";
import type { Observer } from "@made-i-t/hdtw-observability";

export interface DraftAnchor {
  file: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
}

export interface DraftStep {
  title: string;
  narration: string;
  anchor: DraftAnchor;
  relatedTours?: RelatedTour[];
}

export interface DraftTour {
  title: string;
  summary: string;
  steps: DraftStep[];
}

export interface GenerationHooks {
  onProgress(progress: GenerationProgressParams): void;
  /** Aborted on client cancellation or budget breach. Implementations must stop promptly. */
  signal: AbortSignal;
  /** Structured logging + metrics for this generation run. */
  observer: Observer;
}

export interface TourGenerator {
  generate(
    workspaceRoot: string,
    topic: string,
    model: string | undefined,
    catalog: TourSummary[],
    hooks: GenerationHooks
  ): Promise<DraftTour>;
  /** One repair round: same topic, prior draft, and the anchor errors to fix. */
  repair(
    workspaceRoot: string,
    topic: string,
    model: string | undefined,
    catalog: TourSummary[],
    draft: DraftTour,
    anchorErrors: string[],
    hooks: GenerationHooks
  ): Promise<DraftTour>;
}

export class AuthRequiredError extends Error {}

export class GenerationFailedError extends Error {}

export class BudgetExceededError extends Error {
  constructor(
    message: string,
    public readonly spentUsd: number
  ) {
    super(message);
  }
}

export class GenerationCancelledError extends Error {}
