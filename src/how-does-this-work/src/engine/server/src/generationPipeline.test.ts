import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { verifyStep } from "./generationPipeline.js";
import { computeSnippetHash } from "@made-i-t/hdtw-engine-core";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "verify-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("verifyStep resolves a symbol-anchor to a range, fills the cache, keeps the symbol", async () => {
  await writeFile(
    path.join(root, "a.ts"),
    ["export function alpha() {", "  return 1;", "}"].join("\n"),
  );
  const step = {
    title: "t",
    narration: "n",
    anchor: { file: "a.ts", symbol: "alpha" },
  };
  const verified = await verifyStep(root, step);
  expect(typeof verified).not.toBe("string");
  expect(verified).toMatchObject({
    anchor: { file: "a.ts", symbol: "alpha", startLine: 1, endLine: 3 },
  });
  expect(
    (verified as { anchor: { snippetHash: string } }).anchor.snippetHash,
  ).toBe(computeSnippetHash("export function alpha() {\n  return 1;\n}"));
});

test("verifyStep returns an error string when the symbol is missing", async () => {
  await writeFile(path.join(root, "a.ts"), "export function alpha() {}\n");
  const step = {
    title: "t",
    narration: "n",
    anchor: { file: "a.ts", symbol: "ghost" },
  };
  expect(typeof (await verifyStep(root, step))).toBe("string");
});

test("verifyStep still verifies a classic line-anchor", async () => {
  await writeFile(
    path.join(root, "a.ts"),
    ["line1", "line2", "line3"].join("\n"),
  );
  const step = {
    title: "t",
    narration: "n",
    anchor: { file: "a.ts", startLine: 1, endLine: 2 },
  };
  const verified = await verifyStep(root, step);
  expect(verified).toMatchObject({
    anchor: { file: "a.ts", startLine: 1, endLine: 2 },
  });
  expect(
    (verified as { anchor: { symbol?: string } }).anchor.symbol,
  ).toBeUndefined();
});
