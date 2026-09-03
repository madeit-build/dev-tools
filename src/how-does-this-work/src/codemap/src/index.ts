import { readFile } from "node:fs/promises";
import { parseSymbols, type CodeSymbol } from "./symbols.js";
import { languageForPath } from "./grammars.js";

export type { CodeSymbol, SymbolKind } from "./symbols.js";
export { languageForPath } from "./grammars.js";

export type FindSymbolResult =
  | { ok: true; symbol: CodeSymbol }
  | { ok: "ambiguous"; candidates: CodeSymbol[] }
  | { ok: false };

/** Parse a file into its symbols. Returns [] for unsupported file types. */
export async function fileOutline(absolutePath: string): Promise<CodeSymbol[]> {
  const language = languageForPath(absolutePath);
  if (!language) return [];
  const content = await readFile(absolutePath, "utf8");
  return parseSymbols(content, language);
}

/** Resolve a symbol by name or qualifiedName. */
export async function findSymbol(absolutePath: string, name: string): Promise<FindSymbolResult> {
  const symbols = await fileOutline(absolutePath);
  const matches = symbols.filter((s) => s.name === name || s.qualifiedName === name);
  if (matches.length === 0) return { ok: false };
  if (matches.length === 1) return { ok: true, symbol: matches[0] };
  const exact = matches.filter((s) => s.qualifiedName === name);
  if (exact.length === 1) return { ok: true, symbol: exact[0] };
  return { ok: "ambiguous", candidates: matches };
}
