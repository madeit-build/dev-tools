import type { Adapter } from "@made-i-t/hang-core";
import { sameTokens, type ScanVariant } from "./tokens.js";

export const CONTINUATION_TOKENS = [".", "&&", "||", "??"] as const;

// A ternary's "?" and ":" branches are still part of the expression, not a
// chain link's own nested content, so a deeper-indented line starting with
// one of these does not trip the nested-content refusal.
//
// Known overlap: optional chaining's "?." also starts with "?", so a deeper
// line beginning "?." reads as a branch token too. Benign in practice --
// Prettier always places a non-branch-token line at the shallowest deeper
// position when a chain link's own content wraps, so a "?."-led line never
// stands in for the real nested content (wrapped arguments, a callback's
// multi-line body) that the check exists to catch.
export const BRANCH_TOKENS = ["?", ":"] as const;

// A .js file with JSX in it, or no filepath at all, falls through to
// "standard". That's a deliberate conservative default, not an oversight.
const variantFor = (filepath: string | undefined): ScanVariant =>
  filepath !== undefined && /\.[jt]sx$/.test(filepath) ? "jsx" : "standard";

export function createAdapter(filepath: string | undefined): Adapter {
  const variant = variantFor(filepath);
  return {
    continuationTokens: CONTINUATION_TOKENS,
    branchTokens: BRANCH_TOKENS,
    verify: (before, after) => sameTokens(before, after, variant),
  };
}
