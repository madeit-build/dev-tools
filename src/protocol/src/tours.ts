/** JSON-RPC method name: client→engine, stateless list of all tours in workspaceRoot. */
export const LIST_TOURS_METHOD = "hdtw/listTours";

/** JSON-RPC method name: client→engine, fetch a single validated tour by id. */
export const GET_TOUR_METHOD = "hdtw/getTour";

/** JSON-RPC error code returned by hdtw/getTour for an unknown or invalid tour id. */
export const TOUR_NOT_FOUND_ERROR_CODE = -32001;

export interface TourAnchor {
  /** Workspace-root-relative path, POSIX separators. */
  file: string;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive; >= startLine. */
  endLine: number;
  /** "sha256:<hex>" of the anchored text at authoring time (drift detection in Chunk 4). */
  snippetHash: string;
}

export interface TourStep {
  title: string;
  anchor: TourAnchor;
  /** Markdown. */
  narration: string;
}

export interface Tour {
  schemaVersion: 1;
  id: string;
  title: string;
  summary: string;
  steps: TourStep[];
}

export interface TourSummary {
  id: string;
  title: string;
  summary: string;
  stepCount: number;
  /**
   * Present when the tour file failed validation; such a tour cannot be started.
   * Human-readable, free-form — structured error codes are deferred to a later chunk.
   */
  error?: string;
}

export interface ListToursParams {
  workspaceRoot: string;
}

export interface ListToursResult {
  tours: TourSummary[];
}

export interface GetTourParams {
  workspaceRoot: string;
  tourId: string;
}

export interface GetTourResult {
  tour: Tour;
}
