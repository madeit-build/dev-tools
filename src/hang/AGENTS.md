# AGENTS.md

Bootstrapping guide for AI agents and new contributors working in this
directory.

## Product

**hang** (packages: `@made-i-t/hang-*`) — hanging (visual) alignment for
TypeScript/JavaScript that Prettier has already formatted: continuation lines
in a member chain or a boolean/nullish-coalescing run line up under their
anchor instead of sitting at a flat block indent. It ships as an ordinary
Prettier plugin plus a CLI (`--write`, `--explain`, `doctor`).

## Architecture (the one thing to internalize)

`hang` never reprints a node. Prettier already decided every line break; the
tool's whole job is text arithmetic performed _after_ Prettier renders its
document to a string, and the result replaces Prettier's output wholesale for
the `Program` node only.

```
core     join-and-shift, hunk finding, budget, decision log   (imports nothing)
prettier the adapter (TypeScript parser-based guard) and the plugin
cli      hang --write, --explain, doctor
```

Dependency rule: `@made-i-t/hang-core` imports nothing — not `prettier`, not
`typescript`, not `node:*`. It takes text and an injected `Adapter` and
returns text plus a `Decision[]`. `@made-i-t/hang-prettier` supplies that
adapter (a synchronous token-stream comparison over TypeScript's parser) and
the Prettier plugin. `@made-i-t/hang-cli` is the only package that touches the
filesystem.

An earlier spike tried two other approaches and both failed for reasons worth
remembering before "just reprint the chain" looks tempting again:

- Prettier's Doc IR `align(n, doc)` is relative to enclosing indentation, not
  to the cursor column, so a member-chain printer can't know where its own
  chain started on the line.
- Reprinting chain links directly means reimplementing Prettier's
  call-argument logic, and the spike's version silently dropped TypeScript
  type arguments and comments. Operating on the already-rendered text instead
  reduces the job to column arithmetic with nothing left to reimplement.

### Join and shift

For each candidate run, the first continuation line is pulled up onto its
head, then every remaining line in the run is shifted by that same delta.
Shifting the whole run together — not line by line — is what makes ternary
branches follow their operands with no special-case code: they're just
deeper-indented members of the same run.

### The synchronous guard

Prettier's printers are synchronous, so verification has to be too. The
guard compares token streams of the text before and after an edit, walked out
of `ts.createSourceFile`'s parse tree (not `ts.createScanner`, which nothing
has used since the parser rewrite in 395a9bc): identical streams mean only
whitespace changed. It's optimistic —
apply every hunk, verify once, and only on failure fall back to verifying one
hunk at a time to isolate and reject the bad one, naming it in `decisions`
with a line number.

The guard scans trivia rather than skipping it, so a deleted comment is
caught, and a multi-line block comment inside a run is refused because
reindenting one changes the comment's own text.

A second, independent mechanism — the differential oracle in
`src/prettier/src/oracle.test.ts` — reformats before/after at
`printWidth: 9999` and asserts the collapsed results match. It runs in tests
only, not in production, and deliberately shares no code with the guard: two
different mechanisms fail independently instead of sharing one blind spot.

### The plugin fails closed

The plugin intercepts only the `Program` node in the `estree` printer;
every other node delegates untouched. Any throw inside the hang step returns
Prettier's original document unchanged and writes one line to stderr — a bug
in `hang` degrades to stock Prettier, never to damaged source.

## Two constraints that fail silently

These don't error. They produce output that looks unchanged, which is worse
than an error, so anyone touching this tool needs to know them going in:

- **`experimentalOperatorPosition` must be `"start"`.** Without it, `&&`,
  `||`, and `??` continuations have nothing to anchor on and are never hung,
  even though `.` chains still work and the config otherwise looks correct.
  `doctor` probes for the option through `getSupportInfo` rather than
  comparing Prettier version strings, because that's what tells you whether
  the _installed_ Prettier can do it.
- **TypeScript must stay `^5.8`.** TypeScript 7 removed the compiler API from
  its main entry — `require("typescript").createSourceFile` is `undefined`,
  `Object.keys()` on the namespace yields only `["version",
"versionMajorMinor"]`. Without it the safety guard has nothing to compare,
  so `doctor`'s "typescript compiler api available" check probes the exact
  symbols the guard actually calls (`createSourceFile`, `ScriptKind`,
  `ScriptTarget`, `getLeadingCommentRanges`, `getTrailingCommentRanges`)
  rather than the `createScanner` entry point nothing has used since the
  parser rewrite, and rather than trusting the version string.
- **`useTabs: true` silently refuses every candidate.** `indentOf` (hunks.ts)
  counts characters, not visual columns, so a tab-indented head plus a
  space-indented continuation (or the reverse) would misalign by
  `tabWidth - 1` per tab. Rather than emit that, the engine refuses every
  candidate outright (`RejectReason "use-tabs"`) when `HangOptions.useTabs`
  is true. Expanding tabs to visual columns would be the real fix; it isn't
  implemented. `doctor`'s "useTabs not set" check reports this.

Also worth knowing, since they're real and easy to mistake for bugs:

- `hang` only rearranges breaks Prettier already made. A chain that fits on
  one line under `printWidth` stays on one line; there is nothing to hang.
- `hangWidth` (default `100`, declared as a literal in `plugin.ts` — Prettier
  option defaults can't be computed from another option's resolved value) is a
  budget separate from `printWidth`. A hunk whose hung form would exceed it is
  left in Prettier's block form and recorded as `over-budget` — not an error,
  just a decision. `doctor` and `--explain` both read the same declared
  default rather than each computing their own guess at it.
