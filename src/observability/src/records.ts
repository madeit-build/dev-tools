export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

/** Numeric ordering for level filtering; higher = more severe. */
export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export interface LogRecord {
  kind: "log";
  ts: number;
  level: LogLevel;
  event: string;
  fields?: Record<string, unknown>;
}

export type MetricKind = "count" | "timing";

export interface MetricRecord {
  kind: "metric";
  ts: number;
  metric: MetricKind;
  name: string;
  value: number;
  fields?: Record<string, unknown>;
}

export type ObservabilityRecord = LogRecord | MetricRecord;

export interface ObservabilitySink {
  record(record: ObservabilityRecord): void;
}
