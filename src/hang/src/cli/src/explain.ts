import type { Decision, RejectReason } from "@made-i-t/hang-core";

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
