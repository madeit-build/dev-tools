export interface HangOptions {
  printWidth: number;
  hangWidth: number;
  tabWidth: number;
}

export type RejectReason = "bad-indent" | "over-budget" | "verify-rejected";

export type Decision =
  | { line: number; applied: true; anchor: number; links: number }
  | { line: number; applied: false; reason: RejectReason };

export interface Adapter {
  readonly continuationTokens: readonly string[];
  verify(before: string, after: string): boolean;
}

export interface HangResult {
  text: string;
  decisions: Decision[];
}

/** A head line plus the run of continuation lines beneath it, both inclusive. */
export interface Hunk {
  headIndex: number;
  endIndex: number;
  contIndent: number;
}

export type HunkProbe =
  | { kind: "hunk"; hunk: Hunk }
  | { kind: "reject"; reason: "bad-indent" }
  | { kind: "skip" };
