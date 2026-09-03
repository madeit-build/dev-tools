import { describe, it, expect } from "vitest";
import Module from "node:module";
import { sameTokens, hasScanner } from "./tokens.js";

const same = (before: string, after: string) => sameTokens(before, after, "standard");

describe("sameTokens", () => {
  it("accepts a chain hung under its receiver", () => {
    expect(same(
      "const t = regions\n    .filter(f)\n    .reduce(g, 0);",
      "const t = regions.filter(f)\n                 .reduce(g, 0);",
    )).toBe(true);
  });

  it("rejects a newline eaten from inside a template literal", () => {
    expect(same("const m = `a\n    .b not a chain`;", "const m = `a.b not a chain`;")).toBe(false);
  });

  it("rejects dropped type arguments", () => {
    expect(same("const g = c.request<Shape>(u).then(h);", "const g = c.request(u).then(h);")).toBe(false);
  });

  it("accepts a line comment shifted with its chain", () => {
    expect(same(
      "const c = t\n    .f(x)\n    // note\n    .g(y);",
      "const c = t.f(x)\n           // note\n           .g(y);",
    )).toBe(true);
  });

  it("rejects a deleted comment", () => {
    expect(same("const a = 1; // keep", "const a = 1;")).toBe(false);
  });

  it("rejects a reindented block comment, whose own text would change", () => {
    expect(same(
      "const c = t\n    .f(x)\n    /* one\n       two */\n    .g(y);",
      "const c = t.f(x)\n           /* one\n              two */\n           .g(y);",
    )).toBe(false);
  });

  it("tolerates cosmetic whitespace loss that changes no token", () => {
    expect(same("const a = f((r) => r.json());", "const a = f((r) =>r.json());")).toBe(true);
  });

  it("is stable across a regex literal", () => {
    const before = "const r = xs\n    .filter((s) => /a\\/b/.test(s))\n    .map(g);";
    const after = "const r = xs.filter((s) => /a\\/b/.test(s))\n            .map(g);";
    expect(same(before, after)).toBe(true);
  });

  it("scans JSX under the jsx variant", () => {
    const before = "const e = <div a={1}>x</div>;\nconst t = xs\n    .map(f)\n    .join('');";
    const after = "const e = <div a={1}>x</div>;\nconst t = xs.map(f)\n            .join('');";
    expect(sameTokens(before, after, "jsx")).toBe(true);
  });

  it("the jsx variant is not incidental: only it catches a broken closing tag", () => {
    // Under jsx, "</" merges into one token only when adjacent, so a space
    // splitting it is a real change. The plain scanner has no such token and
    // treats the space as cosmetic, which is exactly the gap the variant closes.
    expect(sameTokens("</div>", "< /div>", "jsx")).toBe(false);
    expect(sameTokens("</div>", "< /div>", "standard")).toBe(true);
  });

  it("does not detect an ASI hazard on its own, a documented boundary", () => {
    // See sameTokens' doc comment: unreachable via this transform today because
    // no continuation token can follow a restricted-production keyword.
    const before = "function f() {\n  return\n  { ok: true };\n}";
    const after = "function f() {\n  return { ok: true };\n}";
    expect(same(before, after)).toBe(true);
  });

  it("hasScanner survives import under a TS7-shaped typescript module", async () => {
    // TS7 drops the compiler API, exposing only version/versionMajorMinor.
    // Patching Node's own module loader is the only way to simulate that
    // shape here: createRequire resolves through Node's real CJS loader,
    // which bypasses vitest's own module-mocking entirely.
    const moduleWithLoad = Module as unknown as { _load: (...args: unknown[]) => unknown };
    const originalLoad = moduleWithLoad._load;
    moduleWithLoad._load = function (this: unknown, request: string, ...rest: unknown[]) {
      if (request === "typescript") {
        return { version: "7.0.0", versionMajorMinor: "7.0" };
      }
      return (originalLoad as (...args: unknown[]) => unknown).apply(this, [request, ...rest]);
    };
    try {
      const ts7Module = await import("./tokens.js?ts7-shaped-module-test");
      expect(ts7Module.hasScanner()).toBe(false);
    } finally {
      moduleWithLoad._load = originalLoad;
    }
  });

  it("hasScanner reports true against the real, pinned typescript", () => {
    expect(hasScanner()).toBe(true);
  });

  describe("after a template substitution", () => {
    // Regression: sameTokens drove the scanner with plain scan() calls and
    // never called reScanTemplateToken() after the "}" that closes a "${...}"
    // substitution. The raw scanner then reads the template's own tail as
    // ordinary code and treats its closing backtick as OPENING a new,
    // unrelated template that swallows everything up to the next backtick --
    // so a real change anywhere in that swallowed span makes the two token
    // streams differ length-for-length even when the change is whitespace
    // only, and the guard rejects a perfectly good hang for no real reason.
    // This declined roughly 28 of 77 candidate chains in the monorepo
    // dogfood, in a codebase full of `${...}` error-message templates.

    it("accepts a whitespace-only change after an earlier template substitution", () => {
      const before =
        'const msg = `hi ${name} there`;\nif (\n  a\n  && b\n) {\n  c();\n}\n';
      const after =
        'const msg = `hi ${name} there`;\nif (a\n    && b\n) {\n  c();\n}\n';
      expect(same(before, after)).toBe(true);
    });

    it("still rejects dropped type arguments after an earlier template substitution", () => {
      const before = 'const msg = `hi ${name} there`;\nconst g = c.request<Shape>(u).then(h);\n';
      const after = 'const msg = `hi ${name} there`;\nconst g = c.request(u).then(h);\n';
      expect(same(before, after)).toBe(false);
    });

    it("still rejects a deleted comment after an earlier template substitution", () => {
      const before = 'const msg = `hi ${name} there`;\nconst a = 1; // keep\n';
      const after = 'const msg = `hi ${name} there`;\nconst a = 1;\n';
      expect(same(before, after)).toBe(false);
    });

    it("still rejects an eaten newline inside a template literal that follows an earlier substitution", () => {
      const before = 'const msg = `hi ${name} there`;\nconst m = `a\n    .b not a chain`;\n';
      const after = 'const msg = `hi ${name} there`;\nconst m = `a.b not a chain`;\n';
      expect(same(before, after)).toBe(false);
    });

    it("handles a nested substitution: a template literal inside a ${}", () => {
      const before =
        'const msg = `outer ${`inner ${name}`} end`;\nif (\n  a\n  && b\n) {\n  c();\n}\n';
      const after =
        'const msg = `outer ${`inner ${name}`} end`;\nif (a\n    && b\n) {\n  c();\n}\n';
      expect(same(before, after)).toBe(true);
    });

    it("still rejects a real corruption after a nested substitution", () => {
      const before = 'const msg = `outer ${`inner ${name}`} end`;\nconst a = 1; // keep\n';
      const after = 'const msg = `outer ${`inner ${name}`} end`;\nconst a = 1;\n';
      expect(same(before, after)).toBe(false);
    });

    it("handles a tagged template's substitution", () => {
      const before =
        'const msg = tag`hi ${name} there`;\nif (\n  a\n  && b\n) {\n  c();\n}\n';
      const after = 'const msg = tag`hi ${name} there`;\nif (a\n    && b\n) {\n  c();\n}\n';
      expect(same(before, after)).toBe(true);
    });

    it("still rejects a real corruption after a tagged template's substitution", () => {
      const before = 'const msg = tag`hi ${name} there`;\nconst a = 1; // keep\n';
      const after = 'const msg = tag`hi ${name} there`;\nconst a = 1;\n';
      expect(same(before, after)).toBe(false);
    });

    it("does not mistake an ordinary object literal inside a substitution for the substitution's own close", () => {
      // `${ f({ a: 1 }) }` has two "}" before the template resumes: the object
      // literal's own and the substitution's. Only the second should trigger
      // reScanTemplateToken; treating the first as a template boundary would
      // desynchronize the scanner just like the original bug.
      const before = 'const msg = `hi ${f({ a: 1 })} there`;\nif (\n  a\n  && b\n) {\n  c();\n}\n';
      const after = 'const msg = `hi ${f({ a: 1 })} there`;\nif (a\n    && b\n) {\n  c();\n}\n';
      expect(same(before, after)).toBe(true);
    });
  });
});
