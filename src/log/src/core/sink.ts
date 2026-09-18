import fs from "node:fs";
import path from "node:path";
import { buildRecord, type LogRecord } from "./record.ts";

export type Sink = (record: LogRecord) => void;

export function stdoutSink(): Sink {
  return (record) => { process.stdout.write(JSON.stringify(record) + "\n"); };
}

export function fileSink(filePath: string): Sink {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return (record) => { fs.appendFileSync(filePath, JSON.stringify(record) + "\n"); };
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
      try {
        sink(record);
      } catch (error) {
        live.delete(sink);
        announce(live, record.Resource, error);
        break;
      }
    }
  };
}

function announce(live: Set<Sink>, resource: LogRecord["Resource"], error: unknown): void {
  const notice = buildRecord({
    resource, severity: "ERROR", body: "a sink failed and was disabled",
    event: "sink.disabled",
    attributes: { "madeit.error": error instanceof Error ? error.message : String(error) },
  });
  for (const sink of [...live]) {
    try {
      sink(notice);
    } catch {
      // A sink that dies reporting a death is simply gone too.
      live.delete(sink);
    }
  }
}
