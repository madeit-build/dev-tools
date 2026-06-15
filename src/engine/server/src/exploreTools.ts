import { readFile } from "node:fs/promises";
import path from "node:path";
import { glob } from "tinyglobby";
import { runFileOutlineTool, runFindSymbolTool } from "./codemapTools.js";

function safeResolve(workspaceRoot: string, file: string): string | undefined {
  if (path.isAbsolute(file)) return undefined;
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, ...file.split("/"));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return undefined;
  return resolved;
}

const MAX_READ_BYTES = 64_000;
const MAX_GREP_MATCHES = 100;
const MAX_GLOB_RESULTS = 200;

export async function runReadFileTool(workspaceRoot: string, file: string): Promise<string> {
  const resolved = safeResolve(workspaceRoot, file);
  if (!resolved) return `Error: ${file} is outside the workspace.`;
  try {
    const content = (await readFile(resolved, "utf8")).slice(0, MAX_READ_BYTES);
    return content.split(/\r?\n/).map((line, i) => `${i + 1}\t${line}`).join("\n");
  } catch {
    return `Error: could not read ${file} (not found or unreadable).`;
  }
}

export async function runGrepTool(workspaceRoot: string, pattern: string, file?: string): Promise<string> {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return `Error: invalid regex "${pattern}".`;
  }
  const files = file
    ? [file]
    : (await glob(["**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,json,md}"], {
        cwd: path.resolve(workspaceRoot),
        ignore: ["**/node_modules/**", "**/dist/**"],
      })).slice(0, 2000);
  const hits: string[] = [];
  for (const rel of files) {
    const resolved = safeResolve(workspaceRoot, rel);
    if (!resolved) continue;
    let content: string;
    try {
      content = await readFile(resolved, "utf8");
    } catch {
      continue;
    }
    content.split(/\r?\n/).forEach((line, i) => {
      if (hits.length < MAX_GREP_MATCHES && regex.test(line)) {
        hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
    if (hits.length >= MAX_GREP_MATCHES) break;
  }
  return hits.length ? hits.join("\n") : `No matches for "${pattern}".`;
}

export async function runGlobTool(workspaceRoot: string, pattern: string): Promise<string> {
  const matches = (await glob([pattern], {
    cwd: path.resolve(workspaceRoot),
    ignore: ["**/node_modules/**", "**/dist/**"],
  })).slice(0, MAX_GLOB_RESULTS);
  return matches.length ? matches.join("\n") : `No files match "${pattern}".`;
}

export const EXPLORE_TOOL_DEFS = [
  { type: "function" as const, function: { name: "read_file", description: "Read a UTF-8 text file in the workspace. Returns tab-separated `lineNumber\\tcontent`.", parameters: { type: "object", properties: { file: { type: "string", description: "Workspace-relative path, POSIX separators." } }, required: ["file"] } } },
  { type: "function" as const, function: { name: "grep", description: "Search workspace files for a JS regex. Returns up to 100 `file:line: text` matches.", parameters: { type: "object", properties: { pattern: { type: "string", description: "JavaScript regular expression." }, file: { type: "string", description: "Optional: limit to one workspace-relative file." } }, required: ["pattern"] } } },
  { type: "function" as const, function: { name: "glob", description: "List workspace files matching a glob (e.g. src/**/*.ts).", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } } },
  { type: "function" as const, function: { name: "fileOutline", description: "List the named symbols (functions, classes, methods, consts) in a TS/JS file with line ranges.", parameters: { type: "object", properties: { file: { type: "string" } }, required: ["file"] } } },
  { type: "function" as const, function: { name: "findSymbol", description: "Find a symbol by name (or Class.method) in a TS/JS file and get its current line range to anchor to.", parameters: { type: "object", properties: { file: { type: "string" }, name: { type: "string" } }, required: ["file", "name"] } } },
];

export async function dispatchExploreTool(workspaceRoot: string, name: string, args: Record<string, unknown>): Promise<string> {
  const file = typeof args.file === "string" ? args.file : "";
  switch (name) {
    case "read_file": return runReadFileTool(workspaceRoot, file);
    case "grep": return runGrepTool(workspaceRoot, String(args.pattern ?? ""), typeof args.file === "string" ? args.file : undefined);
    case "glob": return runGlobTool(workspaceRoot, String(args.pattern ?? ""));
    case "fileOutline": return runFileOutlineTool(workspaceRoot, file);
    case "findSymbol": return runFindSymbolTool(workspaceRoot, file, String(args.name ?? ""));
    default: return `Error: unknown tool "${name}".`;
  }
}
