import { describe, expect, test } from "vitest";
import { parseLogLevel } from "./records.js";

describe("parseLogLevel", () => {
  test("accepts every valid level", () => {
    for (const level of ["trace", "debug", "info", "warn", "error"] as const) {
      expect(parseLogLevel(level, "info")).toBe(level);
    }
  });

  test("falls back on unrecognized, empty, or undefined input", () => {
    expect(parseLogLevel("verbose", "info")).toBe("info");
    expect(parseLogLevel("", "warn")).toBe("warn");
    expect(parseLogLevel(undefined, "error")).toBe("error");
  });
});
