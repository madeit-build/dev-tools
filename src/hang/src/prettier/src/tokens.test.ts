import { describe, it, expect } from "vitest";
import { sameTokens } from "./tokens.js";

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
    const before = "const e = <div a={1} />;\nconst t = xs\n    .map(f)\n    .join('');";
    const after = "const e = <div a={1} />;\nconst t = xs.map(f)\n            .join('');";
    expect(sameTokens(before, after, "jsx")).toBe(true);
  });
});
