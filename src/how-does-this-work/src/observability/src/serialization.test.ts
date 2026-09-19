import { describe, expect, test } from "vitest";
import type { LogRecord } from "./records.js";
import { parseRecord, serializeRecord } from "./serialization.js";

const record: LogRecord = {
  kind: "log",
  ts: 1717000000000,
  level: "info",
  event: "generate.start",
  fields: { topic: "x" },
};

describe("NDJSON round-trip", () => {
  test("serializeRecord produces a single newline-free JSON line", () => {
    const line = serializeRecord(record);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual(record);
  });

  test("parseRecord reverses serializeRecord", () => {
    expect(parseRecord(serializeRecord(record))).toEqual(record);
  });

  test("parseRecord returns null for non-record lines", () => {
    expect(parseRecord("a raw stack trace line")).toBeNull();
    expect(parseRecord('{"not":"a record"}')).toBeNull();
    expect(parseRecord("")).toBeNull();
    expect(parseRecord("   ")).toBeNull();
  });

  test("parseRecord accepts metric records", () => {
    const line = serializeRecord({
      kind: "metric",
      ts: 1,
      metric: "count",
      name: "verify.drift",
      value: 2,
    });
    expect(parseRecord(line)).toMatchObject({
      kind: "metric",
      name: "verify.drift",
    });
  });
});
