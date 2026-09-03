import type { Decision, HangOptions, RejectReason } from "@made-i-t/hang-core";
import { options as pluginOptions } from "@made-i-t/hang-prettier";

/** The subset of prettier.Options that HangOptions is derived from. Scoped down
 * rather than importing prettier's own type, since resolveHangOptions only ever
 * reads these three fields. */
interface FormatWidths {
  printWidth?: number;
  hangWidth?: number;
  tabWidth?: number;
  useTabs?: boolean;
}

/**
 * Derives the HangOptions --explain must use to reproduce the plugin's own
 * decisions. prettier.resolveConfig (which produces `options` here) never
 * applies a plugin's declared option defaults - only prettier.format's own
 * normalization does. It does, however, pass an explicitly configured
 * hangWidth straight through untouched, and --write's prettier.format call
 * (with the plugin loaded) merges that configured value over the plugin's
 * declared default, so a .prettierrc hangWidth wins there too. An
 * unconfigured hangWidth must therefore fall back to the plugin's own
 * default rather than a value computed independently, but a configured one
 * must win over that default - otherwise --write and --explain silently
 * disagree on the budget a hang is measured against, either because neither
 * path can see the real default or because --explain ignores an override
 * --write honors.
 */
export function resolveHangOptions(options: FormatWidths): HangOptions {
  return {
    printWidth: options.printWidth ?? 80,
    hangWidth: options.hangWidth ?? pluginOptions.hangWidth.default,
    tabWidth: options.tabWidth ?? 2,
    useTabs: options.useTabs ?? false,
  };
}

const REASONS: Record<RejectReason, string> = {
  "over-budget": "would exceed hangWidth",
  "verify-rejected": "guard refused: the edit would change meaning",
  "bad-indent": "continuation is not indented past its head",
  "nested-content": "a link in this chain has its own multi-line content",
  "opens-delimiter":
    "head ends with its own opening delimiter, which the run does not close",
  "single-link": "only one link: nothing to align by joining it up",
  "use-tabs":
    "useTabs is set: hang can't compute columns across tab indentation yet",
};

const describe = (decision: Decision): string =>
  decision.applied
    ? `hung      ${decision.links} links at column ${decision.anchor}`
    : `skipped   ${REASONS[decision.reason]}`;

export function formatDecisions(filepath: string, decisions: readonly Decision[]): string {
  if (decisions.length === 0) return `${filepath}\n  no candidates`;
  const width = Math.max(...decisions.map((d) => String(d.line).length));
  const rows = decisions.map((d) => `  line ${String(d.line).padEnd(width)}  ${describe(d)}`);
  return [filepath, ...rows].join("\n");
}
