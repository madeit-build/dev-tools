import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runReadFileTool, runGrepTool, runGlobTool, EXPLORE_TOOL_DEFS, dispatchExploreTool } from "./exploreTools.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "explore-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test("read_file returns numbered lines and guards traversal", async () => {
  await writeFile(path.join(root, "a.ts"), "alpha\nbeta\n");
  const out = await runReadFileTool(root, "a.ts");
  expect(out).toContain("alpha");
  expect((await runReadFileTool(root, "../escape.ts")).toLowerCase()).toContain("outside the workspace");
  expect((await runReadFileTool(root, "/etc/passwd")).toLowerCase()).toContain("outside the workspace");
});

test("grep finds matching lines with file:line prefixes", async () => {
  await writeFile(path.join(root, "a.ts"), "needle here\nother\n");
  await writeFile(path.join(root, "b.ts"), "nothing\n");
  const out = await runGrepTool(root, "needle");
  expect(out).toContain("a.ts");
  expect(out).toContain("needle here");
  expect(out).not.toContain("b.ts:");
});

test("glob lists matching files relative to root", async () => {
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "x.ts"), "");
  await writeFile(path.join(root, "y.md"), "");
  const out = await runGlobTool(root, "**/*.ts");
  expect(out).toContain("src/x.ts");
  expect(out).not.toContain("y.md");
});

test("EXPLORE_TOOL_DEFS lists the five tools and dispatch routes by name", async () => {
  expect(EXPLORE_TOOL_DEFS.map((t) => t.function.name).sort()).toEqual(
    ["findSymbol", "fileOutline", "glob", "grep", "read_file"].sort()
  );
  await writeFile(path.join(root, "a.ts"), "export function foo() {}\n");
  const text = await dispatchExploreTool(root, "findSymbol", { file: "a.ts", name: "foo" });
  expect(text).toContain("foo");
});
