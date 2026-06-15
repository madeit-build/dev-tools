import { expect, test } from "vitest";
import type { GenerateTourParams } from "./generation.js";
import {
  GENERATE_TOUR_METHOD,
  GENERATION_AUTH_REQUIRED_ERROR_CODE,
  GENERATION_BUDGET_EXCEEDED_ERROR_CODE,
  GENERATION_FAILED_ERROR_CODE,
  GENERATION_PROGRESS_NOTIFICATION,
} from "./index.js";

test("generation protocol constants are stable", () => {
  expect(GENERATE_TOUR_METHOD).toBe("hdtw/generateTour");
  expect(GENERATION_PROGRESS_NOTIFICATION).toBe("hdtw/generationProgress");
  expect(GENERATION_AUTH_REQUIRED_ERROR_CODE).toBe(-32002);
  expect(GENERATION_FAILED_ERROR_CODE).toBe(-32003);
  expect(GENERATION_BUDGET_EXCEEDED_ERROR_CODE).toBe(-32004);
});

test("GenerateTourParams accepts an openai provider + baseUrl additively", () => {
  const p: GenerateTourParams = { workspaceRoot: "/w", topic: "t", provider: "openai", baseUrl: "http://localhost:11434/v1" };
  expect(p.provider).toBe("openai");
  const claudeDefault: GenerateTourParams = { workspaceRoot: "/w", topic: "t" };
  expect(claudeDefault.provider).toBeUndefined();
});
