import {
  configureSync,
  getLogger as getLogtapeLogger,
  type LogLevel,
  type Logger as LogtapeLogger,
  type LogRecord as LogtapeRecord,
  type Sink as LogtapeSink,
} from "@logtape/logtape";
import { buildRecord, type LogRecord, type Resource, type Severity } from "./record.ts";
import { redact } from "./redact.ts";
import { fanOut, type Sink } from "./sink.ts";
import { parseTraceparent } from "./trace.ts";

export { fileSink, stdoutSink, type Sink } from "./sink.ts";
export { mintTraceparent, TRACEPARENT_ENV } from "./trace.ts";
export type { LogRecord, Resource, Severity } from "./record.ts";

export interface LoggerOptions {
  readonly service: string;
  readonly version: string;
  readonly environment: string;
  readonly repo: string;
  readonly component: string;
  readonly sinks: readonly Sink[];
}

export interface Logger {
  debug(event: string, body: string, attributes?: Record<string, unknown>): void;
  info(event: string, body: string, attributes?: Record<string, unknown>): void;
  warn(event: string, body: string, attributes?: Record<string, unknown>): void;
  error(event: string, body: string, attributes?: Record<string, unknown>): void;
  /** A logger whose records all carry this trace. Junk yields untraced records. */
  withTrace(traceparent: string | undefined): Logger;
}

// logtape's own level names, mapped onto the four we expose.
const SEVERITY_BY_LEVEL: Record<LogLevel, Severity> = {
  trace: "DEBUG",
  debug: "DEBUG",
  info: "INFO",
  warning: "WARN",
  error: "ERROR",
  fatal: "ERROR",
};

const LIFTED_PROPERTY_KEYS = ["madeit.event", "madeit.trace_id", "madeit.span_id"];

// One leaf category per getLogger() call, so two loggers minted for the same
// service and component never share sinks. configureSync is process-global,
// so every call rebuilds the whole config from this registry.
const registry = new Map<string, { category: string[]; adapter: LogtapeSink }>();
let nextId = 0;

export function getLogger(opts: LoggerOptions): Logger {
  const resource: Resource = {
    "service.name": opts.service,
    "service.version": opts.version,
    "deployment.environment": opts.environment,
    "madeit.repo": opts.repo,
    "madeit.component": opts.component,
  };
  const write = fanOut(opts.sinks);
  const category = ["madeit", opts.service, opts.component, String(nextId++)];
  const key = category.join(".");
  registry.set(key, { category, adapter: adapt(resource, write) });
  reconfigure();
  return build(getLogtapeLogger(category));
}

function reconfigure(): void {
  const entries = [...registry.entries()];
  configureSync({
    reset: true,
    sinks: Object.fromEntries(entries.map(([key, entry]) => [key, entry.adapter])),
    loggers: [
      ...entries.map(([key, entry]) => ({
        category: entry.category,
        sinks: [key],
        lowestLevel: "debug" as const,
      })),
      {
        category: ["logtape", "meta"],
        sinks: entries.map(([key]) => key),
        lowestLevel: "warning" as const,
      },
    ],
  });
}

/**
 * Bridges logtape's dispatch to our record shape. This function is what
 * logtape actually calls, and it never throws: `write` is `fanOut`, which
 * already swallows and disables a failing sink, so logtape's own
 * retry-on-throw behavior never engages for our sinks.
 */
function adapt(resource: Resource, write: Sink): LogtapeSink {
  return (entry: LogtapeRecord): void => {
    write(entry.category[0] === "logtape" ? metaRecord(resource, entry) : normalRecord(resource, entry));
  };
}

function stringProperty(properties: Record<string, unknown>, key: string): string | undefined {
  const value = properties[key];
  return typeof value === "string" ? value : undefined;
}

function withoutLiftedKeys(properties: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!LIFTED_PROPERTY_KEYS.includes(key)) out[key] = value;
  }
  return out;
}

function normalRecord(resource: Resource, entry: LogtapeRecord): LogRecord {
  const traceId = stringProperty(entry.properties, "madeit.trace_id");
  const spanId = stringProperty(entry.properties, "madeit.span_id");
  return buildRecord({
    resource,
    severity: SEVERITY_BY_LEVEL[entry.level],
    body: String(entry.rawMessage),
    event: stringProperty(entry.properties, "madeit.event") ?? "",
    attributes: withoutLiftedKeys(entry.properties),
    at: new Date(entry.timestamp),
    ...(traceId === undefined ? {} : { traceId }),
    ...(spanId === undefined ? {} : { spanId }),
  });
}

// logtape's meta payload carries the failed record and a function-valued
// sink, neither of which survives JSON, so only the error message crosses.
function metaRecord(resource: Resource, entry: LogtapeRecord): LogRecord {
  const error = entry.properties["error"];
  return buildRecord({
    resource,
    severity: SEVERITY_BY_LEVEL[entry.level],
    body: String(entry.rawMessage),
    event: "log.meta",
    attributes: { "madeit.error": error instanceof Error ? error.message : String(error ?? "") },
    at: new Date(entry.timestamp),
  });
}

function build(logtapeLogger: LogtapeLogger): Logger {
  const emit = (level: "debug" | "info" | "warn" | "error") =>
    (event: string, body: string, attributes: Record<string, unknown> = {}): void => {
      logtapeLogger[level](body, { ...redact(attributes), "madeit.event": event });
    };
  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    withTrace: (traceparent) => {
      const parsed = parseTraceparent(traceparent);
      return build(
        parsed === null
          ? logtapeLogger
          : logtapeLogger.with({ "madeit.trace_id": parsed.traceId, "madeit.span_id": parsed.spanId }),
      );
    },
  };
}
