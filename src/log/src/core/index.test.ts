import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import fs from "node:fs";
import { getLogger as getLogtapeLogger } from "@logtape/logtape";
import { getLogger } from "./index.ts";
import type { LogRecord } from "./record.ts";

const schema = JSON.parse(fs.readFileSync("../../schema/madeit-log-v1.json", "utf8"));
const validate = new Ajv2020({ strict: false }).compile(schema);

function capture() {
  const seen: LogRecord[] = [];
  const logger = getLogger({
    service: "hookd", version: "abc1234", environment: "test",
    repo: "agent-utilities", component: "daemon",
    sinks: [(r) => { seen.push(r); }],
  });
  return { logger, seen };
}

describe("getLogger", () => {
  it("every level emits a record the schema accepts", () => {
    const { logger, seen } = capture();
    logger.debug("a.b", "d"); logger.info("a.b", "i");
    logger.warn("a.b", "w"); logger.error("a.b", "e");
    expect(seen).toHaveLength(4);
    for (const record of seen) expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
  });

  it("REDACTS BEFORE ANY SINK SEES IT", () => {
    // Redaction in the wrapper rather than in a sink, so a misconfigured sink
    // cannot leak what the wrapper already removed.
    const { logger, seen } = capture();
    logger.info("a.b", "body", { "madeit.token": "sk-live", "madeit.tool": "Bash" });
    expect(seen[0]?.Attributes["madeit.token"]).toBeUndefined();
    expect(seen[0]?.Attributes["madeit.tool"]).toBe("Bash");
  });

  it("carries trace context onto every record once adopted", () => {
    const { logger, seen } = capture();
    const traced = logger.withTrace("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    traced.info("a.b", "body");
    expect(seen[0]?.TraceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(seen[0]?.SpanId).toBe("00f067aa0ba902b7");
  });

  it("emits an untraced record rather than refusing, when the header is junk", () => {
    const { logger, seen } = capture();
    logger.withTrace("nonsense").info("a.b", "body");
    expect(seen[0]?.TraceId).toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  it("a junk madeit.trace_id attribute yields an untraced record that still validates", () => {
    const { logger, seen } = capture();
    logger.info("a.b", "body", { "madeit.trace_id": "junk" });
    expect(seen[0]?.TraceId).toBeUndefined();
    expect(validate(seen[0]), JSON.stringify(validate.errors)).toBe(true);
  });

  it("a caller attribute cannot override the trace withTrace set", () => {
    const { logger, seen } = capture();
    const traced = logger.withTrace("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    traced.info("a.b", "body", {
      "madeit.trace_id": "deadbeefdeadbeefdeadbeefdeadbeef",
      "madeit.span_id": "deadbeefdeadbeef",
    });
    expect(seen[0]?.TraceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(seen[0]?.SpanId).toBe("00f067aa0ba902b7");
  });

  it("a second withTrace replaces the first rather than layering onto it", () => {
    const { logger, seen } = capture();
    logger.withTrace("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
      .withTrace("nonsense")
      .info("a.b", "body");
    expect(seen[0]?.TraceId).toBeUndefined();
    expect(seen[0]?.SpanId).toBeUndefined();
  });

  it("the meta path turns a sink failure logtape reports into a conforming record", () => {
    const { seen } = capture();
    getLogtapeLogger(["logtape", "meta"]).fatal(
      "Failed to emit a log record to sink {sink}: {error}",
      { sink: () => {}, error: new Error("boom"), record: { category: ["x"], nested: { deep: true } } },
    );
    expect(seen).toHaveLength(1);
    expect(validate(seen[0]), JSON.stringify(validate.errors)).toBe(true);
    expect(seen[0]?.Attributes["madeit.event"]).toBe("log.meta");
    expect(seen[0]?.Attributes["madeit.error"]).toBe("boom");
    expect(Object.keys(seen[0]?.Attributes ?? {}).sort()).toEqual(["madeit.error", "madeit.event"]);
  });

  it("a throwing sink is disabled, not retried through logtape's own meta logger", () => {
    // logtape retries a sink that throws on every later record. Our fanOut sits
    // between logtape and the caller's sinks precisely to swallow that retry.
    let calls = 0;
    const logger = getLogger({
      service: "hookd", version: "abc1234", environment: "test",
      repo: "agent-utilities", component: "daemon",
      sinks: [() => { calls += 1; throw new Error("sink is down"); }],
    });
    expect(() => {
      logger.info("a.b", "one");
      logger.info("a.b", "two");
    }).not.toThrow();
    expect(calls).toBe(1);
  });
});
