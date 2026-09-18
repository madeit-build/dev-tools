/** OpenTelemetry's canonical numbers. A collector reading these expects them. */
const SEVERITY_NUMBER = { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 } as const;

export type Severity = keyof typeof SEVERITY_NUMBER;

export interface Resource {
  readonly "service.name": string;
  readonly "service.version": string;
  readonly "deployment.environment": string;
  readonly "madeit.repo": string;
  readonly "madeit.component": string;
}

export interface LogRecord {
  readonly Timestamp: string;
  readonly SeverityNumber: number;
  readonly SeverityText: Severity;
  readonly Body: string;
  readonly TraceId?: string;
  readonly SpanId?: string;
  readonly Resource: Resource;
  readonly Attributes: Record<string, unknown>;
}

export interface RecordOptions {
  readonly resource: Resource;
  readonly severity: Severity;
  /** Fixed per event. Interpolated data belongs in attributes, never here. */
  readonly body: string;
  readonly event: string;
  readonly attributes?: Record<string, unknown>;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly at?: Date;
}

export function buildRecord(opts: RecordOptions): LogRecord {
  return {
    Timestamp: (opts.at ?? new Date()).toISOString(),
    SeverityNumber: SEVERITY_NUMBER[opts.severity],
    SeverityText: opts.severity,
    Body: opts.body,
    ...(opts.traceId === undefined ? {} : { TraceId: opts.traceId }),
    ...(opts.spanId === undefined ? {} : { SpanId: opts.spanId }),
    Resource: opts.resource,
    Attributes: { ...opts.attributes, "madeit.event": opts.event },
  };
}
