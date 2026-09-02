import { describe, it, expect } from "vitest";
import { hangAlign } from "./engine.js";
import type { Adapter, HangOptions } from "./types.js";

const OPTIONS: HangOptions = { printWidth: 80, hangWidth: 100, tabWidth: 4 };

const acceptAll: Adapter = {
  continuationTokens: [".", "&&", "||", "??"],
  verify: () => true,
};

/** Rejects any candidate text containing the marker, to exercise the fallback. */
const rejectContaining = (marker: string): Adapter => ({
  continuationTokens: [".", "&&", "||", "??"],
  verify: (_before, after) => !after.includes(marker),
});

describe("hangAlign", () => {
  it("hangs a chain and reports it as applied", () => {
    const input = ["const taken = regions", "    .filter(f)", "    .reduce(g, 0);"].join("\n");
    const result = hangAlign(input, acceptAll, OPTIONS);
    expect(result.text).toBe(
      ["const taken = regions.filter(f)", "                     .reduce(g, 0);"].join("\n"),
    );
    expect(result.decisions).toEqual([{ line: 1, applied: true, anchor: 21, links: 2 }]);
  });

  it("returns the input untouched when there is nothing to do", () => {
    const input = "const a = 1;\nconst b = 2;\n";
    const result = hangAlign(input, acceptAll, OPTIONS);
    expect(result.text).toBe(input);
    expect(result.decisions).toEqual([]);
  });

  it("refuses a hunk that would exceed hangWidth and says why", () => {
    const long = "x".repeat(70);
    const input = ["const taken = regionsAndMore", `    .filter(${long})`, "    .reduce(g, 0);"].join("\n");
    const result = hangAlign(input, acceptAll, { ...OPTIONS, hangWidth: 60 });
    expect(result.text).toBe(input);
    expect(result.decisions).toEqual([{ line: 1, applied: false, reason: "over-budget" }]);
  });

  it("records bad-indent as a rejection, not a silent skip", () => {
    const input = ["const t = xs", ".map(f)"].join("\n");
    const result = hangAlign(input, acceptAll, OPTIONS);
    expect(result.decisions).toEqual([{ line: 1, applied: false, reason: "bad-indent" }]);
  });

  it("emits no decision for a line that was never a candidate", () => {
    const result = hangAlign("const a = 1;\nconst b = 2;", acceptAll, OPTIONS);
    expect(result.decisions).toEqual([]);
  });

  it("keeps the good hunk when the guard rejects one of two", () => {
    const input = [
      "const good = regions",
      "    .filter(f)",
      "    .reduce(g, 0);",
      "const bad = POISON",
      "    .filter(h)",
      "    .reduce(k, 0);",
    ].join("\n");
    const result = hangAlign(input, rejectContaining("POISON.filter"), OPTIONS);
    expect(result.text).toContain("const good = regions.filter(f)");
    expect(result.text).toContain("const bad = POISON\n    .filter(h)");
    expect(result.decisions).toEqual([
      { line: 1, applied: true, anchor: 20, links: 2 },
      { line: 4, applied: false, reason: "verify-rejected" },
    ]);
  });

  it("returns the original text when the guard rejects everything", () => {
    const input = ["const t = regions", "    .filter(f)", "    .reduce(g, 0);"].join("\n");
    const result = hangAlign(input, rejectContaining("regions.filter"), OPTIONS);
    expect(result.text).toBe(input);
    expect(result.decisions).toEqual([{ line: 1, applied: false, reason: "verify-rejected" }]);
  });

  it("reports decisions in line order", () => {
    const input = [
      "const a = one",
      "    .f()",
      "    .g();",
      "const b = two",
      "    .f()",
      "    .g();",
    ].join("\n");
    const result = hangAlign(input, acceptAll, OPTIONS);
    expect(result.decisions.map((d) => d.line)).toEqual([1, 4]);
  });
});
