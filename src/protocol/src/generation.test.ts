import { expect, test } from "vitest";
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
