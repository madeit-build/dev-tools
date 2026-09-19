import { describe, it, expect } from "vitest";
import { formatDecisions, resolveHangOptions } from "./explain.js";
import type { Decision } from "@made-i-t/hang-core";
import { options as pluginOptions } from "@made-i-t/hang-prettier";

describe("formatDecisions", () => {
  it("reports an applied hang with its anchor column", () => {
    const decisions: Decision[] = [
      { line: 12, applied: true, anchor: 21, links: 3 },
    ];
    expect(formatDecisions("src/a.ts", decisions)).toBe(
      "src/a.ts\n  line 12  hung      3 links at column 21",
    );
  });

  it("reports each rejection with its reason", () => {
    const decisions: Decision[] = [
      { line: 3, applied: false, reason: "over-budget" },
      { line: 9, applied: false, reason: "verify-rejected" },
      { line: 14, applied: false, reason: "bad-indent" },
      { line: 20, applied: false, reason: "nested-content" },
      { line: 25, applied: false, reason: "opens-delimiter" },
      { line: 30, applied: false, reason: "single-link" },
      { line: 35, applied: false, reason: "use-tabs" },
    ];
    expect(formatDecisions("src/b.ts", decisions)).toBe(
      [
        "src/b.ts",
        "  line 3   skipped   would exceed hangWidth",
        "  line 9   skipped   guard refused: the edit would change meaning",
        "  line 14  skipped   continuation is not indented past its head",
        "  line 20  skipped   a link in this chain has its own multi-line content",
        "  line 25  skipped   head ends with its own opening delimiter, which the run does not close",
        "  line 30  skipped   only one link: nothing to align by joining it up",
        "  line 35  skipped   useTabs is set: hang can't compute columns across tab indentation yet",
      ].join("\n"),
    );
  });

  it("says so when a file had no candidates at all", () => {
    expect(formatDecisions("src/c.ts", [])).toBe("src/c.ts\n  no candidates");
  });
});

describe("resolveHangOptions", () => {
  it("takes hangWidth from the plugin's own declared default, not printWidth + 20", () => {
    // printWidth 60 pins this: printWidth + 20 would be 80, which only ever
    // matches the plugin's default (100) by coincidence at printWidth 80.
    // Regressing to that formula here would make this assertion fail.
    const resolved = resolveHangOptions({ printWidth: 60, tabWidth: 4 });
    expect(resolved.hangWidth).toBe(pluginOptions.hangWidth.default);
    expect(resolved).toEqual({
      printWidth: 60,
      hangWidth: pluginOptions.hangWidth.default,
      tabWidth: 4,
      useTabs: false,
    });
  });

  it("defaults printWidth to 80 and tabWidth to 2 when prettier.resolveConfig found neither", () => {
    expect(resolveHangOptions({})).toEqual({
      printWidth: 80,
      hangWidth: pluginOptions.hangWidth.default,
      tabWidth: 2,
      useTabs: false,
    });
  });

  it("passes a configured hangWidth through unchanged instead of overwriting it with the plugin default", () => {
    // Derived from the live default rather than a fixed literal, so this stays
    // a genuinely different value even if the plugin's default ever changes.
    const configured = pluginOptions.hangWidth.default + 40;
    const resolved = resolveHangOptions({
      printWidth: 80,
      hangWidth: configured,
      tabWidth: 2,
    });
    expect(resolved.hangWidth).toBe(configured);
    expect(resolved.hangWidth).not.toBe(pluginOptions.hangWidth.default);
  });

  it("passes useTabs through so a tab-indented project's decisions match the plugin's own refusal", () => {
    expect(resolveHangOptions({ useTabs: true }).useTabs).toBe(true);
  });
});
