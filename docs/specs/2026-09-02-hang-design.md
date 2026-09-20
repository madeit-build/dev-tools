# hang Design

**Status:** Approved
**Date:** 2026-09-02

## Goal

Hanging (visual) alignment for code Prettier has already formatted: continuation
lines line up under their anchor instead of sitting at a flat block indent.

```js
// Prettier today
const taken = regions.filter((region) => !region.growing)
                     .reduce((sum, region) => sum + regionRows(region, rowsOf), 0);

// hang
const taken = regions.filter((region) => !region.growing)
                     .reduce((sum, region) => sum + regionRows(region, rowsOf), 0);
```

The core is formatter-agnostic. Phase 1 ships one adapter, for Prettier over
TypeScript and JavaScript.

## Context

Prettier will not do this and the refusal is deliberate, not an oversight. The
same is true of Biome, dprint, Black, and gofmt. Column alignment ties a
continuation line's indent to the printed width of a token above it, so renaming
an identifier rewrites every line beneath it, `git blame` gets noisier, and two
people editing different lines of one aligned block now conflict. clang-format
does support it (`AlignAfterOpenBracket`, `AlignOperands`), which is why this is
a solved problem in the C family and an unsolved one everywhere else.

A spike established what is and is not reachable inside Prettier. Three findings
shape everything below.

**The Doc IR cannot express this on its own.** `align(n, doc)` is relative to the
enclosing indentation, not to the cursor column. Literal text already emitted on
the line contributes nothing. So `align(7)` after a 14-column prefix indents to
7, not 21, and a member-chain printer therefore cannot know where it starts.

**Taking over the printing corrupts source.** A plugin that reprints chain links
must reimplement Prettier's call-argument logic. The spike's version silently
deleted TypeScript type arguments, turning `client.request<Shape>(url)` into
`client.request(url)`, and dropped comments. Every gap in such a reimplementation
is silent corruption.

**Rewriting Prettier's own doc tree cannot find the chain.** Prettier does label
chains (`label={"memberChain":true}`), but inside that label the separator
between links and the separator between call arguments are both `line` docs, and
the shape varies with chain length: two links use a plain `line`, three or more
use `hardline`. There is no stable way to tell them apart without replicating
`printMemberChain`'s own knowledge.

What does work is operating on the text after Prettier has already chosen the
line breaks, where the job reduces to column arithmetic.

## Architecture

```
src/hang/src/
  core/        join-and-shift, hunk finding, budget, verify hook   (no imports)
  prettier/    the adapter and the Prettier plugin
  cli/         hang --write, --explain, doctor
```

Packages follow the existing convention: `@made-i-t/hang-core`,
`@made-i-t/hang-prettier`, `@made-i-t/hang-cli`.

### The core contract

```ts
type RejectReason =
  | "bad-indent" // continuation not indented past its head
  | "nested-content" // a link carries its own multi-line content
  | "opens-delimiter" // head ends with its own unclosed opening delimiter
  | "over-budget" // hung form would exceed hangWidth
  | "single-link" // only one link: nothing to align by joining it up
  | "use-tabs" // useTabs is set; column arithmetic can't handle it
  | "verify-rejected"; // the guard rejected the edit as meaning-changing

type Decision =
  | { line: number; applied: true; anchor: number; links: number }
  | { line: number; applied: false; reason: RejectReason };

interface Adapter {
  continuationTokens: readonly string[];
  // Tokens that mark a deeper-indented line as still part of the expression
  // (a ternary's branches) rather than a chain link's own nested content
  // (wrapped call arguments, a callback's multi-line body).
  branchTokens: readonly string[];
  verify(before: string, after: string): boolean;
}

interface HangOptions {
  printWidth: number;
  hangWidth: number;
  tabWidth: number;
  useTabs?: boolean;
}

function hangAlign(
  text: string,
  adapter: Adapter,
  opts: HangOptions,
): { text: string; decisions: Decision[] };
```

Decisions are recorded per candidate, meaning a run that began with a
continuation token. Lines that were never candidates produce no entry.

The core imports nothing and knows no formatter. An adapter supplies the tokens
that begin a continuation line, the tokens that mark a deeper line as still
part of the same expression rather than a link's own nested content, and a
synchronous semantic guard.

