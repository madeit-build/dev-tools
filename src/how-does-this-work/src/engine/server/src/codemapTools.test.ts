import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createCodemapMcpServer, runFileOutlineTool, runFindSymbolTool } from "./codemapTools.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "tools-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("fileOutline tool lists symbols; findSymbol returns a range; path traversal refused; absolute path refused; missing file returns friendly error", async () => {
  await writeFile(path.join(root, "a.ts"), "export function alpha() { return 1; }\n");
  expect(await runFileOutlineTool(root, "a.ts")).toContain("alpha");
  expect(await runFindSymbolTool(root, "a.ts", "alpha")).toMatch(/alpha/);
  expect((await runFindSymbolTool(root, "../x.ts", "alpha")).toLowerCase()).toContain(
    "outside the workspace"
  );
  expect((await runFindSymbolTool(root, "/etc/passwd", "x")).toLowerCase()).toContain(
    "outside the workspace"
  );
  expect((await runFileOutlineTool(root, "ghost.ts")).toLowerCase()).toContain("could not read");
});

test("createCodemapMcpServer constructs without throwing (zod/SDK wiring)", () => {
  expect(() => createCodemapMcpServer("/tmp")).not.toThrow();
});
