import { describe, expect, test } from "vitest";
import { computeSnippetHash, extractAnchoredText, verifyAnchor } from "./anchors.js";

describe("computeSnippetHash", () => {
  test("hashes text with the canonical sha256 prefix", () => {
    // sha256("hello") — well-known vector
    expect(computeSnippetHash("hello")).toBe(
      "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
  });
});

describe("extractAnchoredText", () => {
  test("extracts 1-based inclusive line ranges joined with \\n", () => {
    expect(extractAnchoredText("a\nb\nc\nd", 2, 3)).toBe("b\nc");
  });

  test("normalizes CRLF to LF", () => {
    expect(extractAnchoredText("a\r\nb\r\nc", 1, 2)).toBe("a\nb");
  });
});

describe("verifyAnchor", () => {
  const content = "line1\nline2\nline3";

  test("accepts an in-range anchor and returns the computed hash", () => {
    const result = verifyAnchor({ file: "a.ts", startLine: 1, endLine: 2 }, content);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snippetHash).toBe(computeSnippetHash("line1\nline2"));
    }
  });

  test("rejects a range past the end of the file", () => {
    const result = verifyAnchor({ file: "a.ts", startLine: 2, endLine: 9 }, content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toBe("a.ts: endLine 9 exceeds file length 3");
    }
  });

  test("rejects startLine below 1", () => {
    const result = verifyAnchor({ file: "a.ts", startLine: 0, endLine: 1 }, content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toBe("a.ts: startLine must be an integer >= 1 (got 0)");
    }
  });

  test("rejects endLine before startLine", () => {
    const result = verifyAnchor({ file: "a.ts", startLine: 3, endLine: 2 }, content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toBe("a.ts: endLine 2 is before startLine 3");
    }
  });

  test("collects multiple errors", () => {
    const result = verifyAnchor({ file: "a.ts", startLine: 0, endLine: 99 }, content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(2);
    }
  });
});
