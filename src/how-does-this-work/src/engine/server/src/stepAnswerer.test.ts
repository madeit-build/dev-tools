import { describe, expect, test } from "vitest";
import { buildStepAnswerPrompt } from "./stepAnswerer.js";

describe("buildStepAnswerPrompt", () => {
  const context = {
    file: "src/main.ts",
    startLine: 10,
    endLine: 20,
    narration: "stdio JSON-RPC.",
    tourTitle: "Architecture",
  };
  test("embeds the file, range, narration, and question", () => {
    const prompt = buildStepAnswerPrompt(context, "why stdio?");
    expect(prompt).toContain("src/main.ts (lines 10-20)");
    expect(prompt).toContain("stdio JSON-RPC.");
    expect(prompt).toContain("why stdio?");
    expect(prompt).toContain("Architecture");
  });
  test("tolerates a missing tour title", () => {
    const prompt = buildStepAnswerPrompt({ ...context, tourTitle: undefined }, "q");
    expect(prompt).toContain("(untitled)");
  });
});
