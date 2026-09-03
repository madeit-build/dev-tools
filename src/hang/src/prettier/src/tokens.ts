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
  ignoredTrivia ??= new Set<number>([ts.SyntaxKind.WhitespaceTrivia, ts.SyntaxKind.NewLineTrivia]);
  return ignoredTrivia;
}

/**
 * A plain scan() has no way to know that the "}" closing a "${...}"
 * substitution should resume as template text rather than ordinary code: it
 * reads the template's tail as code and then reads the closing backtick as
 * OPENING a new template literal, swallowing everything up to the next
 * backtick anywhere later in the file. TypeScript's own parser and its
 * classifier (services/classifier.ts) both track this with a brace stack
 * rather than a bare counter, because a substitution can contain an ordinary
 * block or object literal with its own braces -- `${f({ a: 1 })}` has two
 * "}" before the template resumes, and only the second is the substitution's.
 * The stack disambiguates them: an ordinary "{" is only pushed while a
 * template is already open (otherwise it needs no tracking at all), so its
 * matching "}" pops without triggering a rescan, and only a "}" whose stack
 * top is TemplateHead calls reScanTemplateToken.
 */
function streamOf(text: string, variant: ScanVariant): string[] {
  const ignored = ignoredTriviaKinds();
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    variant === "jsx" ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    text,
  );
  const tokens: string[] = [];
  const templateStack: number[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.TemplateHead) {
      templateStack.push(kind);
    } else if (kind === ts.SyntaxKind.OpenBraceToken) {
      if (templateStack.length > 0) templateStack.push(kind);
    } else if (kind === ts.SyntaxKind.CloseBraceToken && templateStack.length > 0) {
      const top = templateStack[templateStack.length - 1];
      if (top === ts.SyntaxKind.TemplateHead) {
        kind = scanner.reScanTemplateToken(false);
        // TemplateMiddle means another "${" just opened: the TemplateHead
        // entry stays on the stack for that substitution's own close. Only
        // TemplateTail actually finishes the template.
        if (kind === ts.SyntaxKind.TemplateTail) templateStack.pop();
      } else {
        templateStack.pop();
      }
    }
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
export function sameTokens(before: string, after: string, variant: ScanVariant): boolean {
  const a = streamOf(before, variant);
  const b = streamOf(after, variant);
  return a.length === b.length && a.every((token, index) => token === b[index]);
}

export function hasScanner(): boolean {
  return typeof (ts as Partial<typeof TS>).createScanner === "function";
}