- `hang --explain` is not a printer over data the plugin's own run produced —
  there is no channel back out of a Prettier plugin for that, and the plugin
  discards `decisions` once it hands text back to Prettier. `--explain`
  instead reruns the pipeline itself: it formats the file with `plugins: []`
  to get the exact text the plugin would have handed to `hangAlign`, then
  calls `hangAlign` directly to recompute `decisions`. `plugin.test.ts`'s
  "feeds hangAlign exactly what Prettier alone produces" tests are what prove
  this reproduces the plugin's real decisions rather than approximating them.
  `decisions` is populated on every run unconditionally either way, so "why
  didn't this hang" never requires adding instrumentation.

## Repository layout

This tool lives inside the **`dev-tools` root monorepo**. The repo root owns
the shared Turborepo/pnpm machinery; this tool keeps its own packages under
its own `src/`.

```
dev-tools/                       # REPO ROOT = Turborepo monorepo
├── package.json                 # turbo orchestrates every tool
├── pnpm-workspace.yaml          # tool-agnostic globs: src/*/src/*
├── .prettierrc.json             # plugins the hang-prettier plugin, repo-wide
└── src/
    └── hang/                    # ← THIS tool
        ├── AGENTS.md · README.md
        └── src/
            ├── core/            # @made-i-t/hang-core — pure algorithm, no imports
            ├── prettier/        # @made-i-t/hang-prettier — guard, adapter, plugin
            └── cli/             # @made-i-t/hang-cli — --write, --explain, doctor
```

## Platform & tooling

- TypeScript/Node throughout, all three packages `"type": "module"`.
- pnpm workspaces + Turborepo, matching the rest of the monorepo.
- Vitest for unit tests. Tests are colocated as `*.test.ts` beside the source
  file they cover and excluded from the `tsc` build.
- Every relative import carries an explicit `.js` extension (Node16
  resolution) — without it, `vitest`/`tsc` both pass and only
  `node dist/main.js` fails at runtime.
- TypeScript is loaded via `createRequire` in `tokens.ts`, not a plain ESM
  `import`, because TypeScript ships CJS and a namespace import yields a
  namespace with no enums on it.

### Commands

Run from the repo root (`pnpm --filter` targets a single package):

```bash
pnpm --filter @made-i-t/hang-core test
pnpm --filter @made-i-t/hang-prettier test
pnpm --filter @made-i-t/hang-cli test
pnpm build && pnpm test && pnpm lint     # whole monorepo, from the root
node src/hang/src/cli/dist/main.js doctor
```

`dist/` is gitignored in every package here, but the root `.prettierrc.json`
loads the plugin as `"@made-i-t/hang-prettier"`, which resolves through that
package's `main` field to `dist/index.js`. A fresh clone has no `dist/` yet,
so formatting anything with the root config fails to find the plugin until
`pnpm build` runs at least once. The same applies within a single package
during development: `pnpm --filter <pkg> test` does not rebuild that
package's own dependencies first, so a source change in `hang-core` is
invisible to `hang-prettier`'s or `hang-cli`'s tests until `hang-core` is
rebuilt (`turbo`'s `test` task depends on `build` and handles this
automatically when run from the root; a single `pnpm --filter` invocation
does not).

## Current state

- **Design spec:** `docs/specs/2026-09-02-hang-design.md`.
- **Plan:** `docs/plans/2026-09-02-hang.md`.
- **Phase 1 shipped:** core (candidate detection, join-and-shift geometry,
  engine with optimistic verification), the Prettier adapter and plugin, the
  differential oracle, and the CLI (`--write`, `--explain`, `doctor`).
  Continuation tokens are `.`, `&&`, `||`, `??`.
- **Turned on repo-wide:** the root `.prettierrc.json` loads the plugin and
  sets both config keys above; the root `package.json` depends on
  `@made-i-t/hang-prettier` as a `workspace:*` devDependency so pnpm links it
  into the root `node_modules` (without that dependency, Prettier cannot
  resolve the plugin name even though the config lists it).
- **Not in phase 1:** arithmetic/comparison operators as continuation tokens
  (a leading `-` is ambiguous in a way a leading `.` never is), adapters for
  formatters other than Prettier, and aligning anything Prettier chose to
  keep on one line.

## Working conventions

- `@made-i-t/hang-core` must never import `prettier`, `typescript`, or
  `node:*`. If a change tempts that, the design has been misread — the core
  is pure string arithmetic over text and an injected adapter.
- Don't relax a fixture in `src/prettier/fixtures/refusals.ts` to make a test
  pass. Those fixtures are shapes the guard must leave alone; if one starts
  getting modified, the guard has a hole and the fixture is doing its job by
  catching it.
- Don't build a logger. Structured observability already exists as three
  things working together: `decisions` names every candidate and why it was
  kept or skipped, `doctor` names every check and what to try next, and the
  plugin writes one stderr line when it falls back. A formatter that logs on
  every successful file is noise in an editor.
- `Decision` records carry line numbers and reasons only, never source text —
  this applies to `doctor`'s error paths too, which redact filesystem paths
  out of Prettier/Node error messages before printing them.
- The token guard (production) and the differential oracle (tests) are
  deliberately separate mechanisms. Don't refactor one to call the other —
  that would make them fail together instead of independently.
