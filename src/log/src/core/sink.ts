import fs from "node:fs";
import path from "node:path";
import { buildRecord, type LogRecord } from "./record.ts";

export type Sink = (record: LogRecord) => void;

export function stdoutSink(): Sink {
  return (record) => { process.stdout.write(serialize(record) + "\n"); };
}

export function fileSink(filePath: string): Sink {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return (record) => { fs.appendFileSync(filePath, serialize(record) + "\n"); };
}

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

// One attribute JSON cannot carry (a cycle) must cost one record, not the
// sink for the rest of the process, so the record is swapped for one that
// names what was lost.
function serialize(record: LogRecord): string {
  try {
    return JSON.stringify(record, replacer);
  } catch (error) {
    return JSON.stringify(buildRecord({
      resource: record.Resource,
      severity: record.SeverityText,
      body: "record could not be serialized",
      event: "log.unserializable",
      at: new Date(record.Timestamp),
      attributes: {
        "madeit.original_event": record.Attributes["madeit.event"],
        "madeit.error": safeMessage(error),
      },
    }), replacer);
  }
}

/**
 * Write to every sink, and survive any of them.
 *
 * A sink that throws is disabled rather than retried: the failure is almost
 * always permanent (an unwritable path, a closed stream), and retrying it on
 * every record turns one broken sink into a per-call exception handler on the
 * hot path.
 */
export function fanOut(sinks: readonly Sink[]): Sink {
  const live = new Set(sinks);
  return (record) => {
    for (const sink of [...live]) {
      // A death notice earlier in this same pass may already have killed it.
      if (!live.has(sink)) continue;
      deliver(live, sink, record);
    }
  };
}

// A rejection is a death that arrives late, and it must be caught here or it
// takes the process down, which is the one thing a logger may never do.
function deliver(live: Set<Sink>, sink: Sink, record: LogRecord): void {
  try {
    const result: unknown = sink(record);
    if (result instanceof Promise) {
      result.catch((error: unknown) => bury(live, sink, record.Resource, error));
    }
  } catch (error) {
    bury(live, sink, record.Resource, error);
  }
}

function bury(live: Set<Sink>, sink: Sink, resource: LogRecord["Resource"], error: unknown): void {
  live.delete(sink);
  announce(live, resource, error);
}

// A sink that dies reporting a death is gone too, and its own death is still
// news to whoever is left. Every death removes a sink, so this ends.
function announce(live: Set<Sink>, resource: LogRecord["Resource"], error: unknown): void {
  const notice = buildRecord({
    resource, severity: "ERROR", body: "a sink failed and was disabled",
    event: "sink.disabled",
    attributes: { "madeit.error": safeMessage(error) },
  });
  for (const sink of [...live]) {
    if (!live.has(sink)) continue;
    deliver(live, sink, notice);
  }
}

// An error whose message getter or toString throws would otherwise take the
// announcement down with it, and the type name is still worth reporting.
function safeMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return error instanceof Error ? error.constructor.name : typeof error;
  }
}
