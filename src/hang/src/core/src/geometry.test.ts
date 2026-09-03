import { describe, it, expect } from "vitest";
import { buildReplacement, renderApplied } from "./geometry.js";
import type { Hunk } from "./types.js";

describe("buildReplacement", () => {
  it("pulls the first link up and hangs the rest under the receiver", () => {
    const lines = [
      "const taken = regions",
      "    .filter(f)",
      "    .reduce(g, 0);",
    ];
    const hunk: Hunk = { headIndex: 0, endIndex: 2, contIndent: 4 };
    expect(buildReplacement(lines, hunk)).toEqual({
      lines: [
        "const taken = regions.filter(f)",
        "                     .reduce(g, 0);",
      ],
      anchor: 21,
      links: 2,
    });
  });

  it("inserts a space before a non-dot continuation", () => {
    const lines = ["total +=", "    a === 1", "    && b >= 0;"];
    const hunk: Hunk = { headIndex: 0, endIndex: 2, contIndent: 4 };
    const result = buildReplacement(lines, hunk);
    expect(result.lines[0]).toBe("total += a === 1");
    expect(result.lines[1]).toBe("         && b >= 0;");
    expect(result.anchor).toBe(9);
  });

  it("preserves relative offsets so ternary branches follow their operands", () => {
    const lines = [
      "total +=",
      "    typeof p === 'number'",
      "    && p >= 0",
      "        ? trunc(p)",
      "        : FALLBACK;",
    ];
    const hunk: Hunk = { headIndex: 0, endIndex: 4, contIndent: 4 };
    expect(buildReplacement(lines, hunk).lines).toEqual([
      "total += typeof p === 'number'",
      "         && p >= 0",
      "             ? trunc(p)",
      "             : FALLBACK;",
    ]);
  });

  it("keeps a nested run aligned relative to its own block indent", () => {
    const lines = [
      "    const t = regions",
      "        .filter(f)",
      "        .reduce(g, 0);",
    ];
    const hunk: Hunk = { headIndex: 0, endIndex: 2, contIndent: 8 };
    expect(buildReplacement(lines, hunk).lines).toEqual([
      "    const t = regions.filter(f)",
      "                     .reduce(g, 0);",
    ]);
  });

  it("lands the run's own indent on the anchor and nothing left of it", () => {
    const lines = [
      "total +=",
      "    a === 1",
      "    && b >= 0",
      "        ? x",
      "        : y;",
    ];
    const hunk: Hunk = { headIndex: 0, endIndex: 4, contIndent: 4 };
    const { lines: out, anchor } = buildReplacement(lines, hunk);
    const indents = out.slice(1)
                       .map((line) => line.length - line.trimStart().length);
    expect(indents[0]).toBe(anchor);
    expect(Math.min(...indents)).toBe(anchor);
  });

  it("glues an optional-chaining continuation with no space, not a dot check", () => {
    const lines = ["const a = maybe", "    ?.map(g)"];
    const hunk: Hunk = { headIndex: 0, endIndex: 1, contIndent: 4 };
    const result = buildReplacement(lines, hunk);
    expect(result.lines[0]).toBe("const a = maybe?.map(g)");
  });

  it("inserts a space before a spread continuation, not member access", () => {
    const lines = ["const a = fn(x,", "    ...rest);"];
    const hunk: Hunk = { headIndex: 0, endIndex: 1, contIndent: 4 };
    const result = buildReplacement(lines, hunk);
    expect(result.lines[0]).toBe("const a = fn(x, ...rest);");
  });

  // The three cases that used to live here -- a head ending in "(", "[", or
  // "{" -- are no longer reachable input for buildReplacement: hunks.ts now
  // refuses that whole shape (RejectReason "opens-delimiter") before
  // probeHunk ever returns a hunk for it. See hunks.test.ts.

  it("still inserts a space before an operator continuation, unaffected by the delimiter rule", () => {
    const lines = ["total +=", "    a === 1", "    && b >= 0;"];
    const hunk: Hunk = { headIndex: 0, endIndex: 2, contIndent: 4 };
    const result = buildReplacement(lines, hunk);
    expect(result.lines[0]).toBe("total += a === 1");
  });
});

describe("renderApplied", () => {
  it("splices replacements and keeps untouched lines verbatim", () => {
    const original = ["const t = xs", "    .map(f);", "", "const other = 1;"];
    const hunk: Hunk = { headIndex: 0, endIndex: 1, contIndent: 4 };
    const replacement = buildReplacement(original, hunk);
    expect(renderApplied(original, [{ hunk, replacement }])).toBe(
      ["const t = xs.map(f);", "", "const other = 1;"].join("\n"),
    );
  });

  it("returns the original when nothing was applied", () => {
    const original = ["const a = 1;", "const b = 2;"];
    expect(renderApplied(original, [])).toBe("const a = 1;\nconst b = 2;");
  });
});
