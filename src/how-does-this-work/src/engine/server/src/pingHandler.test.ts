import { expect, test } from "vitest";
import { PROTOCOL_VERSION } from "@made-i-t/hdtw-protocol";
import { handlePing } from "./pingHandler.js";

test("handlePing returns engine identity and protocol version", () => {
  const result = handlePing({
    clientName: "test",
    protocolVersion: PROTOCOL_VERSION,
  });
  expect(result).toEqual({
    engineName: "hdtw-engine",
    engineVersion: "0.0.1",
    protocolVersion: PROTOCOL_VERSION,
  });
});
