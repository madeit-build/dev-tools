import { indentOf } from "./hunks.js";
import type { Hunk } from "./types.js";

export interface Replacement {
  lines: string[];
  anchor: number;
  links: number;
}

export interface Applied {
  hunk: Hunk;
  replacement: Replacement;
}

// A continuation only glues flush when it's member access: "?." or a single
// "." not followed by another ".". A leading "..." is a spread, not member
// access, so it still gets a space like any other operator continuation.
const MEMBER_ACCESS = /^(\?\.|\.(?!\.))/;

/**
 * Shifting the whole run by one delta is what preserves relative offsets
 * inside it, so a ternary's branches keep their distance from the operands
 * above them without any special handling.
 */
export function buildReplacement(
  lines: readonly string[],
  hunk: Hunk,
): Replacement {
  const head = lines[hunk.headIndex].trimEnd();
  const first = lines[hunk.headIndex + 1].trim();
  const glue = MEMBER_ACCESS.test(first) ? "" : " ";
  const anchor = head.length + glue.length;
  const shift = anchor - hunk.contIndent;

  const rest = lines
    .slice(hunk.headIndex + 2, hunk.endIndex + 1)
    .map(
      (line) => " ".repeat(Math.max(0, indentOf(line) + shift)) + line.trim(),
    );

  return {
    lines: [head + glue + first, ...rest],
    anchor,
    links: rest.length + 1,
  };
}

export function renderApplied(
  original: readonly string[],
  applied: readonly Applied[],
): string {
  const out: string[] = [];
  let cursor = 0;
  for (const { hunk, replacement } of applied) {
    out.push(...original.slice(cursor, hunk.headIndex), ...replacement.lines);
    cursor = hunk.endIndex + 1;
  }
  out.push(...original.slice(cursor));
  return out.join("\n");
}
