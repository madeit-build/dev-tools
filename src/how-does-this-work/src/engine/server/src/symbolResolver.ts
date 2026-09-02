import path from "node:path";
import { fileOutline, type CodeSymbol } from "@made-i-t/hdtw-codemap";

export type ResolveSymbolResult =
  | { kind: "resolved"; startLine: number; endLine: number; symbol: CodeSymbol }
  | { kind: "missing" }
  | { kind: "ambiguous"; candidates: CodeSymbol[] }
  | { kind: "file-missing" };

/**
 * Resolve a symbol to a current line range. Reuses Chunk 2's path-traversal
 * guard (never reads outside the workspace). On ambiguity, if a cached range is
 * provided, pick the candidate whose start line is nearest the cache; otherwise
 * report ambiguous.
 */
export async function resolveSymbol(
  workspaceRoot: string,
  file: string,
  symbol: string,
  cached: { startLine: number; endLine: number } | undefined,
): Promise<ResolveSymbolResult> {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolved = path.resolve(resolvedRoot, ...file.split("/"));
  if ( resolved !== resolvedRoot
       && !resolved.startsWith(resolvedRoot + path.sep)
  ) {
    return { kind: "file-missing" };
  }

  let symbols: CodeSymbol[];
  try {
    symbols = await fileOutline(resolved);
  } catch {
    return { kind: "file-missing" };
  }

  const matches = symbols.filter(
    (s) => s.name === symbol || s.qualifiedName === symbol,
  );
  const exact = matches.filter((s) => s.qualifiedName === symbol);
  const pool = exact.length > 0 ? exact : matches;

  if (pool.length === 0) return { kind: "missing" };

  let chosen: CodeSymbol;
  if (pool.length === 1) {
    chosen = pool[0];
  } else if (cached) {
    chosen = pool.reduce((best, s) =>
      Math.abs(s.startLine - cached.startLine)
      < Math.abs(best.startLine - cached.startLine)
        ? s
        : best,
    );
  } else {
    return { kind: "ambiguous", candidates: pool };
  }

  return {
    kind: "resolved",
    startLine: chosen.startLine,
    endLine: chosen.endLine,
    symbol: chosen,
  };
}
