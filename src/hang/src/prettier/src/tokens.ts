import { createRequire } from "node:module";
import type * as TS from "typescript";

// TypeScript ships CJS. Imported as ESM its namespace has no enums on it,
// so every member access silently yields undefined.
const ts: typeof TS = createRequire(import.meta.url)("typescript");

export type ScanVariant = "standard" | "jsx";

// Built lazily so hasScanner() can run under a TS7-shaped module, where
// ts.SyntaxKind is undefined: reading it at module scope would throw on
// import, before hasScanner() ever gets a chance to report the mismatch.
let ignoredTrivia: Set<number> | undefined;

function ignoredTriviaKinds(): Set<number> {
  ignoredTrivia ??= new Set<number>([
    ts.SyntaxKind.WhitespaceTrivia,
    ts.SyntaxKind.NewLineTrivia,
  ]);
  return ignoredTrivia;
}

function streamOf(text: string, variant: ScanVariant): string[] {
  const ignored = ignoredTriviaKinds();
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    variant === "jsx" ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    text,
  );
  const tokens: string[] = [];
  for (
    let kind = scanner.scan();
    kind !== ts.SyntaxKind.EndOfFileToken;
    kind = scanner.scan()
  ) {
    if (ignored.has(kind)) continue;
    tokens.push(`${kind}:${scanner.getTokenText()}`);
  }
  return tokens;
}

/**
 * Trivia is scanned rather than skipped so a deleted comment is caught. A
 * block comment spanning lines carries its own indentation in its text, so
 * reindenting one fails this check, which is the intended refusal.
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
export function sameTokens(
  before: string,
  after: string,
  variant: ScanVariant,
): boolean {
  const a = streamOf(before, variant);
  const b = streamOf(after, variant);
  return a.length === b.length && a.every((token, index) => token === b[index]);
}

export function hasScanner(): boolean {
  return typeof (ts as Partial<typeof TS>).createScanner === "function";
}
