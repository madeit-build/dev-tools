import {
  ReactFlow,
  Background,
  Controls,
  type Edge,
  type Node,
} from "@xyflow/react";
import { useCallback, useEffect, useState, type JSX } from "react";
import "@xyflow/react/dist/style.css";
import { useGraph } from "./useGraph";
import { layoutGraph } from "./layout";
import { parseHash, toHash, type View } from "./route";
import { visibleFor } from "./lens";
import { OrreryNodeView, type OrreryNodeData } from "./nodes/OrreryNodeView";
import { Inspector } from "./Inspector";
import { LedgerPanel } from "./LedgerPanel";

// Defined once outside the component: React Flow re-registers node types when
// this object's identity changes, which would remount every node each render.
const NODE_TYPES = { orrery: OrreryNodeView };

export function App(): JSX.Element {
  const { graph, error } = useGraph("/graph.json");
  const [view, setView] = useState<View>(() => parseHash(window.location.hash));
  const [showJobs, setShowJobs] = useState(false);
  const [showLedger, setShowLedger] = useState(false);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  // The URL is the state, so back and forward work and any view is a link.
  useEffect(() => {
    const onHash = () => setView(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = useCallback((next: View) => {
    window.location.hash = toHash(next);
  }, []);

  useEffect(() => {
    if (!graph) return;
    let live = true;
    const slice = visibleFor(graph, view, { showJobs });
    layoutGraph(slice.nodes, slice.edges).then((positions) => {
      if (!live) return;
      const at = new Map(positions.map((p) => [p.id, p]));
      setNodes(
        slice.nodes.map((n) => ({
          id: n.id,
          type: "orrery",
          position: { x: at.get(n.id)?.x ?? 0, y: at.get(n.id)?.y ?? 0 },
          data: {
            node: n,
            selected: n.id === view.selected,
          } satisfies OrreryNodeData,
        })),
      );
      setEdges(
        slice.edges.map((e) => ({
          id: e.id,
          source: e.from,
          target: e.to,
          className:
            e.source === "inferred" ? "orrery-edge--inferred" : undefined,
        })),
      );
    });
    return () => {
      live = false;
    };
  }, [graph, view, showJobs]);

  const onNodeClick = useCallback(
    (_: unknown, n: Node) => {
      go({ ...view, selected: n.id });
    },
    [go, view],
  );

  const onNodeDoubleClick = useCallback(
    (_: unknown, n: Node) => {
      const { node } = n.data as OrreryNodeData;
      go({ ...view, path: [...view.path, node.label], selected: null });
    },
    [go, view],
  );

  if (error) {
    return (
      <pre style={{ padding: 24, fontFamily: "var(--font-mono)" }}>{error}</pre>
    );
  }
  if (!graph)
    return (
      <div style={{ padding: 24, fontFamily: "var(--font-mono)" }}>loading</div>
    );

  const selected = view.selected
    ? graph.nodes.find((n) => n.id === view.selected)
    : undefined;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <header className="orrery-header">
        <button
          className="orrery-crumb"
          onClick={() => go({ ...view, path: [], selected: null })}
        >
          fleet
        </button>
        {view.path.map((seg, i) => (
          <button
            key={seg}
            className="orrery-crumb"
            onClick={() =>
              go({ ...view, path: view.path.slice(0, i + 1), selected: null })
            }
          >
            / {seg}
          </button>
        ))}
        <span className="orrery-header__right">
          <label>
            <input
              type="checkbox"
              checked={showJobs}
              onChange={(e) => setShowJobs(e.target.checked)}
            />
            {" show jobs"}
          </label>
          <button onClick={() => setShowLedger((s) => !s)}>
            {graph.ledger.length} not drawn
          </button>
          <button
            onClick={() =>
              go({
                ...view,
                lens: view.lens === "runtime" ? "declaration" : "runtime",
              })
            }
          >
            lens: {view.lens}
          </button>
        </span>
      </header>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div style={{ flex: 1 }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            fitView
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} color="transparent" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        {selected && (
          <Inspector
            node={selected}
            graph={graph}
            view={view}
            onNavigate={go}
          />
        )}
        {showLedger && (
          <LedgerPanel
            rows={graph.ledger}
            onClose={() => setShowLedger(false)}
          />
        )}
      </div>
    </div>
  );
}