`nested-content` and `branchTokens` were the largest change made during
execution and are recorded here for that reason: a chain link can wrap its own
call arguments or a callback's multi-line body onto lines deeper than the
continuation indent. Join-and-shift would drag that content out to the anchor
column along with the rest of the run -- meaning-preserving, but visually
wrong -- so the whole run is refused rather than partially hung. A ternary's
`?`/`:` branches are the one shape of deeper-indented line that is legitimate,
which is what `branchTokens` exists to distinguish.

`opens-delimiter`, `single-link`, and `use-tabs` were added in a later fix
wave, once dogfooding this tool against its own monorepo surfaced them: a run
whose head ends with its own unclosed opening delimiter (the `if (cond\n  &&
more\n)` shape) is refused because Prettier always prints that delimiter's
close back at the head's own indent, which can never be part of the same run,
so join-and-shift could only ever orphan it two columns left of everything it
closes. A hunk with only one link is refused because there is nothing to align
by joining it up. `useTabs` is refused wholesale because `indentOf` counts
characters, not visual columns, and a tab-indented head plus a space-indented
continuation would misalign by `tabWidth - 1` per tab.

### Join and shift (load-bearing decision)

For each candidate the algorithm pulls the first continuation line up onto its
head, then shifts every remaining line of the run by that same delta:

```
anchor = len(rtrim(head)) + len(glue)     // glue is "" before ".", else " "
shift  = anchor - indentOf(firstContinuation)
```

Shifting a whole run by one delta preserves relative offsets inside it, so
ternary branches follow their operands with no special handling:

```js
total +=
  typeof published === "number" && Number.isFinite(published) && published >= 0
    ? Math.trunc(published)
    : ASSUMED_PANE_ROWS;
```

The `?` and `:` lines are members of the run, not hunk starters. They keep their
four-column offset from the operands above them because everything moved
together. This is why the operator and ternary cases need no separate code path.

### Verification (load-bearing decision)

Prettier's printers are synchronous, so the guard must be too. It compares
token streams walked out of `ts.createSourceFile`'s own parse tree: identical
streams mean the edit changed only whitespace that carries no meaning.

This has been parser-based since `395a9bc`, not scanner-based: an earlier
version drove `ts.createScanner` a token at a time and approximated context
(whether `/` starts a regex or divides, whether `}` resumes a template) by
hand, and each attempt at that approximation closed one shape while missing
the next. `ts.createSourceFile` resolves all of this correctly because
disambiguating it is the parser's actual job. Nothing has called
`ts.createScanner` since.

Verification is optimistic. Apply every hunk, verify the file once, and the
common case costs a single lexer pass. Only on failure does it fall back to
per-hunk verification to name the culprit, which then reaches `decisions` with a
line number.

The guard is what makes this safe rather than merely usually correct. During the
spike a naive version silently ate a newline inside a template literal, turning
a two-line string into a one-line one. The guard rejects that hunk. It also
rejects a run containing a multi-line block comment, because reindenting one
changes the comment's own text, which is the correct outcome.

### The Prettier plugin

The plugin overrides the `estree` printer and intercepts only the `Program`
node. It renders the base document, hands the text to the core, and returns the
result joined with `literalline`. Everything else delegates untouched, so no
node is ever reprinted and corruption is impossible by construction.

The plugin **fails closed**. Any throw inside it returns Prettier's original
document unchanged, so a bug in `hang` degrades to stock Prettier rather than to
damaged source.

Because Prettier re-normalizes its input before the pass runs, the plugin is
idempotent even though the text pass alone is not. Running the pass on its own
output would re-join lines it just made. This is why the pass must never be
exposed as a standalone filter over already-hung text.

### Configuration

`hangWidth` is declared as a Prettier plugin option, so it is set in
`.prettierrc.json` alongside `printWidth` and needs no separate config file:

```json
{
  "plugins": ["@made-i-t/hang-prettier"],
  "printWidth": 80,
  "hangWidth": 100,
  "experimentalOperatorPosition": "start"
}
```

Declaring it also makes it visible through `getSupportInfo`, which is how
`doctor` proves the plugin is actually loaded rather than merely configured.

### Two constraints that fail silently if undocumented

Operator hanging requires `experimentalOperatorPosition: "start"`. Without it
operators sit at line ends, there is nothing to anchor on, and the tool does
nothing while appearing correctly configured. `doctor` probes for the option
through `getSupportInfo` rather than comparing version strings, so it reports
what the installed Prettier can actually do.

