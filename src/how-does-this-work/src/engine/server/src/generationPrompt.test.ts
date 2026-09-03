import { describe, expect, test } from "vitest";
import { parseDraft } from "./generationPrompt.js";
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

  test("accepts a draft with relatedTours on a step", () => {
    const text = `\`\`\`json
{ "title": "T", "summary": "S", "steps": [ { "title": "s1", "narration": "n", "anchor": { "file": "a.ts", "startLine": 1, "endLine": 2 }, "relatedTours": [ { "tourId": "other", "label": "Other" } ] } ] }
\`\`\``;
    const draft = parseDraft(text);
    expect(draft.steps[0].relatedTours).toEqual([{ tourId: "other", label: "Other" }]);
  });

  test("rejects relatedTours with a non-string tourId", () => {
    const text = `\`\`\`json
{ "title": "T", "summary": "S", "steps": [ { "title": "s1", "narration": "n", "anchor": { "file": "a.ts", "startLine": 1, "endLine": 2 }, "relatedTours": [ { "tourId": 5 } ] } ] }
\`\`\``;
    expect(() => parseDraft(text)).toThrow();
  });

  test("extracts the last fenced JSON block and validates a symbol-anchor draft", () => {
    const text = "thinking...\n```json\n" +
      JSON.stringify({ title: "T", summary: "S", steps: [{ title: "a", narration: "n", anchor: { file: "x.ts", symbol: "foo" } }] }) +
      "\n```\n";
    const draft = parseDraft(text);
    expect(draft.title).toBe("T");
    expect(draft.steps[0].anchor).toMatchObject({ file: "x.ts", symbol: "foo" });
  });

  test("parseDraft rejects non-JSON and malformed drafts", () => {
    expect(() => parseDraft("no json here")).toThrow();
    expect(() => parseDraft("```json\n{\"title\":\"\"}\n```")).toThrow();
  });
});
