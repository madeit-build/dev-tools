export interface HangOptions {
  printWidth: number;
  hangWidth: number;
  tabWidth: number;
  /** True when the source is tab-indented. indentOf (hunks.ts) counts
   * characters, not visual columns, so a tab-indented head plus a
   * space-indented continuation (or the reverse) would misalign by
   * tabWidth - 1 per tab. Expanding tabs to visual columns is the real fix
   * and is not implemented; every candidate is refused instead. Defaults to
   * false so every existing caller that never set it keeps behaving exactly
   * as before. */
  useTabs?: boolean;
}

export type RejectReason =
  | "bad-indent"
  | "nested-content"
  | "opens-delimiter"
  | "over-budget"
  | "single-link"
  | "use-tabs"
  | "verify-rejected";

// The "never logs source text" guarantee lives here, structurally: every
// field is a number or one of a closed set of reason strings, so no value
// ever assigned to a Decision can carry a fragment of the file being
// formatted. --explain and doctor build their output only from this shape.
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
  | {
      kind: "reject";
      reason: "bad-indent" | "nested-content" | "opens-delimiter";
      endIndex: number;
    }
  | { kind: "skip" };
