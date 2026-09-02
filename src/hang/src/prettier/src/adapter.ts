import type { Adapter } from "@made-i-t/hang-core";
import { sameTokens, type ScanVariant } from "./tokens.js";

export const CONTINUATION_TOKENS = [".", "&&", "||", "??"] as const;

// A .js file with JSX in it, or no filepath at all, falls through to
// "standard". That's a deliberate conservative default, not an oversight.
const variantFor = (filepath: string | undefined): ScanVariant =>
  filepath !== undefined && /\.[jt]sx$/.test(filepath) ? "jsx" : "standard";

export function createAdapter(filepath: string | undefined): Adapter {
  const variant = variantFor(filepath);
  return {
    continuationTokens: CONTINUATION_TOKENS,
    verify: (before, after) => sameTokens(before, after, variant),
  };
}
