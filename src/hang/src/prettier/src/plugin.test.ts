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

  it("refuses to hang a wrapped if-condition, leaving Prettier's own block form", async () => {
    // The "if (" shape was 37% of the dogfood's hung output (23 of 63): the
    // head's own opening paren has no closer inside the run, so join-and-
    // shift could only ever glue the condition flush against "if (" and
    // leave the closing paren orphaned two columns left of everything it
    // closes. hunks.ts now refuses the whole shape (RejectReason
    // "opens-delimiter") rather than emit that. Needs
    // experimentalOperatorPosition: "start" to reproduce the real config,
    // since only then does a leading "&&" give the run a token to hang on.
    const narrow = {
      parser: "typescript" as const,
      tabWidth: 2,
      printWidth: 50,
      experimentalOperatorPosition: "start" as const,
    };
    const src =
      'function f(candidate: { kind: unknown }): boolean {\n  if (candidate.kind === "log" && typeof candidate.kind === "string") {\n    return true;\n  }\n  return false;\n}\n';
    const [out, plain] = await Promise.all([
      prettier.format(src, { ...narrow, plugins: [plugin] }),
      prettier.format(src, narrow),
    ]);
    expect(out).toBe(plain);
    expect(out).toContain(
      "  if (\n"
        + '    candidate.kind === "log"\n'
        + '    && typeof candidate.kind === "string"\n'
        + "  ) {\n",
    );
  });

  it("hangs an unrelated boolean chain that follows an earlier template substitution", async () => {
    // Regression for a guard soundness gap found during the monorepo
    // dogfood: sameTokens (src/hang/src/prettier/src/tokens.ts) drove
    // TypeScript's scanner with plain scan() calls and never called
    // reScanTemplateToken() after the "}" that closes a "${...}"
    // substitution, so the raw scanner read the template's own tail as
    // ordinary code and then treated its closing backtick as OPENING a new
    // template that swallowed everything up to the next backtick -- including
    // this file's own unrelated, otherwise-valid chain. Purely
    // over-rejection (never let a corruption through), but it declined
    // roughly 28 of 77 candidate chains in a codebase full of `${...}`
    // error-message templates. Uses an assignment's boolean run rather than
    // an `if (` condition, since that shape now refuses to hang regardless
    // of the guard (see the test above) and would no longer exercise this.
    const repoConfig = {
      parser: "typescript" as const,
      printWidth: 80,
      hangWidth: 100,
      experimentalOperatorPosition: "start" as const,
    };
    const src =
      "function f(candidate: { narration: unknown }, label: string, errors: string[]) {\n"
      + "  q(`${label}.title must be a non-empty string`);\n"
      + "  const invalid =\n"
      + '    typeof candidate.narration !== "string"\n'
      + "    || (candidate.narration as string).length === 0;\n"
      + "  if (invalid) {\n"
      + "    errors.push(`${label}.narration must be a non-empty string`);\n"
      + "  }\n"
      + "}\n";
    const out = await prettier.format(src, {
      ...repoConfig,
      plugins: [plugin],
    });
    expect(out).toBe(
      "function f(candidate: { narration: unknown }, label: string, errors: string[]) {\n"
        + "  q(`${label}.title must be a non-empty string`);\n"
        + '  const invalid = typeof candidate.narration !== "string"\n'
        + "                  || (candidate.narration as string).length === 0;\n"
        + "  if (invalid) {\n"
        + "    errors.push(`${label}.narration must be a non-empty string`);\n"
        + "  }\n"
        + "}\n",
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

  describe("endOfLine handling", () => {
    // Regression: printDocToString honors opts.endOfLine and returned CRLF
    // text; the plugin then split that text on a bare "\n", leaving a
    // dangling "\r" on every piece, and literalline's own join re-added the
    // real line ending on top of it -- doubling every hung line's terminator
    // to "\r\r\n". The existing engine-level CRLF test never goes through
    // the plugin, so it never saw this. Neither test can catch a regression
    // by matching its own broken output, since each pins an exact expected
    // string containing the correct single terminator.
    it("does not double the line ending when endOfLine is crlf", async () => {
      const out = await prettier.format(CHAIN, {
        ...withPlugin,
        endOfLine: "crlf",
      });
      expect(out).not.toMatch(/\r\r\n/);
      expect(out.split("\r\n").join("\n")).toBe(
        "const taken = regions.filter((region) => !region.growing)\n"
          + "                     .reduce((sum, region) => sum + regionRows(region, rowsOf), 0);\n",
      );
      expect(await prettier.format(out, { ...withPlugin, endOfLine: "crlf" }))
        .toBe(out);
    });

    it("does not double the line ending when endOfLine is auto and the source is CRLF", async () => {
      const crlfSource = CHAIN.replace(/\n/g, "\r\n");
      const out = await prettier.format(crlfSource, {
        ...withPlugin,
        endOfLine: "auto",
      });
      expect(out).not.toMatch(/\r\r\n/);
      expect(out).toMatch(/\r\n/);
      expect(await prettier.format(out, { ...withPlugin, endOfLine: "auto" }))
        .toBe(out);
    });
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
