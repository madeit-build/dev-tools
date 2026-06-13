import { describe, expect, test } from "vitest";
import { parseDraft } from "./claudeTourGenerator.js";
import { GenerationFailedError } from "./tourGenerator.js";

const VALID = `Here is the tour:
\`\`\`json
{ "title": "T", "summary": "S", "steps": [ { "title": "s1", "narration": "n", "anchor": { "file": "a.ts", "startLine": 1, "endLine": 2 } } ] }
\`\`\``;

describe("parseDraft", () => {
  test("extracts the last fenced json block", () => {
    const draft = parseDraft(VALID);
    expect(draft.title).toBe("T");
    expect(draft.steps).toHaveLength(1);
  });

  test("rejects non-JSON output", () => {
    expect(() => parseDraft("I could not complete the task")).toThrow(GenerationFailedError);
  });

  test("rejects structurally invalid drafts", () => {
    expect(() => parseDraft('```json\n{"title":"T"}\n```')).toThrow(GenerationFailedError);
  });
});
