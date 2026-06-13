import { describe, expect, test } from "vitest";
import { computeSnippetHash, checkAnchorFreshness, findReanchor } from "./anchors.js";

const file = "alpha\nbeta\ngamma\ndelta\nepsilon";
// "beta\ngamma" is lines 2-3
const hash23 = computeSnippetHash("beta\ngamma");

function anchor(startLine: number, endLine: number, snippetHash: string) {
  return { file: "f.ts", startLine, endLine, snippetHash };
}

describe("checkAnchorFreshness", () => {
  test("fresh when the recomputed hash matches", () => {
    expect(checkAnchorFreshness(anchor(2, 3, hash23), file)).toBe("fresh");
  });

  test("drifted when the hash no longer matches the range", () => {
    expect(checkAnchorFreshness(anchor(1, 2, hash23), file)).toBe("drifted");
  });

  test("out-of-range when endLine exceeds the file", () => {
    expect(checkAnchorFreshness(anchor(4, 99, hash23), file)).toBe("out-of-range");
  });
});

describe("findReanchor", () => {
  test("relocates verbatim-moved code to its new range", () => {
    const moved = "pad\npad\nbeta\ngamma\ntail";
    const result = findReanchor(anchor(2, 3, hash23), moved);
    expect(result).toEqual({ outcome: "reanchored", startLine: 3, endLine: 4, snippetHash: hash23 });
  });

  test("not-found when the code changed", () => {
    const changed = "alpha\nBETA\nGAMMA\ndelta";
    expect(findReanchor(anchor(2, 3, hash23), changed)).toEqual({ outcome: "not-found" });
  });

  test("not-found when the file is shorter than the window", () => {
    expect(findReanchor(anchor(2, 3, hash23), "only-one-line")).toEqual({ outcome: "not-found" });
  });

  test("ambiguous when more than one window matches", () => {
    const dup = "beta\ngamma\nx\nbeta\ngamma";
    expect(findReanchor(anchor(2, 3, hash23), dup)).toEqual({ outcome: "ambiguous" });
  });

  test("reanchors unchanged code to the same range", () => {
    const result = findReanchor(anchor(2, 3, hash23), file);
    expect(result).toEqual({ outcome: "reanchored", startLine: 2, endLine: 3, snippetHash: hash23 });
  });
});
