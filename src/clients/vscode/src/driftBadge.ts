import type { StepDriftState } from "@made-i-t/hdtw-protocol";

/** A markdown badge line for a non-fresh step, or "" when fresh. */
export function driftBadge(status: StepDriftState): string {
  switch (status) {
    case "drifted":
      return "⚠️ _This step has drifted — the anchored code has changed since the tour was authored._";
    case "out-of-range":
      return "⚠️ _This step's anchor is out of range — the file is shorter than the tour expects._";
    case "file-missing":
      return "🚫 _This step's anchored file is missing._";
    case "symbol-missing":
      return "🚫 _This step's anchored symbol no longer exists._";
    case "relocated":
      return "";
    case "fresh":
      return "";
  }
}

/** Re-anchoring searches the file by hash, so it only applies when the file exists. */
export function isReanchorable(status: StepDriftState): boolean {
  return status === "drifted" || status === "out-of-range";
}
