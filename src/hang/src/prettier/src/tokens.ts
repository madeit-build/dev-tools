import { createRequire } from "node:module";
import type * as TS from "typescript";

// TypeScript ships CJS. Imported as ESM its namespace has no enums on it,
// so every member access silently yields undefined.
const ts: typeof TS = createRequire(import.meta.url)("typescript");

export type ScanVariant = "standard" | "jsx";

/**
 * Whether "/" starts a regex or divides, whether a "}" resumes a template or
 * closes an ordinary brace, and how JSX text and expressions interleave are
 * all questions of parser context, not something a token-at-a-time scanner
 * can reliably reconstruct after the fact. Three attempts at approximating
 * that context by hand each closed one shape and missed the next: a member-
 * access template poisoning a later hunk, an object literal's own brace
 * inside a substitution, and finally a regex literal's brace desyncing the
 * guard's own bookkeeping regardless of any template even being present.
 * `ts.createSourceFile` resolves all of this correctly because disambiguating
 * it is the parser's actual job, not an incidental side effect of scanning.
 *
 * Comments are the one thing missing from the resulting tree: they are
 * trivia, not nodes. They are read out of the gap between the end of one
 * emitted token and the start of the next, which is safe precisely because a
 * gap between two real tokens can only ever contain whitespace and comments
 * -- nothing else is lexically possible there. Reading the gap takes both of
 * TypeScript's own comment-range functions, not just one: a same-line
 * comment right after the previous token (`1; // keep`, nothing else on the
 * line) is "trailing" and invisible to `getLeadingCommentRanges` called at
 * that same position -- confirmed directly, it returns undefined there even
 * though the comment is sitting right in the gap. `getTrailingCommentRanges`
 * is checked first and consumed past, then `getLeadingCommentRanges` picks up
 * anything further on its own line before the next real token.
 */
function streamOf(text: string, variant: ScanVariant): string[] {
  const scriptKind = variant === "jsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const fileName = variant === "jsx" ? "input.tsx" : "input.ts";
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKind,
  );

  const tokens: string[] = [];
  let cursor = 0;

  function emitCommentRanges(ranges: readonly TS.CommentRange[] | undefined): void {
    if (ranges === undefined) return;
    for (const range of ranges) {
      tokens.push(`${range.kind}:${text.slice(range.pos, range.end)}`);
    }
    cursor = ranges[ranges.length - 1].end;
  }

  function emitCommentsBefore(pos: number): void {
    emitCommentRanges(ts.getTrailingCommentRanges(text, cursor));
    emitCommentRanges(ts.getLeadingCommentRanges(text, cursor));
    cursor = pos;
  }

  function visit(node: TS.Node): void {
    if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      emitCommentsBefore(node.getStart(sourceFile));
      tokens.push(`${node.kind}:${node.getText(sourceFile)}`);
      cursor = node.getEnd();
      return;
    }
    for (const child of children) visit(child);
  }

  visit(sourceFile);
  emitCommentsBefore(text.length);
  return tokens;
}

/**
 * Comments are read as trivia (see streamOf) rather than skipped, so a
 * deleted comment is caught. A block comment spanning lines carries its own
 * indentation in its text, so reindenting one fails this check, which is the
 * intended refusal.
 *
 * Sound only for whitespace edits that do not move a line terminator across
 * a restricted production (return, throw, break, continue, yield, postfix
 * ++/--): automatic semicolon insertion depends on that terminator's
 * position, and this comparison discards all whitespace, that one included.
 * It is safe today only because the transform's continuation tokens (".",
 * "&&", "||", "??") can never legally follow a restricted-production
 * keyword. Adding an arithmetic or comparison operator to
 * CONTINUATION_TOKENS must not happen without re-checking this boundary.
 */
export function sameTokens(before: string, after: string, variant: ScanVariant): boolean {
  const a = streamOf(before, variant);
  const b = streamOf(after, variant);
  return a.length === b.length && a.every((token, index) => token === b[index]);
}

export function hasScanner(): boolean {
  return typeof (ts as Partial<typeof TS>).createScanner === "function";
}
