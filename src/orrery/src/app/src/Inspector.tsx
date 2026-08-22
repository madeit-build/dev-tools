import type { JSX } from "react";
import type { Graph, OrreryNode } from "@made-i-t/orrery-model";
import type { View } from "./route";

export interface InspectorProps {
  node: OrreryNode;
  graph: Graph;
  view: View;
  onNavigate: (next: View) => void;
}

export function Inspector({ node, graph, view, onNavigate }: InspectorProps): JSX.Element {
  const declaredBy = graph.edges.filter((e) => e.type === "declared-by" && e.from === node.id);
  const modules = declaredBy
    .map((e) => graph.nodes.find((n) => n.id === e.to))
    .filter((n): n is OrreryNode => Boolean(n));

  const inferred = graph.edges.filter(
    (e) => e.source === "inferred" && (e.from === node.id || e.to === node.id),
  );

  return (
    <aside className="orrery-panel">
      <div className="orrery-panel__title">{node.label}</div>
      <div className="orrery-panel__type">{node.type}</div>

      {Object.entries(node.attrs)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => (
          <div key={k} className="orrery-panel__row">
            <span className="orrery-panel__key">{k}: </span>
            <span>{String(v)}</span>
          </div>
        ))}

      {modules.length > 0 && (
        <>
          <div className="orrery-panel__section">
            declared by {modules.length === 1 ? "1 module" : `${modules.length} modules`}
          </div>
          {modules.map((m) => (
            <div key={m.id}>
              <button
                className="orrery-panel__link"
                onClick={() => onNavigate({ ...view, lens: "declaration", selected: m.id })}
              >
                {m.label}
              </button>
            </div>
          ))}
        </>
      )}

      {inferred.length > 0 && (
        <>
          <div className="orrery-panel__section">inferred, not declared</div>
          {inferred.map((e) => (
            // The evidence is shown, not hidden. A guess the reader can check
            // is a different thing from a guess presented as a fact.
            <div key={e.id} className="orrery-panel__evidence">{e.evidence}</div>
          ))}
        </>
      )}
    </aside>
  );
}
