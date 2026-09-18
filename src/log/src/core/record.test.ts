import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import fs from "node:fs";
import { buildRecord } from "./record.ts";

const schema = JSON.parse(fs.readFileSync("../../schema/madeit-log-v1.json", "utf8"));
const validate = new Ajv2020({ strict: false }).compile(schema);

const resource = {
  "service.name": "hookd",
  "service.version": "abc1234",
  "deployment.environment": "local",
  "madeit.repo": "agent-utilities",
  "madeit.component": "daemon",
};

describe("buildRecord", () => {
  it("produces a record the schema accepts", () => {
    const record = buildRecord({
      resource, severity: "INFO", body: "dispatch routed", event: "route",
      attributes: { "madeit.tool": "Bash" }, at: new Date("2026-09-10T08:00:00.000Z"),
    });
    expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
  });

  it("uses OpenTelemetry's canonical severity numbers", () => {
    // Borrowed, not invented: a collector reading these expects 5/9/13/17.
    const number = (s: "DEBUG" | "INFO" | "WARN" | "ERROR") =>
      buildRecord({ resource, severity: s, body: "b", event: "e" }).SeverityNumber;
    expect([number("DEBUG"), number("INFO"), number("WARN"), number("ERROR")])
      .toEqual([5, 9, 13, 17]);
  });

  it("puts the event slug in attributes, where it can be grouped", () => {
    const record = buildRecord({ resource, severity: "INFO", body: "b", event: "route" });
    expect(record.Attributes["madeit.event"]).toBe("route");
  });

  it("stamps RFC 3339 in UTC with milliseconds", () => {
    const record = buildRecord({
      resource, severity: "INFO", body: "b", event: "e",
      at: new Date("2026-09-10T08:00:00.123Z"),
    });
    expect(record.Timestamp).toBe("2026-09-10T08:00:00.123Z");
  });
});
