import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fanOut, fileSink } from "./sink.ts";
import { buildRecord, type LogRecord } from "./record.ts";

const resource = {
  "service.name": "t", "service.version": "1", "deployment.environment": "test",
  "madeit.repo": "dev-tools", "madeit.component": "log",
};
const record = (attributes: Record<string, unknown> = {}) =>
  buildRecord({ resource, severity: "INFO", body: "b", event: "e", attributes });
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sink-")), "out.jsonl");
const lines = (p: string) => fs.readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("sinks", () => {
  it("writes one JSON line per record", () => {
    const p = tmp();
    fileSink(p)(record());
    expect(lines(p)).toHaveLength(1);
    expect(lines(p)[0].Body).toBe("b");
  });

  it("serializes a bigint attribute rather than dying on it", () => {
    const p = tmp();
    const sink = fileSink(p);
    sink(record({ n: 10n }));
    sink(record());
    expect(lines(p)).toHaveLength(2);
    expect(lines(p)[0].Attributes.n).toBe("10");
  });

  it("replaces a record it cannot serialize and keeps going", () => {
    // One cyclic attribute must not disable the whole sink for the process,
    // and the replacement must still say which event was lost.
    const p = tmp();
    const sink = fileSink(p);
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => sink(record({ cyclic }))).not.toThrow();
    sink(record());
    const [replaced, next] = lines(p);
    expect(replaced.Attributes["madeit.event"]).toBe("log.unserializable");
    expect(replaced.Attributes["madeit.original_event"]).toBe("e");
    expect(replaced.Attributes["madeit.error"]).toMatch(/circular/i);
    expect(replaced.Body).toBe("record could not be serialized");
    expect(replaced.SeverityText).toBe("INFO");
    expect(replaced.Resource).toEqual(resource);
    expect(next.Body).toBe("b");
  });

  it("A THROWING SINK NEVER REACHES THE CALLER", () => {
    // The whole rule: a hook must never break a tool call, so neither may the
    // thing watching it.
    const boom = () => { throw new Error("disk gone"); };
    expect(() => fanOut([boom])(record())).not.toThrow();
  });

  it("disables a throwing sink instead of retrying it every record", () => {
    let calls = 0;
    const boom = () => { calls += 1; throw new Error("disk gone"); };
    const sink = fanOut([boom]);
    sink(record()); sink(record()); sink(record());
    expect(calls).toBe(1);
  });

  it("keeps the healthy sinks when one dies, and loses none of their records", () => {
    const seen: string[] = [];
    const boom = () => { throw new Error("x"); };
    const good = (r: { Body: string }) => { seen.push(r.Body); };
    const sink = fanOut([boom, good]);
    sink(record()); sink(record());
    // Both caller records reach the survivor, and the death notice arrives once.
    expect(seen.filter((body) => body === "b")).toHaveLength(2);
    expect(seen.filter((body) => body === "a sink failed and was disabled")).toHaveLength(1);
  });

  it("reports each death through the surviving sinks, once per death", () => {
    const events: unknown[] = [];
    const first = () => { throw new Error("disk gone"); };
    const second = () => { throw new Error("stream closed"); };
    const good = (r: { Attributes: Record<string, unknown> }) => {
      events.push(r.Attributes["madeit.event"]);
    };
    const sink = fanOut([first, second, good]);
    sink(record());
    expect(events.filter((e) => e === "sink.disabled")).toHaveLength(2);
    expect(events.filter((e) => e === "e")).toHaveLength(1);
  });

  it("never calls a sink twice for one record once it has been disabled", () => {
    // A survivor that dies receiving a death notice is gone before the outer
    // loop reaches it, so it must not see the caller's record afterward.
    let lateCalls = 0;
    const first = () => { throw new Error("x"); };
    const fragile = (r: LogRecord) => {
      if (r.Attributes["madeit.event"] === "sink.disabled") throw new Error("y");
      lateCalls += 1;
    };
    fanOut([first, fragile])(record());
    expect(lateCalls).toBe(0);
  });

  it("disables a rejecting async sink like a throwing one, with no unhandled rejection", async () => {
    let unhandled: unknown;
    process.once("unhandledRejection", (reason) => { unhandled = reason; });
    const seen: unknown[] = [];
    const rejecting = async () => { throw new Error("x"); };
    const good = (r: LogRecord) => { seen.push(r.Attributes["madeit.event"]); };
    const sink = fanOut([rejecting, good]);
    expect(() => sink(record())).not.toThrow();
    await settle();
    expect(unhandled).toBeUndefined();
    expect(seen).toEqual(["e", "sink.disabled"]);
    sink(record());
    await settle();
    expect(seen).toEqual(["e", "sink.disabled", "e"]);
  });

  it("disables an async sink that rejects on a death notice, with no unhandled rejection", async () => {
    // The notice path is the one place a rejection could still escape, and an
    // escaped rejection is the process-killing case the promise guard exists for.
    let unhandled: unknown;
    process.once("unhandledRejection", (reason) => { unhandled = reason; });
    let firstCalls = 0;
    let secondCalls = 0;
    const first = async () => { firstCalls += 1; throw new Error("x"); };
    const second = async () => { secondCalls += 1; throw new Error("y"); };
    const sink = fanOut([first, second]);
    sink(record());
    await settle();
    expect(unhandled).toBeUndefined();
    sink(record());
    await settle();
    expect(unhandled).toBeUndefined();
    expect([firstCalls, secondCalls]).toEqual([1, 2]);
  });

  it("names the error's type when its message cannot be read", () => {
    const seen: unknown[] = [];
    const boom = () => {
      throw new (class Mute extends Error {
        override toString(): string { throw new Error("no"); }
        override get message(): string { throw new Error("no"); }
      })();
    };
    const good = (r: LogRecord) => {
      if (r.Attributes["madeit.event"] === "sink.disabled") seen.push(r.Attributes["madeit.error"]);
    };
    expect(() => fanOut([boom, good])(record())).not.toThrow();
    expect(seen).toEqual(["Mute"]);
  });

  it("becomes a no-op when every sink has died", () => {
    const first = () => { throw new Error("x"); };
    const second = () => { throw new Error("y"); };
    const sink = fanOut([first, second]);
    sink(record());
    expect(() => sink(record())).not.toThrow();
  });
});
