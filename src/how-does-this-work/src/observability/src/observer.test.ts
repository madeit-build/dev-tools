import { describe, expect, test } from "vitest";
import type { ObservabilityRecord, ObservabilitySink } from "./records.js";
import { createNoopObserver, createObserver, fanoutSink } from "./observer.js";

function capturing(): {
  sink: ObservabilitySink;
  records: ObservabilityRecord[];
} {
  const records: ObservabilityRecord[] = [];
  return { sink: { record: (r) => records.push(r) }, records };
}

describe("createObserver", () => {
  test("emits log records with a fixed clock", () => {
    const { sink, records } = capturing();
    const observer = createObserver({ sink, now: () => 1000 });
    observer.logger.info("generate.start", { topic: "x" });
    expect(records).toEqual([
      {
        kind: "log",
        ts: 1000,
        level: "info",
        event: "generate.start",
        fields: { topic: "x" },
      },
    ]);
  });

  test("filters records below minLevel", () => {
    const { sink, records } = capturing();
    const observer = createObserver({ sink, minLevel: "warn", now: () => 0 });
    observer.logger.debug("noisy");
    observer.logger.error("boom");
    expect(records.map((r) => r.kind === "log" && r.event)).toEqual(["boom"]);
  });

  test("count and timing emit metric records", () => {
    const { sink, records } = capturing();
    const observer = createObserver({ sink, now: () => 5 });
    observer.metrics.count("verify.drift", 2);
    observer.metrics.timing("generate.duration_ms", 1800);
    expect(records).toEqual([
      {
        kind: "metric",
        ts: 5,
        metric: "count",
        name: "verify.drift",
        value: 2,
      },
      {
        kind: "metric",
        ts: 5,
        metric: "timing",
        name: "generate.duration_ms",
        value: 1800,
      },
    ]);
  });

  test("count defaults value to 1", () => {
    const { sink, records } = capturing();
    const observer = createObserver({ sink, now: () => 0 });
    observer.metrics.count("repair.round");
    expect(records[0]).toMatchObject({
      metric: "count",
      name: "repair.round",
      value: 1,
    });
  });

  test("startSpan emits a timing metric on end using elapsed time", () => {
    const { sink, records } = capturing();
    let clock = 100;
    const observer = createObserver({ sink, now: () => clock });
    const span = observer.metrics.startSpan("agent.explore", { topic: "x" });
    clock = 350;
    span.end({ steps: 5 });
    expect(records).toEqual([
      {
        kind: "metric",
        ts: 350,
        metric: "timing",
        name: "agent.explore",
        value: 250,
        fields: { topic: "x", steps: 5 },
      },
    ]);
  });
});

describe("fanoutSink", () => {
  test("delivers each record to every sink", () => {
    const a = capturing();
    const b = capturing();
    const fan = fanoutSink([a.sink, b.sink]);
    const observer = createObserver({ sink: fan, now: () => 0 });
    observer.logger.info("hi");
    expect(a.records).toHaveLength(1);
    expect(b.records).toHaveLength(1);
  });

  test("one throwing sink does not stop the others", () => {
    const good = capturing();
    const bad: ObservabilitySink = {
      record() {
        throw new Error("sink failure");
      },
    };
    const fan = fanoutSink([bad, good.sink]);
    expect(() =>
      fan.record({ kind: "log", ts: 0, level: "info", event: "x" }),
    ).not.toThrow();
    expect(good.records).toHaveLength(1);
  });
});

describe("createNoopObserver", () => {
  test("is inert and span.end does not throw", () => {
    const observer = createNoopObserver();
    expect(() => {
      observer.logger.error("ignored");
      observer.metrics.count("ignored");
      observer.metrics.startSpan("ignored").end();
    }).not.toThrow();
  });
});
