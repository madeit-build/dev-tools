import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fanOut, fileSink } from "./sink.ts";
import { buildRecord } from "./record.ts";

const resource = {
  "service.name": "t", "service.version": "1", "deployment.environment": "test",
  "madeit.repo": "dev-tools", "madeit.component": "log",
};
const record = () => buildRecord({ resource, severity: "INFO", body: "b", event: "e" });
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sink-")), "out.jsonl");

describe("sinks", () => {
  it("writes one JSON line per record", () => {
    const p = tmp();
    fileSink(p)(record());
    const lines = fs.readFileSync(p, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).Body).toBe("b");
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

  it("reports the death through the surviving sinks, once", () => {
    const events: unknown[] = [];
    const boom = () => { throw new Error("disk gone"); };
    const good = (r: { Attributes: Record<string, unknown> }) => {
      events.push(r.Attributes["madeit.event"]);
    };
    const sink = fanOut([boom, good]);
    sink(record()); sink(record());
    expect(events.filter((e) => e === "sink.disabled")).toHaveLength(1);
  });

  it("becomes a no-op when every sink has died", () => {
    const first = () => { throw new Error("x"); };
    const second = () => { throw new Error("y"); };
    const sink = fanOut([first, second]);
    sink(record());
    expect(() => sink(record())).not.toThrow();
  });
});