TypeScript 7 removed the compiler API from its main entry, exposing only
`version`. The guard's parser would go missing without a word. The package
depends on `typescript@^5.8`, and `doctor` checks for the exact symbols the
guard actually calls (`createSourceFile`, `ScriptKind`, `ScriptTarget`,
`getLeadingCommentRanges`, `getTrailingCommentRanges`) rather than trusting
the version string or probing `createScanner`, which nothing has used since
the parser rewrite.

## Overflow policy

Alignment costs horizontal room, so `hangWidth` is a separate budget, declared
as a Prettier plugin option with a literal default of `100`. It cannot default
to `printWidth + 20` in practice: Prettier's option schema requires a static
default value, computed once when the plugin is declared, not a function of
another option's resolved value. `doctor` and `--explain` both read the same
literal (`pluginOptions.hangWidth.default`) rather than each computing their
own guess at it, which is what makes them agree. A hunk that would exceed the
budget is left in Prettier's block form and recorded as `over-budget`. This
keeps the common case visually consistent, hard-stops pathological lines, and
makes "why did this not align" answerable with one number.

## Security

The three questions, answered plainly rather than dressed up. Identity is the OS
user running the formatter. Authentication is filesystem permissions.
Authorization is the file mode. No other principal exists, there is no network
surface, and there is no telemetry.

The real threat is silent source corruption, and it has three controls: the
synchronous guard on every write, the plugin's fail-closed behavior, and
byte-identical passthrough when nothing applies. The CLI writes only to paths
given explicitly and refuses to follow a symlink out of the project root.

`Decision` records carry line numbers and reasons and never source text, so no
diagnostic path logs the code being formatted.

## Observability

`decisions` is always populated, never behind a debug flag. Answering "why did
that chain not align" must never require adding code, so `--explain` never
requires re-running anything to answer that question -- but it is not simply a
printer over data the run already produced. The plugin discards `decisions`
once it returns text to Prettier; there is no channel back out of a Prettier
plugin for it. `--explain` instead reruns the pipeline itself: it formats the
file with `plugins: []` to get the exact text the plugin would have handed to
`hangAlign`, then calls `hangAlign` directly to recompute `decisions`. This
is provably the same computation the plugin would have made (see
`plugin.test.ts`, "feeds hangAlign exactly what Prettier alone produces"), not
an approximation of it.

`hang doctor` checks in the order things are most likely to be wrong:

1. Prettier resolves and `getSupportInfo` lists `experimentalOperatorPosition`.
2. The plugin is loaded, confirmed by `hangWidth` appearing in `getSupportInfo`.
3. TypeScript resolves and exposes `createSourceFile`, `ScriptKind`,
   `ScriptTarget`, `getLeadingCommentRanges`, and `getTrailingCommentRanges`.
4. `experimentalOperatorPosition` is `start` when operator tokens are enabled.
5. `hangWidth` is at least `printWidth`.
6. `useTabs` is not set.

Structured logs record every state transition and every failure path, each
naming what failed and what to try next.

## Testing

Unit tests cover the join-and-shift arithmetic. Fixture snapshots cover the
shapes, including those that must be refused: template literals and multi-line
block comments.

A differential oracle runs in every `vitest run`, in `oracle.test.ts` --
not CI-only, and not gated behind any flag. It reformats the before and after
at `printWidth: 9999` (with `objectWrap: "collapse"`, so an already-collapsed
and an already-expanded object literal that mean the same thing don't read as
a false mismatch) and asserts the results are identical. This is deliberately
a different mechanism from the production guard, so the two fail
independently rather than sharing a blind spot. The spike's
whitespace-stripping check passed the template-literal corruption; the oracle
catches it. It covers both continuation families: `.` member chains and
`&&`/`||`/`??`/ternary runs under `experimentalOperatorPosition: "start"`.

The tool then dogfoods against this monorepo's own TypeScript.

## Phase 1 scope

Ships: the core, the Prettier and TypeScript adapter, the plugin, and the CLI
with `--write`, `--explain`, and `doctor`. Continuation tokens are `.`, `&&`,
`||`, and `??`.

Not in phase 1:

- Arithmetic and comparison operators. A continuation line starting with `-` is
  ambiguous in a way a leading `.` never is.
- Adapters for other formatters. The interface exists and is unproven until a
  second one lands, which is an accepted risk.
- Alignment of anything Prettier chose to keep on one line. The tool only
  rearranges breaks Prettier already made.
