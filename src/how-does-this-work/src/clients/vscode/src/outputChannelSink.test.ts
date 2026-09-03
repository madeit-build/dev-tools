import { describe, expect, test } from "vitest";
import type * as vscode from "vscode";
import { OutputChannelSink } from "./outputChannelSink.js";

interface Call {
  method: string;
  line: string;
}

function fakeChannel(): { calls: Call[]; channel: vscode.LogOutputChannel } {
  const calls: Call[] = [];
  const make = (method: string) => (line: string) =>
    calls.push({ method, line });
  const channel = {
    trace: make("trace"),
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
    appendLine: make("appendLine"),
  } as unknown as vscode.LogOutputChannel;
  return { calls, channel };
}

describe("OutputChannelSink", () => {
  test("routes each log level to the matching channel method", () => {
    const { calls, channel } = fakeChannel();
    const sink = new OutputChannelSink(channel);
    for (const level of ["trace", "debug", "info", "warn", "error"] as const) {
      sink.record({ kind: "log", ts: 0, level, event: `e.${level}` });
    }
    expect(calls).toEqual([
      { method: "trace", line: "e.trace" },
      { method: "debug", line: "e.debug" },
      { method: "info", line: "e.info" },
      { method: "warn", line: "e.warn" },
      { method: "error", line: "e.error" },
    ]);
  });

  test("renders fields as appended JSON", () => {
    const { calls, channel } = fakeChannel();
    new OutputChannelSink(channel).record({
      kind: "log",
      ts: 0,
      level: "info",
      event: "verify.step",
      fields: { ok: true, file: "a.ts" },
    });
    expect(calls[0]).toEqual({
      method: "info",
      line: 'verify.step {"ok":true,"file":"a.ts"}',
    });
  });

  test("routes metric records to debug", () => {
    const { calls, channel } = fakeChannel();
    new OutputChannelSink(channel).record({
      kind: "metric",
      ts: 0,
      metric: "count",
      name: "verify.drift",
      value: 2,
    });
    expect(calls[0]).toEqual({
      method: "debug",
      line: "metric verify.drift=2",
    });
  });

  test("appendRaw goes to appendLine", () => {
    const { calls, channel } = fakeChannel();
    new OutputChannelSink(channel).appendRaw("[engine] boom");
    expect(calls[0]).toEqual({ method: "appendLine", line: "[engine] boom" });
  });
});
