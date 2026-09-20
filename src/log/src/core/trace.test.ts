import { describe, expect, it } from "vitest";
import { mintTraceparent, parseTraceparent } from "./trace.ts";

describe("traceparent", () => {
  it("mints the W3C shape", () => {
    expect(mintTraceparent()).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it("mints a different trace every time", () => {
    expect(mintTraceparent()).not.toBe(mintTraceparent());
  });

  it("round-trips what it minted", () => {
    const value = mintTraceparent();
    const parsed = parseTraceparent(value);
    expect(value).toContain(parsed?.traceId);
    expect(value).toContain(parsed?.spanId);
  });

  it("accepts a traceparent minted elsewhere", () => {
    const parsed = parseTraceparent(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    expect(parsed).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7",
    });
  });

  it("returns null for anything it cannot trust", () => {
    // An unparseable header is not a trace. Guessing would link records into a
    // trace that never existed, which is worse than no trace at all.
    for (const bad of [undefined, "", "nonsense", "00-short-00f067aa0ba902b7-01",
                       "00-" + "0".repeat(32) + "-" + "0".repeat(16) + "-01"]) {
      expect(parseTraceparent(bad), String(bad)).toBeNull();
    }
  });
});
