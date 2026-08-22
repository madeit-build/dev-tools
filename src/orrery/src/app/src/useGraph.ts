import { useEffect, useState } from "react";
import { validateGraph, type Graph } from "@made-i-t/orrery-model";

export interface GraphState {
  graph: Graph | null;
  error: string | null;
}

export function useGraph(url: string): GraphState {
  const [state, setState] = useState<GraphState>({ graph: null, error: null });

  useEffect(() => {
    let live = true;
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
        return r.json();
      })
      // Validated on the way in, not trusted. A malformed artifact should say
      // so plainly rather than render as a mysteriously empty canvas.
      .then((raw) => validateGraph(raw))
      .then((graph) => { if (live) setState({ graph, error: null }); })
      .catch((err: unknown) => {
        if (live) setState({ graph: null, error: err instanceof Error ? err.message : String(err) });
      });
    return () => { live = false; };
  }, [url]);

  return state;
}
