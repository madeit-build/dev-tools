import type { HunkProbe } from "./types.js";

export const indentOf = (line: string): number => line.length - line.trimStart().length;

const startsWithToken = (line: string, tokens: readonly string[]): boolean => {
  const trimmed = line.trimStart();
  return tokens.some((token) => trimmed.startsWith(token));
};

/**
 * A run ends at the first blank line or the first line that dedents past the
 * continuation. Lines indented deeper stay in the run, which is what carries
 * ternary branches along with the operands they belong to. The token check
 * scans every line at the continuation's own indent level, not just the
 * first: `typeof p === 'number' && p >= 0` puts the operand before the
 * operator, so the token can show up on the second line of the run.
 */
export function probeHunk(
  lines: readonly string[],
  headIndex: number,
  tokens: readonly string[],
): HunkProbe {
  const head = lines[headIndex];
  const first = lines[headIndex + 1];
  if (head === undefined || first === undefined) return { kind: "skip" };

  const contIndent = indentOf(first);
  let hasToken = startsWithToken(first, tokens);

  let endIndex = headIndex + 1;
  while (endIndex + 1 < lines.length) {
    const next = lines[endIndex + 1];
    if (next.trim() === "" || indentOf(next) < contIndent) break;
    endIndex++;
    if (indentOf(next) === contIndent && startsWithToken(next, tokens)) hasToken = true;
  }

  if (!hasToken) return { kind: "skip" };
  if (contIndent <= indentOf(head)) return { kind: "reject", reason: "bad-indent" };

  return { kind: "hunk", hunk: { headIndex, endIndex, contIndent } };
}
