import {
  LOG_LEVEL_ORDER,
  type LogLevel,
  type ObservabilityRecord,
  type ObservabilitySink,
} from "./records.js";

export interface Span {
  end(fields?: Record<string, unknown>): void;
}

export interface Logger {
  trace(event: string, fields?: Record<string, unknown>): void;
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface Metrics {
  count(name: string, value?: number, fields?: Record<string, unknown>): void;
  timing(name: string, milliseconds: number, fields?: Record<string, unknown>): void;
  startSpan(name: string, fields?: Record<string, unknown>): Span;
}

export interface Observer {
  logger: Logger;
  metrics: Metrics;
}

export interface CreateObserverOptions {
  sink: ObservabilitySink;
  minLevel?: LogLevel;
  now?: () => number;
}

export function createObserver(options: CreateObserverOptions): Observer {
  const minLevel = options.minLevel ?? "info";
  const now = options.now ?? (() => Date.now());
  const threshold = LOG_LEVEL_ORDER[minLevel];

  const emit = (record: ObservabilityRecord): void => {
    options.sink.record(record);
  };

  const log = (level: LogLevel, event: string, fields?: Record<string, unknown>): void => {
    if (LOG_LEVEL_ORDER[level] < threshold) {
      return;
    }
    emit(fields === undefined
      ? { kind: "log", ts: now(), level, event }
      : { kind: "log", ts: now(), level, event, fields });
  };

  const metric = (
    kind: "count" | "timing",
    name: string,
    value: number,
    fields?: Record<string, unknown>
  ): void => {
    emit(fields === undefined
      ? { kind: "metric", ts: now(), metric: kind, name, value }
      : { kind: "metric", ts: now(), metric: kind, name, value, fields });
  };

  return {
    logger: {
      trace: (event, fields) => log("trace", event, fields),
      debug: (event, fields) => log("debug", event, fields),
      info: (event, fields) => log("info", event, fields),
      warn: (event, fields) => log("warn", event, fields),
      error: (event, fields) => log("error", event, fields),
    },
    metrics: {
      count: (name, value = 1, fields) => metric("count", name, value, fields),
      timing: (name, milliseconds, fields) => metric("timing", name, milliseconds, fields),
      startSpan: (name, startFields) => {
        const startedAt = now();
        return {
          end: (endFields) => {
            const merged = { ...startFields, ...endFields };
            metric(
              "timing",
              name,
              now() - startedAt,
              Object.keys(merged).length > 0 ? merged : undefined
            );
          },
        };
      },
    },
  };
}

export function fanoutSink(sinks: ObservabilitySink[]): ObservabilitySink {
  return {
    record(record) {
      for (const sink of sinks) {
        try {
          sink.record(record);
        } catch {
          // A failing sink must never break producers or other sinks.
        }
      }
    },
  };
}

export function createNoopObserver(): Observer {
  return createObserver({ sink: { record: () => {} }, minLevel: "error" });
}
