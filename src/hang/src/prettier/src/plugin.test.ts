import { describe, it, expect, vi, beforeEach } from "vitest";
import * as prettier from "prettier";
import { hangAlign } from "@made-i-t/hang-core";
import { createAdapter } from "./adapter.js";
import * as plugin from "./plugin.js";

// Passing the plugin as an imported module object, rather than a file path,
// sidesteps Prettier having to load TypeScript through its own import().
const base = { parser: "typescript" as const, tabWidth: 4, printWidth: 90 };
const withPlugin = { ...base, plugins: [plugin] };

const CHAIN =
  "const taken = regions.filter((region) => !region.growing)"
  + ".reduce((sum, region) => sum + regionRows(region, rowsOf), 0);\n";

const MULTI_STATEMENT =
  'const short = xs.map(f).join(",");\n'
  + "const taken = regions.filter((region) => !region.growing)"
  + ".reduce((sum, region) => sum + regionRows(region, rowsOf), 0);\n"
  + "const alsoShort = ys.filter(g);\n";

const WITH_COMMENTS_AND_BLANKS =
  "// leading file comment\n"
  + "\n"
  + "// a comment right before the chain\n"
  + "const taken = regions.filter((region) => !region.growing)"
  + ".reduce((sum, region) => sum + regionRows(region, rowsOf), 0);\n"
  + "\n"
  + "const other = 1;\n";

let forceHangAlignFailure = false;

vi.mock("@made-i-t/hang-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@made-i-t/hang-core")>();
  return {
    ...actual,
    hangAlign: (...args: Parameters<typeof actual.hangAlign>) => {
      if (forceHangAlignFailure) {
        throw new Error("forced failure for the fail-closed test");
      }
      return actual.hangAlign(...args);
    },
  };
});

beforeEach(() => {
  forceHangAlignFailure = false;
});

