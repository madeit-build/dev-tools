import { describe, expect, test } from "vitest";
import { checkSymbolAnchorFreshness, computeSnippetHash, extractAnchoredText, verifyAnchor } from "./anchors.js";

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

test("checkSymbolAnchorFreshness: unchanged = fresh, moved-verbatim or content-changed = relocated, no range = symbol-missing", () => {
  const file = ["function a() {", "  return 1;", "}"].join("\n");
  const hash = computeSnippetHash("function a() {\n  return 1;\n}");
  const anchor = { startLine: 1, endLine: 3, snippetHash: hash };

  // same range, same content -> fresh
  expect(checkSymbolAnchorFreshness(anchor, { startLine: 1, endLine: 3 }, file)).toEqual({
    state: "fresh",
    startLine: 1,
    endLine: 3,
    snippetHash: hash,
  });

  // moved verbatim (content identical, new lines) -> relocated, cache refreshed to new range
  const moved = ["", "", "function a() {", "  return 1;", "}"].join("\n");
  const movedResult = checkSymbolAnchorFreshness(anchor, { startLine: 3, endLine: 5 }, moved);
  expect(movedResult.state).toBe("relocated");
  expect(movedResult).toMatchObject({ startLine: 3, endLine: 5, snippetHash: hash });

  // same range, content changed -> relocated with a new hash
  const edited = ["function a() {", "  return 2;", "}"].join("\n");
  const editedResult = checkSymbolAnchorFreshness(anchor, { startLine: 1, endLine: 3 }, edited);
  expect(editedResult.state).toBe("relocated");
  expect(editedResult.snippetHash).not.toBe(hash);

  // unresolved -> symbol-missing
  expect(checkSymbolAnchorFreshness(anchor, undefined, file)).toEqual({ state: "symbol-missing" });
});
