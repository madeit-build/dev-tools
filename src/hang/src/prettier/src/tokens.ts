import { createRequire } from "node:module";
import type * as TS from "typescript";

// TypeScript ships CJS. Imported as ESM its namespace has no enums on it,
// so every member access silently yields undefined.
const ts: typeof TS = createRequire(import.meta.url)("typescript");

export type ScanVariant = "standard" | "jsx";

const IGNORED = new Set<number>([
  ts.SyntaxKind.WhitespaceTrivia,
  ts.SyntaxKind.NewLineTrivia,
]);

function streamOf(text: string, variant: ScanVariant): string[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    variant === "jsx" ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    text,
  );
  const tokens: string[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (IGNORED.has(kind)) continue;
    tokens.push(`${kind}:${scanner.getTokenText()}`);
  }
  return tokens;
}

/**
 * Trivia is scanned rather than skipped so a deleted comment is caught. A
 * block comment spanning lines carries its own indentation in its text, so
 * reindenting one fails this check, which is the intended refusal.
 */
export function sameTokens(before: string, after: string, variant: ScanVariant): boolean {
  const a = streamOf(before, variant);
  const b = streamOf(after, variant);
  return a.length === b.length && a.every((token, index) => token === b[index]);
}

export function hasScanner(): boolean {
  return typeof (ts as Partial<typeof TS>).createScanner === "function";
}
