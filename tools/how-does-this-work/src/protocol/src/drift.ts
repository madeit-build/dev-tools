import type { TourAnchor } from "./tours.js";

/** JSON-RPC method: client→engine, recompute per-step anchor freshness for a tour. */
export const CHECK_TOUR_DRIFT_METHOD = "hdtw/checkTourDrift";

/** JSON-RPC method: client→engine, re-anchor one drifted step (atomic rewrite of the tour file). */
export const REANCHOR_STEP_METHOD = "hdtw/reanchorStep";

export type StepDriftState =
  | "fresh"
  | "drifted"
  | "out-of-range"
  | "file-missing"
  // Symbol-anchor states (Chunk 4b): the symbol resolved to a new range and the
  // cache was refreshed ("relocated", self-healed), or the symbol no longer
  // exists in the file ("symbol-missing").
  | "relocated"
  | "symbol-missing";

export interface StepDriftStatus {
  index: number;
  status: StepDriftState;
}

export interface CheckTourDriftParams {
  workspaceRoot: string;
  tourId: string;
}

export interface CheckTourDriftResult {
  statuses: StepDriftStatus[];
}

export type ReanchorOutcome = "reanchored" | "not-found" | "ambiguous" | "file-missing";

export interface ReanchorStepParams {
  workspaceRoot: string;
  tourId: string;
  stepIndex: number;
}

export interface ReanchorStepResult {
  outcome: ReanchorOutcome;
  /** Present only when outcome is "reanchored". */
  anchor?: TourAnchor;
}
