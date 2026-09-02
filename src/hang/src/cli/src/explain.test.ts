import { describe, it, expect } from "vitest";
import { formatDecisions } from "./explain.js";
import type { Decision } from "@made-i-t/hang-core";

describe("formatDecisions", () => {
  it("reports an applied hang with its anchor column", () => {
    const decisions: Decision[] = [{ line: 12, applied: true, anchor: 21, links: 3 }];
    expect(formatDecisions("src/a.ts", decisions)).toBe(
      "src/a.ts\n  line 12  hung      3 links at column 21",
    );
  });

  it("reports each rejection with its reason", () => {
    const decisions: Decision[] = [
      { line: 3, applied: false, reason: "over-budget" },
      { line: 9, applied: false, reason: "verify-rejected" },
      { line: 14, applied: false, reason: "bad-indent" },
    ];
    expect(formatDecisions("src/b.ts", decisions)).toBe(
      [
        "src/b.ts",
        "  line 3   skipped   would exceed hangWidth",
        "  line 9   skipped   guard refused: the edit would change meaning",
        "  line 14  skipped   continuation is not indented past its head",
      ].join("\n"),
    );
  });

  it("says so when a file had no candidates at all", () => {
    expect(formatDecisions("src/c.ts", [])).toBe("src/c.ts\n  no candidates");
  });

  it("never includes source text", () => {
    const decisions: Decision[] = [{ line: 1, applied: true, anchor: 4, links: 2 }];
    expect(formatDecisions("src/d.ts", decisions)).not.toMatch(/[{}();=]/);
  });
});
