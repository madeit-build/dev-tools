import type { Adapter } from "@made-i-t/hang-core";
import { sameTokens, type ScanVariant } from "./tokens.js";

export const CONTINUATION_TOKENS = [".", "&&", "||", "??"] as const;

// A ternary's "?" and ":" branches are still part of the expression, not a
// chain link's own nested content, so a deeper-indented line starting with
// one of these does not trip the nested-content refusal.
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
