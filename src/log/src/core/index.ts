import {
  ConfigError,
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

interface Trace {
  readonly traceId: string;
  readonly spanId: string;
}

/** What a Logger method hands to whichever transport carries it to the sinks. */
interface Emission {
  readonly severity: Severity;
  readonly event: string;
  readonly body: string;
  readonly attributes: Record<string, unknown>;
  readonly trace: Trace | undefined;
}

type Transport = (emission: Emission) => void;

const SEVERITY_BY_LEVEL: Record<LogLevel, Severity> = {
  trace: "DEBUG",
  debug: "DEBUG",
  info: "INFO",
  warning: "WARN",
  error: "ERROR",
  fatal: "ERROR",
};

const LEVEL_BY_SEVERITY: Record<Severity, "debug" | "info" | "warn" | "error"> = {
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
};

const LIFTED_PROPERTY_KEYS = ["madeit.event", "madeit.trace_id", "madeit.span_id"];
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
/** The schema's rule for `madeit.event`, checked here so a bad slug is coerced before it reaches a sink. */
const EVENT_PATTERN = /^[a-z][a-z0-9.-]*$/;

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
  try {
    reconfigure();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    // Someone else owns logtape's global config, and a logger that throws at
    // construction over that would take its host process down with it.
    registry.delete(key);
    write(buildRecord({
      resource, severity: "ERROR", event: "log.meta",
      body: "logtape refused configuration; this logger bypasses it",
      attributes: { "madeit.error": error.message },
    }));
    return build(direct(resource, write));
  }
  return build(throughLogtape(getLogtapeLogger(category)));
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

// Only our own transport puts these keys in properties, but logtape's side is
// still an open surface, so only a value shaped like the real thing is lifted.
function matching(value: string | undefined, pattern: RegExp): string | undefined {
  return value !== undefined && pattern.test(value) ? value : undefined;
}

function withoutLiftedKeys(properties: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!LIFTED_PROPERTY_KEYS.includes(key)) out[key] = value;
  }
  return out;
}

function normalRecord(resource: Resource, entry: LogtapeRecord): LogRecord {
  const traceId = matching(stringProperty(entry.properties, "madeit.trace_id"), TRACE_ID_PATTERN);
  const spanId = matching(stringProperty(entry.properties, "madeit.span_id"), SPAN_ID_PATTERN);
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

/**
 * The trace rides in each call's properties rather than through logtape's
 * `with()`, because `with()` lets a call-time property override the bound
 * context, and the logger's own trace must always win.
 */
function throughLogtape(logtapeLogger: LogtapeLogger): Transport {
  return ({ severity, event, body, attributes, trace }) => {
    const properties: Record<string, unknown> = { ...attributes, "madeit.event": event };
    if (trace !== undefined) {
      properties["madeit.trace_id"] = trace.traceId;
      properties["madeit.span_id"] = trace.spanId;
    }
    logtapeLogger[LEVEL_BY_SEVERITY[severity]](body, properties);
  };
}

function direct(resource: Resource, write: Sink): Transport {
  return ({ severity, event, body, attributes, trace }) => {
    write(buildRecord({
      resource, severity, body, event, attributes,
      ...(trace === undefined ? {} : { traceId: trace.traceId, spanId: trace.spanId }),
    }));
  };
}

interface Coerced {
  readonly event: string;
  readonly body: string;
  readonly marks: Record<string, unknown>;
}

/**
 * A logger that throws breaks its caller. A marked record keeps the defect
 * queryable instead.
 */
function coerceEmittable(event: string, body: string): Coerced {
  const marks: Record<string, unknown> = {};
  // A loose caller can hand either field anything at runtime despite the
  // string types, so both checks confirm the type before testing shape.
  const validEvent = typeof event === "string" && EVENT_PATTERN.test(event);
  if (!validEvent) marks["madeit.invalid_event"] = event;
  const coercedEvent = validEvent ? event : "invalid";
  const validBody = typeof body === "string" && body.length > 0;
  if (!validBody) marks["madeit.invalid_body"] = true;
  return { event: coercedEvent, body: validBody ? body : coercedEvent, marks };
}

function build(transport: Transport, trace?: Trace): Logger {
  const emit = (severity: Severity) =>
    (event: string, body: string, attributes: Record<string, unknown> = {}): void => {
      const coerced = coerceEmittable(event, body);
      // A trace comes from withTrace or not at all; an attribute never supplies one.
      // The marks are appended after redaction so a caller cannot shadow them.
      const cleanAttributes = { ...withoutLiftedKeys(redact(attributes)), ...coerced.marks };
      transport({ severity, event: coerced.event, body: coerced.body, attributes: cleanAttributes, trace });
    };
  return {
    debug: emit("DEBUG"),
    info: emit("INFO"),
    warn: emit("WARN"),
    error: emit("ERROR"),
    // Always derives from the same transport and a freshly parsed trace, so a
    // second withTrace() replaces the first rather than layering onto it.
    withTrace: (traceparent) => build(transport, parseTraceparent(traceparent) ?? undefined),
  };
}
