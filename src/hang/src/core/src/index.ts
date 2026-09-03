export { hangAlign } from "./engine.js";
export { indentOf, probeHunk } from "./hunks.js";
export { buildReplacement, renderApplied } from "./geometry.js";
export type { Replacement, Applied } from "./geometry.js";
export type {
  Adapter,
  Decision,
  HangOptions,
  HangResult,
  Hunk,
  HunkProbe,
  RejectReason,
} from "./types.js";
