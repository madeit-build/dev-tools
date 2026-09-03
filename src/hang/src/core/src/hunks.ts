import type { HunkProbe } from "./types.js";

export const indentOf = (line: string): number =>
  line.length - line.trimStart().length;

// A head line that ends with its own opening delimiter -- "(", "[", or "{" --
// is refused rather than hung. Prettier always prints that delimiter's
// matching close back at (or above) the head's own indent, which by
// hunk-boundary construction below can never be part of this same run, so
// join-and-shift can only ever glue the run's first line flush against the
// head and leave that close orphaned two columns left of everything it
// closes: `if (cond\n    && more\n)`. Refusing beats emitting something the
// user has to undo by hand.
const OPENS_DELIMITER = /[([{]$/;

const startsWithToken = (line: string, tokens: readonly string[]): boolean => {
  const trimmed = line.trimStart();
  // A bare "." means member access, never spread: exclude "..." so a spread
  // element in an ordinary object or array body doesn't masquerade as one.
  return tokens.some((token) => {
    if (token === "." && trimmed.startsWith("...")) return false;
    return trimmed.startsWith(token);
  });
};

/**
 * A run ends at the first blank line or the first line that dedents past the
 * continuation. Lines indented deeper stay in the run, which is what carries
 * ternary branches along with the operands they belong to. The token check
 * scans every line at the continuation's own indent level, not just the
 * first: `typeof p === 'number' && p >= 0` puts the operand before the
 * operator, so the token can show up on the second line of the run.
 *
 * A deeper-indented line is only ever legitimate when it is still part of the
 * expression, e.g. a ternary's `?`/`:` branch. Anything else deeper than the
 * continuation indent is a chain link's own nested content -- a call's
 * wrapped arguments, a callback's multi-line body -- and join-and-shift would
 * drag it out to the anchor column along with the rest of the run. That is
 * meaning-preserving but visually wrong, so the whole run is refused rather
 * than partially hung.
 */
export function probeHunk(
  lines: readonly string[],
  headIndex: number,
  tokens: readonly string[],
  branchTokens: readonly string[],
): HunkProbe {
  const head = lines[headIndex];
  const first = lines[headIndex + 1];
  if (head === undefined || first === undefined) return { kind: "skip" };

  const contIndent = indentOf(first);
  let hasToken = startsWithToken(first, tokens);
  let hasNestedContent = false;

  let endIndex = headIndex + 1;
  while (endIndex + 1 < lines.length) {
    const next = lines[endIndex + 1];
    // The second half of this condition only ever bites when contIndent <=
    // indentOf(head) -- i.e. exactly the bad-indent case below, where the
    // first half alone would never trigger and the run would otherwise keep
    // extending through sibling statements at or below the head's own
    // indent, swallowing a perfectly good chain that follows.
    if (next.trim() === ""
        || indentOf(next) < contIndent
        || indentOf(next) <= indentOf(head)
    ) {
      break;
    }
    endIndex++;
    const nextIndent = indentOf(next);
    if (nextIndent === contIndent && startsWithToken(next, tokens))
      hasToken = true;
    if (nextIndent > contIndent && !startsWithToken(next, branchTokens))
      hasNestedContent = true;
  }

  if (!hasToken) return { kind: "skip" };
  if (OPENS_DELIMITER.test(head.trimEnd()))
    return { kind: "reject", reason: "opens-delimiter", endIndex };
  if (contIndent <= indentOf(head))
    return { kind: "reject", reason: "bad-indent", endIndex };
  if (hasNestedContent)
    return { kind: "reject", reason: "nested-content", endIndex };

  return { kind: "hunk", hunk: { headIndex, endIndex, contIndent } };
}
