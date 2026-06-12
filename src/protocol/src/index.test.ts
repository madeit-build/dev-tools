import { expect, test } from "vitest";
import { PING_METHOD, PROTOCOL_VERSION } from "./index";

test("protocol constants are stable", () => {
  expect(PING_METHOD).toBe("hdtw/ping");
  expect(PROTOCOL_VERSION).toBe("0.0.1");
});
