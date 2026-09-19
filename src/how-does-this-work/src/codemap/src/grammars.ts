import path from "node:path";
import { Parser, Language } from "web-tree-sitter";

export type CodemapLanguage = "ts" | "tsx";

const WASM_FILE: Record<CodemapLanguage, string> = {
  ts: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
};

const cache = new Map<CodemapLanguage, Promise<Language>>();
let initialized: Promise<void> | undefined;

/** Resolve the tree-sitter-wasms package root from this module's require context. */
function wasmDir(): string {
  // In CJS output, require.resolve is available as a global.
  const wasmsPkg = require.resolve("tree-sitter-wasms/package.json");
  return path.join(path.dirname(wasmsPkg), "out");
}

/** Map a file path to a grammar, or undefined when unsupported. */
export function languageForPath(filePath: string): CodemapLanguage | undefined {
  if (filePath.endsWith(".tsx") || filePath.endsWith(".jsx")) return "tsx";
  if (
    filePath.endsWith(".ts")
    || filePath.endsWith(".mts")
    || filePath.endsWith(".cts")
  )
    return "ts";
  if (
    filePath.endsWith(".js")
    || filePath.endsWith(".mjs")
    || filePath.endsWith(".cjs")
  )
    return "ts";
  return undefined;
}

/** Load and cache a grammar Language; idempotent. */
export async function loadLanguage(
  language: CodemapLanguage,
): Promise<Language> {
  initialized ??= Parser.init();
  await initialized;
  let pending = cache.get(language);
  if (!pending) {
    const wasmPath = path.join(wasmDir(), WASM_FILE[language]);
    pending = Language.load(wasmPath);
    cache.set(language, pending);
  }
  return pending;
}

export async function newParser(language: CodemapLanguage): Promise<Parser> {
  const lang = await loadLanguage(language);
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}
