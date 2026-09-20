import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import fs from "node:fs";
import { configure, getLogger as getLogtapeLogger, reset } from "@logtape/logtape";
import { getLogger } from "./index.ts";
import type { LogRecord } from "./record.ts";

const schema = JSON.parse(
  fs.readFileSync(new URL("../../schema/madeit-log-v1.json", import.meta.url), "utf8"),
);
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

  it("a well-formed madeit.trace_id attribute on an untraced logger is dropped, not adopted", () => {
    // A trace comes from withTrace or not at all. Letting an attribute supply
    // one would let any caller link records into a trace it never joined.
    const { logger, seen } = capture();
    logger.info("a.b", "body", {
      "madeit.trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
      "madeit.span_id": "00f067aa0ba902b7",
    });
    expect(seen[0]?.TraceId).toBeUndefined();
    expect(seen[0]?.SpanId).toBeUndefined();
    expect(seen[0]?.Attributes["madeit.trace_id"]).toBeUndefined();
    expect(seen[0]?.Attributes["madeit.span_id"]).toBeUndefined();
    expect(validate(seen[0]), JSON.stringify(validate.errors)).toBe(true);
  });

  it("coerces and marks an event slug the schema would reject, rather than throwing", () => {
    const { logger, seen } = capture();
    expect(() => logger.info("Route", "body")).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(validate(seen[0]), JSON.stringify(validate.errors)).toBe(true);
    expect(seen[0]?.Attributes["madeit.event"]).toBe("invalid");
    expect(seen[0]?.Attributes["madeit.invalid_event"]).toBe("Route");
    expect(seen[0]?.Body).toBe("body");
  });

  it("coerces and marks an empty body the schema would reject, rather than throwing", () => {
    const { logger, seen } = capture();
    expect(() => logger.info("a.b", "")).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(validate(seen[0]), JSON.stringify(validate.errors)).toBe(true);
    expect(seen[0]?.Attributes["madeit.event"]).toBe("a.b");
    expect(seen[0]?.Attributes["madeit.invalid_body"]).toBe(true);
    expect(seen[0]?.Body).toBe("a.b");
  });

  it("marks both defects at once, and the body falls back to the invalid event marker", () => {
    const { logger, seen } = capture();
    expect(() => logger.info("Route", "")).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(validate(seen[0]), JSON.stringify(validate.errors)).toBe(true);
    expect(seen[0]?.Attributes["madeit.event"]).toBe("invalid");
    expect(seen[0]?.Attributes["madeit.invalid_event"]).toBe("Route");
    expect(seen[0]?.Attributes["madeit.invalid_body"]).toBe(true);
    expect(seen[0]?.Body).toBe("invalid");
  });

  it("coerces and marks a non-string body a loose caller passed through the type, rather than throwing", () => {
    const { logger, seen } = capture();
    expect(() => logger.info("a.b", undefined as unknown as string)).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(validate(seen[0]), JSON.stringify(validate.errors)).toBe(true);
    expect(seen[0]?.Attributes["madeit.invalid_body"]).toBe(true);
    expect(seen[0]?.Body).toBe("a.b");
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

  it("bypasses logtape when it refuses configuration, and says so first", async () => {
    // configureSync refuses while an async-disposable sink from a prior
    // configure() is live. That is another library's process-global state, and
    // a logger that throws at construction over it would take the daemon down.
    const idle = Object.assign((_record: unknown): void => {}, {
      [Symbol.asyncDispose]: async (): Promise<void> => {},
    });
    await configure({
      reset: true,
      sinks: { idle },
      loggers: [
        { category: ["someone-else"], sinks: ["idle"] },
        { category: ["logtape", "meta"], sinks: ["idle"], lowestLevel: "error" },
      ],
    });
    try {
      const seen: LogRecord[] = [];
      let logger: ReturnType<typeof getLogger> | undefined;
      expect(() => {
        logger = getLogger({
          service: "hookd", version: "abc1234", environment: "test",
          repo: "agent-utilities", component: "daemon",
          sinks: [(r) => { seen.push(r); }],
        });
      }).not.toThrow();
      expect(seen).toHaveLength(1);
      expect(seen[0]?.Attributes["madeit.event"]).toBe("log.meta");
      expect(seen[0]?.SeverityText).toBe("ERROR");
      expect(seen[0]?.Body).toBe("logtape refused configuration; this logger bypasses it");
      expect(seen[0]?.Attributes["madeit.error"]).toMatch(/async disposables/);
      expect(validate(seen[0]), JSON.stringify(validate.errors)).toBe(true);

      logger?.info("a.b", "body", { "madeit.token": "sk-live", "madeit.tool": "Bash" });
      expect(seen).toHaveLength(2);
      expect(validate(seen[1]), JSON.stringify(validate.errors)).toBe(true);
      expect(seen[1]?.Attributes["madeit.tool"]).toBe("Bash");
      expect(seen[1]?.Attributes["madeit.token"]).toBeUndefined();

      logger?.withTrace("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01").warn("a.b", "w");
      expect(seen[2]?.TraceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
      expect(seen[2]?.SeverityText).toBe("WARN");
      expect(validate(seen[2]), JSON.stringify(validate.errors)).toBe(true);
    } finally {
      // resetSync leaves async disposables registered, which is the very state
      // that provokes the refusal, so only the async reset restores logtape.
      await reset();
    }
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
