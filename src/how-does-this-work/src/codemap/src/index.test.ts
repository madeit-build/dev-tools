import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { fileOutline, findSymbol } from "./index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "codemap-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(name: string, content: string): Promise<string> {
  const p = path.join(dir, name);
  await writeFile(p, content);
  return p;
}

test("fileOutline lists symbols; unsupported extension yields []", async () => {
  const p = await write("a.ts", "export function alpha() { return 1; }\n");
  const outline = await fileOutline(p);
  expect(outline.map((s) => s.name)).toContain("alpha");
  const md = await write("readme.md", "# hi\n");
  expect(await fileOutline(md)).toEqual([]);
});

test("findSymbol resolves a unique name, flags ambiguity, and reports not-found", async () => {
  const p = await write(
    "b.ts",
    [
      "export function only() {}",
      "class A { dup() {} }",
      "class B { dup() {} }",
    ].join("\n"),
  );
  expect(await findSymbol(p, "only")).toMatchObject({
    ok: true,
    symbol: { name: "only" },
  });
  expect(await findSymbol(p, "dup")).toMatchObject({ ok: "ambiguous" });
  expect(await findSymbol(p, "A.dup")).toMatchObject({
    ok: true,
    symbol: { qualifiedName: "A.dup" },
  });
  expect(await findSymbol(p, "missing")).toEqual({ ok: false });
});
