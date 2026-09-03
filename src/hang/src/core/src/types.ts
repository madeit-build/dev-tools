export interface HangOptions {
  printWidth: number;
  hangWidth: number;
  tabWidth: number;
}

export type RejectReason = "bad-indent" | "nested-content" | "over-budget" | "verify-rejected";

export type Decision =
  | { line: number; applied: true; anchor: number; links: number }
  | { line: number; applied: false; reason: RejectReason };

export interface Adapter {
  readonly continuationTokens: readonly string[];
  /** Tokens that mark a deeper-indented line as still part of the expression
   * (e.g. a ternary's branches) rather than as a chain link's own nested
   * content (a call's wrapped arguments, a callback's multi-line body). A
   * deeper line that starts with none of these gets the whole run refused. */
  readonly branchTokens: readonly string[];
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
  | { kind: "reject"; reason: "bad-indent" | "nested-content"; endIndex: number }
  | { kind: "skip" };
