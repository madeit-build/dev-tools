import type { EdgeType, Graph, NodeType, OrreryEdge, OrreryNode } from "@made-i-t/orrery-model";
import type { View } from "./route";

const RUNTIME_EDGES = new Set<EdgeType>(["proxies-to", "listens-on", "reads", "writes", "depends-on"]);
const DECLARATION_EDGES = new Set<EdgeType>(["declared-by", "defines", "imports", "provides"]);

// Source-side node types. They exist in both lenses' data but only belong on
// screen in Declaration, where the question is "what code put this here".
const SOURCE_TYPES = new Set<NodeType>(["module", "option", "input"]);

export interface LensOptions {
  showJobs?: boolean;
}

// The nodes one level below the current drill path. Containment is the zoom
// axis, so "what is visible" is exactly "the children of where I am".
function childrenOf(graph: Graph, parentId: string): OrreryNode[] {
  const childIds = new Set(
    graph.edges.filter((e) => e.type === "contains" && e.from === parentId).map((e) => e.to),
  );
  return graph.nodes.filter((n) => childIds.has(n.id));
}

// Below a host, a path segment could name a service or a vhost: both share the
// host/name id tail. Rather than guess, try each id shape and take whichever
// actually has children.
function candidateParents(path: string[]): string[] {
  if (path.length === 0) return ["fleet:fleet"];
  if (path.length === 1) return [`host:${path[0]}`];
  const tail = path.slice(1).join("/");
  return [`service:${path[0]}/${tail}`, `vhost:${path[0]}/${tail}`];
}

export function visibleFor(
  graph: Graph,
  view: View,
  options: LensOptions = {},
): { nodes: OrreryNode[]; edges: OrreryEdge[] } {
  let nodes: OrreryNode[] = [];
  for (const parent of candidateParents(view.path)) {
    nodes = childrenOf(graph, parent);
    if (nodes.length > 0) break;
  }

  // The jobs toggle governs both lenses. Applying it only to Runtime meant
  // flipping the lens silently added 45 boot-time jobs back to the canvas,
  // which reads as the flip having lost your place.
  if (!options.showJobs) nodes = nodes.filter((n) => n.attrs.lifecycle !== "oneshot");

  if (view.lens === "runtime") {
    nodes = nodes.filter((n) => !SOURCE_TYPES.has(n.type));
  } else {
    // Declaration adds the source nodes attached to whatever is in view, so
    // the flip keeps the runtime nodes on screen and answers "who declared
    // these" beside them rather than replacing them. That is what preserves
    // the selection across a flip.
    const visible = new Set(nodes.map((n) => n.id));
    const attached = new Set(
      graph.edges
        .filter((e) => DECLARATION_EDGES.has(e.type) && visible.has(e.from))
        .map((e) => e.to),
    );
    nodes = [...nodes, ...graph.nodes.filter((n) => attached.has(n.id))];
  }

  const visible = new Set(nodes.map((n) => n.id));
  const wanted = view.lens === "runtime" ? RUNTIME_EDGES : DECLARATION_EDGES;

  const edges = graph.edges.filter(
    (e) => wanted.has(e.type) && visible.has(e.from) && visible.has(e.to),
  );

  return { nodes, edges };
}
