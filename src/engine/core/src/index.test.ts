import { expect, test } from "vitest";
import { getEngineInfo } from "./index.js";

test("getEngineInfo returns engine name and version", () => {
  expect(getEngineInfo()).toEqual({ name: "hdtw-engine", version: "0.0.1" });
});
