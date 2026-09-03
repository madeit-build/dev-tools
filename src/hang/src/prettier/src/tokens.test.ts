import { describe, it, expect } from "vitest";
import Module from "node:module";
import { sameTokens, hasCompilerApi } from "./tokens.js";

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

  it("hasCompilerApi survives import under a TS7-shaped typescript module", async () => {
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
      expect(ts7Module.hasCompilerApi()).toBe(false);
    } finally {
      moduleWithLoad._load = originalLoad;
    }
  });

  it("hasCompilerApi reports true against the real, pinned typescript", () => {
    expect(hasCompilerApi()).toBe(true);
  });

  describe("after a template substitution (historical: swallowed the tail as code)", () => {
    // Round 1 defect: sameTokens drove a raw scanner one token at a time,
    // which read a template's substitution tail as ordinary code and its
    // closing backtick as OPENING a new, unrelated template that swallowed
    // everything up to the next backtick -- so a real change anywhere in
    // that swallowed span could look identical to no change at all, and the
    // guard rejected perfectly good hangs for no real reason (roughly 28 of
    // 77 candidate chains in the monorepo dogfood, in a codebase full of
    // `${...}` error-message templates). Fixed structurally, not by special-
    // casing templates: sameTokens now walks `ts.createSourceFile`'s own
    // parse tree (see streamOf's doc comment), which already resolves where
    // a template's substitution ends and its text resumes, the same way it
    // resolves every other context-sensitive token.
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

    it("handles a nested substitution followed by another substitution in the same template", () => {
      const before =
        'const msg = `outer ${`inner ${name}`} mid ${age} end`;\nif (\n  a\n  && b\n) {\n  c();\n}\n';
      const after =
        'const msg = `outer ${`inner ${name}`} mid ${age} end`;\nif (a\n    && b\n) {\n  c();\n}\n';
      expect(same(before, after)).toBe(true);
    });

    it("still rejects a real corruption after a nested substitution followed by another substitution", () => {
      const before =
        'const msg = `outer ${`inner ${name}`} mid ${age} end`;\nconst m = `a\n    .b not a chain`;\n';
      const after =
        'const msg = `outer ${`inner ${name}`} mid ${age} end`;\nconst m = `a.b not a chain`;\n';
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
      const before = 'const msg = `hi ${f({ a: 1 })} there`;\nif (\n  a\n  && b\n) {\n  c();\n}\n';
      const after = 'const msg = `hi ${f({ a: 1 })} there`;\nif (a\n    && b\n) {\n  c();\n}\n';
      expect(same(before, after)).toBe(true);
    });
  });

  describe("a regex literal's brace inside a substitution (historical: desynced a hand-rolled brace stack)", () => {
    // Round 2 defect: the first fix tracked template nesting with a
    // hand-rolled brace stack. A regex literal containing a bare,
    // non-quantifier "{" (e.g. `/x{/`) is indistinguishable from division by
    // a scanner with no parser context, so its brace got pushed onto that
    // stack as if it were ordinary code and never found a matching close --
    // reproducing the original swallowing bug from a different cause. Fixed
    // the same way as round 1's regression, by removing the hand-rolled
    // stack entirely rather than adding a fourth special case for regex-
    // versus-division: `ts.createSourceFile` already resolves `/` correctly
    // because that is an ordinary part of parsing, not an approximation of
    // it.
    //
    // eatenNewline wraps a guaranteed real corruption (an eaten newline
    // inside a later, unrelated template literal) behind each prefix, so
    // "false" always means "correctly rejected" and "true" always means
    // "shipped the corruption."
    const eatenNewline = (prefix: string) => {
      const before = prefix + 'const m = `a\n    .b not a chain`;\n';
      const after = prefix + "const m = `a.b not a chain`;\n";
      return same(before, after);
    };

    it("no preceding template: correctly rejects", () => {
      expect(eatenNewline("")).toBe(false);
    });

    it("a plain substitution: correctly rejects", () => {
      expect(eatenNewline("const msg = `hi ${name} there`;\n")).toBe(false);
    });

    it("a regex with a lone opening brace in a substitution: correctly rejects", () => {
      expect(eatenNewline("const msg = `hi ${/x{/} there`;\n")).toBe(false);
    });

    it("a realistic escaped-brace regex in a ternary substitution: correctly rejects", () => {
      expect(eatenNewline('const msg = `${/\\{/.test(s) ? "o" : "x"}`;\n')).toBe(false);
    });

    it("division inside a substitution, not a regex: correctly rejects", () => {
      expect(eatenNewline("const msg = `${a / b}`;\n")).toBe(false);
    });

    it("a lone closing brace in a regex: still accepts a whitespace-only change elsewhere", () => {
      const before = "const msg = `hi ${/x}/} there`;\nif (\n  a\n  && b\n) {\n  c();\n}\n";
      const after = "const msg = `hi ${/x}/} there`;\nif (a\n    && b\n) {\n  c();\n}\n";
      expect(same(before, after)).toBe(true);
    });

    it("a regex closing brace then an ordinary opening brace: still accepts a whitespace-only change elsewhere", () => {
      const before = "const msg = `hi ${/x}/ + f({})} there`;\nif (\n  a\n  && b\n) {\n  c();\n}\n";
      const after = "const msg = `hi ${/x}/ + f({})} there`;\nif (a\n    && b\n) {\n  c();\n}\n";
      expect(same(before, after)).toBe(true);
    });

    it("an ordinary opening brace then a regex closing brace: still accepts a whitespace-only change elsewhere", () => {
      const before = "const msg = `hi ${f({}) + /x}/} there`;\nif (\n  a\n  && b\n) {\n  c();\n}\n";
      const after = "const msg = `hi ${f({}) + /x}/} there`;\nif (a\n    && b\n) {\n  c();\n}\n";
      expect(same(before, after)).toBe(true);
    });

    it("a regex with both braces present: still accepts a whitespace-only change elsewhere", () => {
      const before = "const msg = `hi ${/x{}/} there`;\nif (\n  a\n  && b\n) {\n  c();\n}\n";
      const after = "const msg = `hi ${/x{}/} there`;\nif (a\n    && b\n) {\n  c();\n}\n";
      expect(same(before, after)).toBe(true);
    });

    it("a quantifier's braces, not a bare brace: still accepts a whitespace-only change elsewhere", () => {
      const before = 'const msg = `hi ${/a{2}/.test(s)} there`;\nif (\n  a\n  && b\n) {\n  c();\n}\n';
      const after = 'const msg = `hi ${/a{2}/.test(s)} there`;\nif (a\n    && b\n) {\n  c();\n}\n';
      expect(same(before, after)).toBe(true);
    });
  });

  describe("round 3 review exploits: regex-vs-division ambiguity broke the previous fix entirely", () => {
    // The round-2 fix (a hand-rolled brace stack) was itself defeated twice
    // more, this time without needing any template substitution at all:
    //
    // Exploit 1: a regex containing a literal backtick (`/`/`, valid JS) is
    // read by a raw scanner as ordinary code up to that backtick, which then
    // gets read as OPENING a template literal -- with no "${" ever seen, so
    // no brace stack activity at all, and the round-2 invariant (which only
    // watched brace balance) had nothing to catch. The swallowed span then
    // runs forward and can absorb a real, later corruption.
    //
    // Exploit 2, AS ORIGINALLY REPORTED (a regex brace inside a substitution
    // whose trailing template text itself contains a literal "}"), has no
    // known minimal STANDALONE repro against round 2: reconstructing round
    // 2's hand-rolled stack and testing directly shows the lone extra "{"
    // from `/x{/` gets pushed and then immediately popped by the very next
    // "}" (the regex's own trailing slash sits right before it), so the
    // stack happens to land back on the real TemplateHead by the time the
    // substitution's actual close arrives -- accidentally correct, by dumb
    // luck of that specific brace count, not because round 2 understood
    // anything. It only produces a genuine wrong ACCEPT once an exploit-1
    // style backtick-bearing regex is ALSO present earlier in the same
    // template: that regex's backtick gets misread as opening a bogus
    // template first, and everything downstream -- including exploit 2's own
    // brace juggling -- is then read inside that already-corrupted span. This
    // is also why the fuzz harness (tokens.fuzz.test.ts) only ever hit this
    // failure when its random noise happened to also supply a backtick-
    // bearing regex nearby, not from the exploit-2 shape alone.
    //
    // Both are closed by the same parser-based rewrite that closed the
    // round-2 defect: `ts.createSourceFile` resolves regex-versus-division
    // as part of ordinary parsing, so no regex's internal characters --
    // backtick, brace, or otherwise -- can ever be misread as ordinary code
    // in the first place. There is no stack left to desync.

    it("exploit 1: a regex containing a backtick does not poison a later template's newline check (standard)", () => {
      const before = "const r = /`/;\nconst m = `a\n    .b not a chain`;\n";
      const after = "const r = /`/;\nconst m = `a.b not a chain`;\n";
      expect(same(before, after)).toBe(false);
    });

    it("exploit 1: a regex containing a backtick does not poison a later template's newline check (jsx)", () => {
      const before = "const r = /`/;\nconst m = `a\n    .b not a chain`;\n";
      const after = "const r = /`/;\nconst m = `a.b not a chain`;\n";
      expect(sameTokens(before, after, "jsx")).toBe(false);
    });

    it("exploit 2 combined with exploit 1's backtick regex: genuinely fails against round 2, correctly rejects here (standard)", () => {
      // Confirmed by reconstructing round 2's streamOf from git history
      // (commit 28fd0d5) and running it side by side with the current
      // implementation: round 2 returns true (accepts the corruption) for
      // this exact pair; the current implementation returns false.
      const before = "const r = /`/;\nconst msg = `hi ${/x{/} end } there\n    .b not a chain`;\n";
      const after = "const r = /`/;\nconst msg = `hi ${/x{/} end } there.b not a chain`;\n";
      expect(same(before, after)).toBe(false);
    });

    it("exploit 2 combined with exploit 1's backtick regex: genuinely fails against round 2, correctly rejects here (jsx)", () => {
      const before = "const r = /`/;\nconst msg = `hi ${/x{/} end } there\n    .b not a chain`;\n";
      const after = "const r = /`/;\nconst msg = `hi ${/x{/} end } there.b not a chain`;\n";
      expect(sameTokens(before, after, "jsx")).toBe(false);
    });

    it("both exploit shapes still correctly accept a genuine whitespace-only change nearby", () => {
      const before1 = "const r = /`/;\nif (\n  a\n  && b\n) {\n  c();\n}\n";
      const after1 = "const r = /`/;\nif (a\n    && b\n) {\n  c();\n}\n";
      expect(same(before1, after1)).toBe(true);

      const before2 =
        "const r = /`/;\nconst msg = `hi ${/x{/} end } there`;\nif (\n  a\n  && b\n) {\n  c();\n}\n";
      const after2 =
        "const r = /`/;\nconst msg = `hi ${/x{/} end } there`;\nif (a\n    && b\n) {\n  c();\n}\n";
      expect(same(before2, after2)).toBe(true);
    });
  });
});
