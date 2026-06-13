import { expect, test } from "vitest";
import { SAVE_TOUR_METHOD, SAVE_TOUR_FAILED_ERROR_CODE } from "./index.js";

test("saveTour protocol constants are stable", () => {
  expect(SAVE_TOUR_METHOD).toBe("hdtw/saveTour");
  expect(SAVE_TOUR_FAILED_ERROR_CODE).toBe(-32005);
});
