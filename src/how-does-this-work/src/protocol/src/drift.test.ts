import { expect, test } from "vitest";
import { CHECK_TOUR_DRIFT_METHOD, REANCHOR_STEP_METHOD } from "./index.js";

test("drift protocol method names are stable", () => {
  expect(CHECK_TOUR_DRIFT_METHOD).toBe("hdtw/checkTourDrift");
  expect(REANCHOR_STEP_METHOD).toBe("hdtw/reanchorStep");
});
