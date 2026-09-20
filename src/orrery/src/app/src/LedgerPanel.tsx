import { useState, type JSX } from "react";
import type { DropRecord } from "@made-i-t/orrery-model";
import { groupLedger, searchLedger } from "./ledger";

export interface LedgerPanelProps {
  rows: DropRecord[];
  onClose: () => void;
}

export function LedgerPanel({ rows, onClose }: LedgerPanelProps): JSX.Element {
  const [query, setQuery] = useState("");
  const groups = groupLedger(searchLedger(rows, query));

  return (
    <aside className="orrery-panel">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: "var(--space-1)",
        }}
      >
        <strong>{rows.length} not drawn</strong>
        <button onClick={onClose}>close</button>
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="search by name, rule, or detail"
        style={{
          width: "100%",
          padding: 6,
          marginBottom: "var(--space-2)",
          boxSizing: "border-box",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
        }}
      />

      {groups.length === 0 && (
        <div className="orrery-panel__type">nothing matches</div>
      )}

      {groups.map((g) => (
        <section key={g.reason} style={{ marginBottom: "var(--space-2)" }}>
          <div className="orrery-panel__section" style={{ marginTop: 0 }}>
            {g.label} ({g.rows.length})
          </div>
          {g.rows.map((r, i) => (
            <div key={`${r.candidate}-${i}`} className="orrery-panel__row">
              <div>{r.candidate}</div>
              <div className="orrery-panel__evidence" style={{ marginTop: 0 }}>
                {r.host} · {r.rule} · {r.detail}
              </div>
            </div>
          ))}
        </section>
      ))}
    </aside>
  );
}
