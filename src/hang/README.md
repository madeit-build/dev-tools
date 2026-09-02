# hang

Hanging (visual) alignment for code Prettier has already formatted.

```js
// Prettier alone
const taken = regions
    .filter((region) => !region.growing)
    .reduce((sum, region) => sum + regionRows(region, rowsOf), 0);

// hang
const taken = regions.filter((region) => !region.growing)
                     .reduce((sum, region) => sum + regionRows(region, rowsOf), 0);
```

Prettier chooses where to break a line. `hang` only rearranges breaks Prettier
already made: it pulls the first continuation line up onto its head, then
shifts every remaining line of that run by the same amount, so the run reads
as a column under its anchor instead of a flat block indent. Continuation
tokens are `.`, `&&`, `||`, and `??`. A chain that already fits on one line is
never touched.

## Install

`hang` ships as a Prettier plugin plus a CLI, both workspace packages:

- `@made-i-t/hang-prettier` — the plugin.
- `@made-i-t/hang-cli` — `hang --write`, `hang --explain`, `hang doctor`.

Add the plugin to `.prettierrc.json`:

```json
{
  "plugins": ["@made-i-t/hang-prettier"],
  "printWidth": 80,
  "hangWidth": 100,
  "experimentalOperatorPosition": "start"
}
```

Run `hang doctor` after any config change. It checks the environment in the
order things are most likely to be wrong and names what to try next for every
failing check.

## Two constraints that fail silently

**Operator lines never hang without `experimentalOperatorPosition: "start"`.**
Without it, `&&`, `||`, and `??` sit at the end of the line above instead of
the start of the continuation, so there is nothing for hang to anchor a run
on. The tool looks fully configured and simply does nothing to those lines.
`.` chains are unaffected either way.

**The guard needs `typescript@^5.8`.** TypeScript 7 removed the compiler API
from its main entry, exposing only `version`. Without `createScanner`, the
synchronous safety guard has nothing to verify against, so pin the range and
don't widen it.

## Config keys

Both live in `.prettierrc.json`, read by Prettier itself — no separate config
file.

| Key | Default | Effect |
| --- | --- | --- |
| `experimentalOperatorPosition` | `"end"` (Prettier's default) | Must be `"start"` for `&&`, `||`, `??` continuations to hang. |
| `hangWidth` | `printWidth + 20` | A separate budget from `printWidth`. A hunk whose hung form would exceed it keeps Prettier's original block shape instead, recorded as `over-budget`. |

## Commands

```
hang --write <paths...>    format in place, hanging what fits
hang --explain <paths...>  report every candidate and why it was kept or skipped
hang doctor                check the environment in likely-failure order
```

`--write` runs Prettier with the plugin loaded, so its output is identical to
what an editor running Prettier produces.

`--explain` reports every candidate line that began a continuation run, plus
the reason it was kept or skipped: `hung`, or skipped for `over-budget`,
`verify-rejected` (the safety guard rejected the edit because it would change
meaning), or `bad-indent` (the continuation isn't indented past its head).
This is not a debug flag — the underlying decision log is recorded on every
run, so `--explain` never requires re-running anything to answer "why didn't
this hang."

`doctor` exits 0 only when every check passes: Prettier resolves, the
installed Prettier supports `experimentalOperatorPosition`, the plugin is
actually loaded (not just listed), the TypeScript scanner is available, and
both config keys above are set to values that will actually produce a hang.

## Safety

Every write is verified by comparing TypeScript token streams before and
after: if the edit changed anything but whitespace, it's rejected and the
original text is kept, one hunk at a time if needed to isolate the bad one.
The plugin also fails closed — any internal error returns Prettier's normal
output unchanged rather than partially-edited source. See
[`AGENTS.md`](./AGENTS.md) for the mechanism.
