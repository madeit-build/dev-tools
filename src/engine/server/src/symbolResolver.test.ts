import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { resolveSymbol } from "./symbolResolver.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "resolver-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("resolveSymbol returns a range, picks nearest-to-cache on ambiguity, and guards path traversal", async () => {
  await writeFile(
    path.join(root, "a.ts"),
    ["class A { dup() { return 1; } }", "class B { dup() { return 2; } }"].join("\n")
  );
  // unique by qualifiedName
  expect(await resolveSymbol(root, "a.ts", "A.dup", undefined)).toMatchObject({
    kind: "resolved", startLine: 1, endLine: 1,
  });
  // ambiguous bare name, cached near line 2 -> picks the line-2 candidate
  expect(await resolveSymbol(root, "a.ts", "dup", { startLine: 2, endLine: 2 })).toMatchObject({
    kind: "resolved", startLine: 2,
  });
  // ambiguous bare name, NO cache -> ambiguous
  expect((await resolveSymbol(root, "a.ts", "dup", undefined)).kind).toBe("ambiguous");
  // missing symbol
  expect(await resolveSymbol(root, "a.ts", "nope", undefined)).toEqual({ kind: "missing" });
  // missing file
  expect(await resolveSymbol(root, "ghost.ts", "x", undefined)).toEqual({ kind: "file-missing" });
  // path traversal refused (treated as file-missing — never reads outside root)
  expect(await resolveSymbol(root, "../escape.ts", "x", undefined)).toEqual({ kind: "file-missing" });
});
