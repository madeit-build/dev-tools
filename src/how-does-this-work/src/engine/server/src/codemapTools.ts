import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { fileOutline, findSymbol } from "@made-i-t/hdtw-codemap";

function guard(workspaceRoot: string, file: string): string | undefined {
  if (path.isAbsolute(file)) return undefined;
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, ...file.split("/"));
  if (resolved !== root && !resolved.startsWith(root + path.sep))
    return undefined;
  return resolved;
}

export async function runFileOutlineTool(
  workspaceRoot: string,
  file: string,
): Promise<string> {
  const resolved = guard(workspaceRoot, file);
  if (!resolved) return `Error: ${file} is outside the workspace.`;
  try {
    const symbols = await fileOutline(resolved);
    if (symbols.length === 0)
      return `No symbols found in ${file} (unsupported type or empty).`;
    return symbols
      .map(
        (s) =>
          `${s.qualifiedName} (${s.kind}) lines ${s.startLine}-${s.endLine}`,
      )
      .join("\n");
  } catch {
    return `Error: could not read ${file} (not found or unreadable).`;
  }
}

export async function runFindSymbolTool(
  workspaceRoot: string,
  file: string,
  name: string,
): Promise<string> {
  const resolved = guard(workspaceRoot, file);
  if (!resolved) return `Error: ${file} is outside the workspace.`;
  try {
    const result = await findSymbol(resolved, name);
    if (result.ok === false) return `Symbol "${name}" not found in ${file}.`;
    if (result.ok === "ambiguous") {
      return `Symbol "${name}" is ambiguous in ${file}. Qualify with one of: ${result.candidates.map((c) => c.qualifiedName).join(", ")}.`;
    }
    const s = result.symbol;
    return `${s.qualifiedName} (${s.kind}) lines ${s.startLine}-${s.endLine}. Anchor with symbol="${s.qualifiedName}".`;
  } catch {
    return `Error: could not read ${file} (not found or unreadable).`;
  }
}

/** In-process MCP server exposing the read-only code-map tools to the agent. */
export function createCodemapMcpServer(workspaceRoot: string) {
  return createSdkMcpServer({
    name: "codemap",
    version: "1.0.0",
    tools: [
      tool(
        "fileOutline",
        "List the named symbols (functions, classes, methods, consts) in a TS/JS file with their line ranges.",
        {
          file: z
            .string()
            .describe("Workspace-relative path, POSIX separators."),
        },
        async (args) => ({
          content: [
            {
              type: "text",
              text: await runFileOutlineTool(workspaceRoot, args.file),
            },
          ],
        }),
      ),
      tool(
        "findSymbol",
        "Find a symbol by name (or Class.method) in a TS/JS file and get its current line range to anchor to.",
        { file: z.string(), name: z.string() },
        async (args) => ({
          content: [
            {
              type: "text",
              text: await runFindSymbolTool(
                workspaceRoot,
                args.file,
                args.name,
              ),
            },
          ],
        }),
      ),
    ],
  });
}
