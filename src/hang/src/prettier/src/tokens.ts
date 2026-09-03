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

interface ScanStream {
  tokens: string[];
  /**
   * True when the template brace stack was not empty at end of scan, meaning
   * some "}" was misattributed and the token stream desynced. The known
   * cause: a regex literal containing a bare, non-quantifier "{" (e.g.
   * `/x{/`) is indistinguishable from division by a plain scan() that never
   * calls reScanSlashToken, so its brace gets pushed as if it were an
   * ordinary code brace and never finds a matching close -- which leaves a
   * TemplateHead permanently stuck on the stack. Regex-versus-division
   * context tracking was deliberately not added: this is the third distinct
   * ambiguity to defeat a hand-rolled special case in this function, and the
   * next shape nobody thought of would walk straight through a fourth. An
   * empty-stack-at-EOF invariant closes the whole class instead of the one
   * case: any desync that leaves brace accounting unbalanced is caught,
   * structurally, without enumerating what caused it.
   */
  desynced: boolean;
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
function streamOf(text: string, variant: ScanVariant): ScanStream {
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
  return { tokens, desynced: templateStack.length > 0 };
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
 *
 * Either side desyncing its template brace stack (see ScanStream) is treated
 * as untrustworthy and rejected outright, independent of whether the two
 * token arrays would otherwise have compared equal. This is a structural
 * catch-all, not a proof of soundness: it catches any desync that leaves
 * brace accounting unbalanced, but it would not catch a hypothetical
 * mis-tokenization that happens to stay balanced. No such case is known; none
 * is claimed to be ruled out.
 */
export function sameTokens(before: string, after: string, variant: ScanVariant): boolean {
  const a = streamOf(before, variant);
  const b = streamOf(after, variant);
  if (a.desynced || b.desynced) return false;
  return (
    a.tokens.length === b.tokens.length && a.tokens.every((token, index) => token === b.tokens[index])
  );
}

export function hasScanner(): boolean {
  return typeof (ts as Partial<typeof TS>).createScanner === "function";
}
