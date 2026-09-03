import { describe, it, expect } from "vitest";
import { indentOf, probeHunk } from "./hunks.js";

const TOKENS = [".", "&&", "||", "??"] as const;
const BRANCH_TOKENS = ["?", ":"] as const;
const probe = (lines: string[], at = 0) =>
  probeHunk(lines, at, TOKENS, BRANCH_TOKENS);

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
    const result = probe([
      "const t = regions",
      "    .filter(f)",
      "    .reduce(g, 0);",
    ]);
    expect(result).toEqual({
      kind: "hunk",
      hunk: { headIndex: 0, endIndex: 2, contIndent: 4 },
    });
  });

  it("includes deeper lines in the run so ternary branches travel with it", () => {
    const result = probe([
      "total +=",
      "    typeof p === 'number'",
      "    && p >= 0",
      "        ? trunc(p)",
      "        : FALLBACK;",
    ]);
    expect(result).toEqual({
      kind: "hunk",
      hunk: { headIndex: 0, endIndex: 4, contIndent: 4 },
    });
  });

  it("stops the run at a blank line", () => {
    const result = probe(["const t = xs", "    .map(f)", "", "    .other()"]);
    expect(result).toEqual({
      kind: "hunk",
      hunk: { headIndex: 0, endIndex: 1, contIndent: 4 },
    });
  });

  it("stops the run when indentation falls back", () => {
    const result = probe(["const t = xs", "    .map(f);", "const u = 2;"]);
    expect(result).toEqual({
      kind: "hunk",
      hunk: { headIndex: 0, endIndex: 1, contIndent: 4 },
    });
  });

  it("skips a line whose successor starts no continuation token", () => {
    expect(probe(["const a = 1;", "const b = 2;"])).toEqual({ kind: "skip" });
  });

  it("skips the final line", () => {
    expect(probe(["const a = 1;"])).toEqual({ kind: "skip" });
  });

  it("rejects a continuation that is not indented past its head", () => {
    expect(probe(["const t = xs", ".map(f)"])).toEqual({
      kind: "reject",
      reason: "bad-indent",
      endIndex: 1,
    });
  });

  it("recognises every configured token", () => {
    for (const token of TOKENS) {
      const result = probe(["head = a", `    ${token} b`]);
      expect(result.kind, token).toBe("hunk");
    }
  });

  it("skips an object literal whose only leading-dot line is a spread", () => {
    const result = probe(["const a = {", "  x: 1,", "  ...spread,", "};"]);
    expect(result).toEqual({ kind: "skip" });
  });

  it("skips an array literal whose only leading-dot line is a spread", () => {
    const result = probe(["const a = [", "  1,", "  ...rest,", "];"]);
    expect(result).toEqual({ kind: "skip" });
  });

  it("still finds a real member-access dot later in the run past a spread-like line", () => {
    const result = probe(["const a = obj", "    ...extra", "    .filter(x);"]);
    expect(result).toEqual({
      kind: "hunk",
      hunk: { headIndex: 0, endIndex: 2, contIndent: 4 },
    });
  });

  it("finds the token when it first appears on the third line of the run", () => {
    const result = probe(["const t = xs", "    a", "    b", "    .map(f);"]);
    expect(result).toEqual({
      kind: "hunk",
      hunk: { headIndex: 0, endIndex: 3, contIndent: 4 },
    });
  });

  it("rejects a run whose deeper-indented line is a call's own wrapped argument, not a branch token", () => {
    const result = probe([
      "const dropped = observed",
      "    .filter(",
      "        (r) => r.kind === 'log',",
      "    )",
      "    .map((r) => r.fields);",
    ]);
    expect(result).toEqual({
      kind: "reject",
      reason: "nested-content",
      endIndex: 4,
    });
  });

  it("rejects a run whose deeper-indented lines are a callback's own multi-line JSX body", () => {
    const result = probe([
      "    {Object.entries(attrs)",
      "        .filter(([, v]) => v !== null)",
      "        .map(([k, v]) => (",
      "            <div key={k} className='panel__row'>",
      "                <span>{String(v)}</span>",
      "            </div>",
      "        ))}",
    ]);
    expect(result).toEqual({
      kind: "reject",
      reason: "nested-content",
      endIndex: 6,
    });
  });

  it("still hangs when every deeper-indented line begins with a branch token", () => {
    const result = probe([
      "total +=",
      "    typeof p === 'number'",
      "    && p >= 0",
      "        ? trunc(p)",
      "        : FALLBACK;",
    ]);
    expect(result).toEqual({
      kind: "hunk",
      hunk: { headIndex: 0, endIndex: 4, contIndent: 4 },
    });
  });

  it("rejects nested content even when it appears after a branch-token line", () => {
    const result = probe([
      "total +=",
      "    cond",
      "    && x >= 0",
      "        ? trunc(p)",
      "        : fallback(",
      "            deeper,",
      "        )",
    ]);
    expect(result).toEqual({
      kind: "reject",
      reason: "nested-content",
      endIndex: 6,
    });
  });

  it("rejects a run whose head ends with its own unclosed opening paren", () => {
    // The "if (" shape: Prettier prints the condition's own closing paren
    // back at the head's indent, orphaned two columns left of everything
    // it closes. 23 of 63 dogfood hangs (37%) were this shape.
    const result = probe([
      "if (",
      "    candidate.kind === 'log'",
      "    && typeof candidate.kind === 'string'",
    ]);
    expect(result).toEqual({
      kind: "reject",
      reason: "opens-delimiter",
      endIndex: 2,
    });
  });

  it("rejects the unclosed-bracket shape ahead of a bad-indent check on the same run", () => {
    const result = probe(["foo[", "&& x"]);
    expect(result).toEqual({
      kind: "reject",
      reason: "opens-delimiter",
      endIndex: 1,
    });
  });

  it("does not reject a head that merely contains a delimiter that is not trailing", () => {
    const result = probe(["const t = xs", "    .map(f);"]);
    expect(result.kind).toBe("hunk");
  });

  it("does not let a bad-indent run swallow a sibling statement at or above the head's own indent", () => {
    // contIndent (0) equals the head's own indent (0), which is exactly the
    // bad-indent condition. Without a stop at indentOf(head), the run
    // keeps extending through "const y = a" (also indent 0) and every line
    // of its own chain, so a real bad-indent rejection can swallow a
    // perfectly good following chain instead of just the one bad line.
    const result = probe([
      "const t = xs",
      ".map(f)",
      "const y = a",
      "    .b()",
      "    .c();",
    ]);
    expect(result).toEqual({
      kind: "reject",
      reason: "bad-indent",
      endIndex: 1,
    });
  });
});
