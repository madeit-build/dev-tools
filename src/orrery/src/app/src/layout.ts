import ELK from "elkjs/lib/elk.bundled.js";
import type { OrreryEdge, OrreryNode } from "@made-i-t/orrery-model";

export interface Positioned {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const elk = new ELK();

const NODE_WIDTH = 220;
const NODE_HEIGHT = 56;

// Layered, not force-directed. Force layout is non-deterministic, so two runs
// of the same graph produce two pictures, and it degenerates into a hairball
// well below the node counts this fleet produces. Deterministic layout is
// also what would make a future generation diff readable.
const OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.layered.spacing.nodeNodeBetweenLayers": "80",
  "elk.spacing.nodeNode": "24",
  // Deterministic tie-breaking. Without this, ELK may order equal-rank nodes
  // by input order, which would reshuffle the canvas when a rule changes.
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
};

export async function layoutGraph(
  nodes: OrreryNode[],
  edges: OrreryEdge[],
): Promise<Positioned[]> {
  if (nodes.length === 0) return [];

  // Sorted before handing to ELK, so the caller's ordering cannot change the
  // picture. The test asserts exactly this.
  const sorted = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const present = new Set(sorted.map((n) => n.id));
  const sortedEdges = [...edges].filter((e) => present.has(e.from) && present.has(e.to))
                                .sort((a, b) => a.id.localeCompare(b.id));

  const result = await elk.layout({
    id: "root",
    layoutOptions: OPTIONS,
    children: sorted.map((n) => ({
      id: n.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: sortedEdges.map((e) => ({
      id: e.id,
      sources: [e.from],
      targets: [e.to],
    })),
  });

  return (result.children ?? []).map((c) => ({
    id: c.id,
    x: c.x ?? 0,
    y: c.y ?? 0,
    width: c.width ?? NODE_WIDTH,
    height: c.height ?? NODE_HEIGHT,
  }));
}
