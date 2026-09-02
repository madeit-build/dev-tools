import type { Decision, HangOptions, RejectReason } from "@made-i-t/hang-core";
import { options as pluginOptions } from "@made-i-t/hang-prettier";

/** The subset of prettier.Options that HangOptions is derived from. Scoped down
 * rather than importing prettier's own type, since resolveHangOptions only ever
 * reads these two fields. */
interface FormatWidths {
  printWidth?: number;
  tabWidth?: number;
}

/**
 * Derives the HangOptions --explain must use to reproduce the plugin's own
 * decisions. prettier.resolveConfig (which produces `options` here) never
 * applies a plugin's declared option defaults - only prettier.format's own
 * normalization does - so an unconfigured hangWidth must come from the
 * plugin's own default rather than a value computed independently. Otherwise
 * --write and --explain silently disagree on the budget a hang is measured
 * against.
 */
export function resolveHangOptions(options: FormatWidths): HangOptions {
  return {
    printWidth: options.printWidth ?? 80,
    hangWidth: pluginOptions.hangWidth.default,
    tabWidth: options.tabWidth ?? 2,
  };
}

const REASONS: Record<RejectReason, string> = {
  "over-budget": "would exceed hangWidth",
  "verify-rejected": "guard refused: the edit would change meaning",
  "bad-indent": "continuation is not indented past its head",
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
