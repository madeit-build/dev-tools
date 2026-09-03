import type { DropRecord, DropReason } from "@made-i-t/orrery-model";

export interface LedgerGroup {
  reason: DropReason;
  label: string;
  rows: DropRecord[];
}

// Failures first. A rule that errored is something to fix; a unit with no
// ExecStart is the tool working correctly, and burying the former under 57 of
// the latter is how a real problem goes unnoticed.
const ORDER: ReadonlyArray<[DropReason, string]> = [
  ["eval-failed", "Evaluation failed"],
  ["rule-error", "Rule errored"],
  ["filtered-by-rule", "Filtered by a rule"],
  ["no-exec", "No ExecStart, so nothing runs"],
];

export function groupLedger(rows: DropRecord[]): LedgerGroup[] {
  return ORDER
    .map(([reason, label]) => ({ reason, label, rows: rows.filter((r) => r.reason === reason) }))
    .filter((g) => g.rows.length > 0);
}

export function searchLedger(rows: DropRecord[], query: string): DropRecord[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (r) =>
      r.candidate.toLowerCase().includes(q) ||
      r.detail.toLowerCase().includes(q) ||
      r.rule.toLowerCase().includes(q),
  );
}
