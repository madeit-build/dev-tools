import { expect, test } from "vitest";
import { ASK_ABOUT_STEP_METHOD } from "./index.js";

test("askAboutStep method name is stable", () => {
  expect(ASK_ABOUT_STEP_METHOD).toBe("hdtw/askAboutStep");
});
