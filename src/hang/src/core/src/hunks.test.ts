import { describe, it, expect } from "vitest";
import { indentOf, probeHunk } from "./hunks.js";

const TOKENS = [".", "&&", "||", "??"] as const;
const probe = (lines: string[], at = 0) => probeHunk(lines, at, TOKENS);

describe("indentOf", () => {
  it("counts leading spaces", () => {
    expect(indentOf("    .filter(f)")).toBe(4);
  });

  it("is zero for an unindented line", () => {
    expect(indentOf("const a = 1;")).toBe(0);
  });
});

describe("probeHunk", () => {
  it("finds a two-link chain", () => {
    const result = probe(["const t = regions", "    .filter(f)", "    .reduce(g, 0);"]);
    expect(result).toEqual({ kind: "hunk", hunk: { headIndex: 0, endIndex: 2, contIndent: 4 } });
  });

  it("includes deeper lines in the run so ternary branches travel with it", () => {
    const result = probe([
      "total +=",
      "    typeof p === 'number'",
      "    && p >= 0",
      "        ? trunc(p)",
      "        : FALLBACK;",
    ]);
    expect(result).toEqual({ kind: "hunk", hunk: { headIndex: 0, endIndex: 4, contIndent: 4 } });
  });

  it("stops the run at a blank line", () => {
    const result = probe(["const t = xs", "    .map(f)", "", "    .other()"]);
    expect(result).toEqual({ kind: "hunk", hunk: { headIndex: 0, endIndex: 1, contIndent: 4 } });
  });

  it("stops the run when indentation falls back", () => {
    const result = probe(["const t = xs", "    .map(f);", "const u = 2;"]);
    expect(result).toEqual({ kind: "hunk", hunk: { headIndex: 0, endIndex: 1, contIndent: 4 } });
  });

  it("skips a line whose successor starts no continuation token", () => {
    expect(probe(["const a = 1;", "const b = 2;"])).toEqual({ kind: "skip" });
  });

  it("skips the final line", () => {
    expect(probe(["const a = 1;"])).toEqual({ kind: "skip" });
  });

  it("rejects a continuation that is not indented past its head", () => {
    expect(probe(["const t = xs", ".map(f)"])).toEqual({ kind: "reject", reason: "bad-indent" });
  });

  it("recognises every configured token", () => {
    for (const token of TOKENS) {
      const result = probe(["head = a", `    ${token} b`]);
      expect(result.kind, token).toBe("hunk");
    }
  });
});