describe("the plugin", () => {
  it("hangs a chain under its receiver", async () => {
    const out = await prettier.format(CHAIN, withPlugin);
    expect(out).toBe(
      "const taken = regions.filter((region) => !region.growing)\n"
        + "                     .reduce((sum, region) => sum + regionRows(region, rowsOf), 0);\n",
    );
  });

  it("is idempotent", async () => {
    const once = await prettier.format(CHAIN, withPlugin);
    expect(await prettier.format(once, withPlugin)).toBe(once);
  });

  it("preserves type arguments, which the reprinting approach dropped", async () => {
    const src =
      "const g = client.request<Shape>(url).then<Parsed>((r) => r.json(), onError).finish(zz);\n";
    const out = await prettier.format(src, withPlugin);
    expect(out).toContain("<Shape>");
    expect(out).toContain("<Parsed>");
  });

  it("leaves a multi-line template literal alone", async () => {
    const src = "const msg = `a\n    .b not a chain`;\n";
    expect(await prettier.format(src, withPlugin)).toBe(src);
  });

  it("leaves short chains on one line", async () => {
    const src = 'const s = xs.map(f).join(",");\n';
    expect(await prettier.format(src, withPlugin)).toBe(src);
  });

  it("respects hangWidth from config", async () => {
    const narrow = await prettier.format(CHAIN, {
      ...withPlugin,
      hangWidth: 60,
    });
    expect(narrow).toBe(await prettier.format(CHAIN, base));
  });

  describe("feeds hangAlign exactly what Prettier alone produces", () => {
    // This property is what lets Task 7's --explain compute diagnostics by running
    // hangAlign on plain Prettier output instead of the plugin. It has to hold across
    // shapes, not just the single-chain fixture, or --explain would report decisions
    // the plugin never actually made.
    it("a single top-level chain", async () => {
      const plain = await prettier.format(CHAIN, base);
      const viaCore = hangAlign(plain, createAdapter("x.ts"), {
        printWidth: 90,
        hangWidth: 100,
        tabWidth: 4,
      }).text;
      expect(await prettier.format(CHAIN, withPlugin)).toBe(viaCore);
    });

    it("a multi-statement file where only one statement's chain hangs", async () => {
      const plain = await prettier.format(MULTI_STATEMENT, base);
      const viaCore = hangAlign(plain, createAdapter("x.ts"), {
        printWidth: 90,
        hangWidth: 100,
        tabWidth: 4,
      }).text;
      expect(await prettier.format(MULTI_STATEMENT, withPlugin)).toBe(viaCore);
    });

    it("leading comments and blank lines between statements", async () => {
      const plain = await prettier.format(WITH_COMMENTS_AND_BLANKS, base);
      const viaCore = hangAlign(plain, createAdapter("x.ts"), {
        printWidth: 90,
        hangWidth: 100,
        tabWidth: 4,
      }).text;
      expect(await prettier.format(WITH_COMMENTS_AND_BLANKS, withPlugin)).toBe(
        viaCore,
      );
    });

    it("a non-default tabWidth and printWidth combination", async () => {
      const narrow = {
        parser: "typescript" as const,
        tabWidth: 2,
        printWidth: 60,
      };
      const plain = await prettier.format(CHAIN, narrow);
      const viaCore = hangAlign(plain, createAdapter("x.ts"), {
        printWidth: 60,
        hangWidth: 100,
        tabWidth: 2,
      }).text;
      expect(
        await prettier.format(CHAIN, { ...narrow, plugins: [plugin] }),
      ).toBe(viaCore);
    });
  });

  it("hangs inside a nested block, relative to that block's indent", async () => {
    const src =
      "function f() {\n"
      + "  const t = regions.filterOutTheGrowingOnes((r) => !r.growing).reduceToTotal((s, r) => s + r, 0);\n"
      + "}\n";
    const out = await prettier.format(src, withPlugin);
    const lines = out.split("\n");
    const head = lines.find((line) =>
      line.includes(".filterOutTheGrowingOnes("),
    );
    const continuation = lines.find((line) =>
      line.trimStart().startsWith(".reduceToTotal("),
    );
    expect(head).toBeDefined();
    expect(continuation).toBeDefined();
    const anchor = head!.indexOf(".filterOutTheGrowingOnes(");
    expect(continuation!.length - continuation!.trimStart().length).toBe(
      anchor,
    );
  });

  it("fails closed: a thrown error falls back to plain Prettier output and never logs source text", async () => {
    const DISTINCTIVE_SOURCE =
      "const regionsMarkerXyzzy999 = regions.filter((region) => !region.growing)"
      + ".reduce((sum, region) => sum + regionRows(region, rowsOf), 0);\n";
    const stderrWrite = vi.spyOn(process.stderr, "write")
                          .mockImplementation(() => true);
    forceHangAlignFailure = true;
    try {
      const [viaPlugin, plain] = await Promise.all([
        prettier.format(DISTINCTIVE_SOURCE, withPlugin),
        prettier.format(DISTINCTIVE_SOURCE, base),
      ]);
      expect(viaPlugin).toBe(plain);
      expect(plugin.getLastFailure()).toBe(
        "forced failure for the fail-closed test",
      );
      expect(stderrWrite).toHaveBeenCalled();
      const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk))
                                            .join("");
      expect(written).not.toContain("regionsMarkerXyzzy999");
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("formats a .tsx file end-to-end: a closing tag survives alongside a hung chain", async () => {
    const src =
      "function List() {\n"
      + "  return (\n"
      + '    <div className="list">\n'
      + "      {regions.filterOutTheGrowingOnes((r) => !r.growing).reduceToTotal((s, r) => s + r, 0)}\n"
      + "    </div>\n"
      + "  );\n"
      + "}\n";
    const out = await prettier.format(src, {
      ...withPlugin,
      filepath: "list.tsx",
    });
    expect(out).toContain("</div>");
    const lines = out.split("\n");
    const head = lines.find((line) =>
      line.includes(".filterOutTheGrowingOnes("),
    );
    const continuation = lines.find((line) =>
      line.trimStart().startsWith(".reduceToTotal("),
    );
    expect(head).toBeDefined();
    expect(continuation).toBeDefined();
    const anchor = head!.indexOf(".filterOutTheGrowingOnes(");
    expect(continuation!.length - continuation!.trimStart().length).toBe(
      anchor,
    );
  });
});
