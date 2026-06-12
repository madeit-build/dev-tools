import { describe, expect, test } from "vitest";
import { parseTour, toErrorSummary, toTourSummary } from "./tours.js";

function validTourJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    id: "demo",
    title: "Demo tour",
    summary: "A demo",
    steps: [
      {
        title: "Step one",
        anchor: {
          file: "src/index.ts",
          startLine: 1,
          endLine: 3,
          snippetHash: "sha256:abc123",
        },
        narration: "Hello.",
      },
    ],
    ...overrides,
  });
}

describe("parseTour", () => {
  test("accepts a valid tour", () => {
    const result = parseTour(validTourJson(), "demo");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tour.id).toBe("demo");
      expect(result.tour.steps).toHaveLength(1);
    }
  });

  test("rejects invalid JSON", () => {
    const result = parseTour("{nope", "demo");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("not valid JSON");
  });

  test("rejects a JSON array root", () => {
    const result = parseTour("[]", "demo");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("root must be a JSON object");
  });

  test("rejects a JSON primitive root", () => {
    const result = parseTour('"a string"', "demo");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("root must be a JSON object");
  });

  test("rejects wrong schemaVersion", () => {
    const result = parseTour(validTourJson({ schemaVersion: 2 }), "demo");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("schemaVersion must be 1");
  });

  test("rejects id/filename mismatch", () => {
    const result = parseTour(validTourJson(), "other-name");
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors).toContain('id "demo" must match filename stem "other-name"');
  });

  test("rejects empty steps", () => {
    const result = parseTour(validTourJson({ steps: [] }), "demo");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("steps must be a non-empty array");
  });

  test("rejects bad anchors", () => {
    const badAnchorStep = {
      title: "Bad",
      anchor: { file: "/abs/path.ts", startLine: 0, endLine: -1, snippetHash: "md5:zz" },
      narration: "x",
    };
    const result = parseTour(validTourJson({ steps: [badAnchorStep] }), "demo");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        "steps[0].anchor.file must be a workspace-relative POSIX path"
      );
      expect(result.errors).toContain("steps[0].anchor.startLine must be an integer >= 1");
      expect(result.errors).toContain(
        'steps[0].anchor.snippetHash must be a string starting with "sha256:"'
      );
    }
  });

  test("rejects endLine before startLine", () => {
    const step = {
      title: "Bad range",
      anchor: { file: "a.ts", startLine: 5, endLine: 2, snippetHash: "sha256:aa" },
      narration: "x",
    };
    const result = parseTour(validTourJson({ steps: [step] }), "demo");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("steps[0].anchor.endLine must be >= startLine");
  });
});

describe("summaries", () => {
  test("toTourSummary maps a tour", () => {
    const result = parseTour(validTourJson(), "demo");
    if (!result.ok) throw new Error("expected valid tour");
    expect(toTourSummary(result.tour)).toEqual({
      id: "demo",
      title: "Demo tour",
      summary: "A demo",
      stepCount: 1,
    });
  });

  test("toErrorSummary marks tour invalid", () => {
    const summary = toErrorSummary("broken", ["a", "b"]);
    expect(summary).toEqual({
      id: "broken",
      title: "broken",
      summary: "",
      stepCount: 0,
      error: "a; b",
    });
  });
});
