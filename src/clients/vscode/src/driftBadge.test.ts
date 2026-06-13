import { describe, expect, test } from "vitest";
import { driftBadge, isReanchorable } from "./driftBadge.js";

describe("driftBadge", () => {
  test("fresh has no badge", () => {
    expect(driftBadge("fresh")).toBe("");
  });
  test("each non-fresh status has a distinct badge line", () => {
    expect(driftBadge("drifted")).toContain("drifted");
    expect(driftBadge("out-of-range")).toContain("out of range");
    expect(driftBadge("file-missing")).toContain("missing");
  });
});

describe("isReanchorable", () => {
  test("drifted and out-of-range are re-anchorable; fresh and file-missing are not", () => {
    expect(isReanchorable("drifted")).toBe(true);
    expect(isReanchorable("out-of-range")).toBe(true);
    expect(isReanchorable("fresh")).toBe(false);
    expect(isReanchorable("file-missing")).toBe(false);
  });
});
