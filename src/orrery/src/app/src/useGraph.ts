import { useEffect, useState } from "react";
import { validateGraph, type Graph } from "@made-i-t/orrery-model";
import { MissingJson, readJson } from "./readJson";

export interface GraphState {
  graph: Graph | null;
  error: string | null;
}

export function useGraph(url: string): GraphState {
  const [state, setState] = useState<GraphState>({ graph: null, error: null });

  useEffect(() => {
    let live = true;
    fetch(url)
      .then((r) => readJson(r, url))
      // Validated on the way in, not trusted. A malformed artifact should say
      // so plainly rather than render as a mysteriously empty canvas.
      .then((raw) => validateGraph(raw))
      .then((graph) => {
        if (live) setState({ graph, error: null });
      })
      .catch((err: unknown) => {
        if (live)
          setState({
            graph: null,
            error: describe(err),
          });
      });
    return () => {
      live = false;
    };
  }, [url]);

  return state;
}

// graph.json is generated and gitignored, so every fresh checkout starts
// without it; the message says how to make one rather than only that it failed.
function describe(err: unknown): string {
  if (err instanceof MissingJson) {
    return `${err.url} is missing. Generate it from src/orrery: `
      + "node src/extract/dist/cli.js <path to the flake> --out src/app/public";
  }
  return err instanceof Error ? err.message : String(err);
}
