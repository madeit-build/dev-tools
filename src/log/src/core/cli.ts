import { fileSink, getLogger, stderrSink, stdoutSink, type Logger, type Sink } from "./index.ts";

export interface CliIo {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: { write(chunk: string | Uint8Array): unknown };
}

const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

const USAGE = "madeit-log <debug|info|warn|error> <event> <body> [key=value ...]";

const HELP = `madeit-log: emit one madeit-log-v1 record from bash

Usage:
  ${USAGE}
  madeit-log pipe <event> [--level debug|info|warn|error] [--stream stdout|stderr] [--tee]
  madeit-log --help

Resource environment variables (each falls back to "unknown" when unset):
  MADEIT_SERVICE, MADEIT_VERSION, MADEIT_ENVIRONMENT, MADEIT_REPO, MADEIT_COMPONENT

Trace:
  TRACEPARENT, if set, becomes the record's TraceId and SpanId.

Sink:
  MADEIT_LOG_SINK=stderr|stdout|file:<path>, default stderr.

Security:
  pipe logs line content verbatim, and key-based redaction does not inspect
  values: never pipe a command whose output can carry credentials.
`;

interface ResourceFields {
  readonly "service.name": string;
  readonly "service.version": string;
  readonly "deployment.environment": string;
  readonly "madeit.repo": string;
  readonly "madeit.component": string;
}

interface ResourceResult {
  readonly fields: ResourceFields;
  readonly missing: readonly string[];
}

// The env var and resource key are paired here so the five-variable list has
// exactly one source of truth in the code.
const RESOURCE_KEYS = [
  ["MADEIT_SERVICE", "service.name"],
  ["MADEIT_VERSION", "service.version"],
  ["MADEIT_ENVIRONMENT", "deployment.environment"],
  ["MADEIT_REPO", "madeit.repo"],
  ["MADEIT_COMPONENT", "madeit.component"],
] as const satisfies ReadonlyArray<readonly [string, keyof ResourceFields]>;

// The schema requires a non-empty string, so a variable set to nothing or to
// only whitespace is exactly as missing as one that was never set.
function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

function buildResource(env: Record<string, string | undefined>): ResourceResult {
  const missing: string[] = [];
  const fields = {} as Record<keyof ResourceFields, string>;
  for (const [envVar, resourceKey] of RESOURCE_KEYS) {
    const value = env[envVar];
    if (isBlank(value)) missing.push(envVar);
    fields[resourceKey] = isBlank(value) ? "unknown" : (value as string);
  }
  return { fields, missing };
}

interface SinkChoice {
  readonly sink: Sink;
  readonly extraAttributes: Record<string, unknown>;
}

// A file or stdout sink can fail only when it actually writes, and fanOut has
// nowhere left to route that death's own notice once it is the only sink.
// Rerouting the record itself to stderr, plus one diagnostic line, is what
// keeps it from vanishing.
function withStderrFallback(sink: Sink): Sink {
  const fallback = stderrSink();
  return (record) => {
    try {
      sink(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`madeit-log: ${message}\n`);
      fallback(record);
    }
  };
}

function chooseSink(env: Record<string, string | undefined>): SinkChoice {
  const raw = env.MADEIT_LOG_SINK;
  if (raw === undefined || raw === "stderr") return { sink: stderrSink(), extraAttributes: {} };
  if (raw === "stdout") return { sink: withStderrFallback(stdoutSink()), extraAttributes: {} };
  if (raw.startsWith("file:")) {
    const filePath = raw.slice("file:".length);
    if (filePath !== "") return { sink: withStderrFallback(fileSink(filePath)), extraAttributes: {} };
  }
  // An unrecognized sink, including a file: value with no path, must not
  // swallow the caller's record, so it still ships, to the safe default, with
  // the bad value visible on the record itself.
  return { sink: stderrSink(), extraAttributes: { "madeit.invalid_sink": raw } };
}

function isLevel(value: string | undefined): value is Level {
  return value !== undefined && (LEVELS as readonly string[]).includes(value);
}

const INTEGER_LITERAL = /^-?\d+$/;

// JSON typing for `key=value`: a boolean or null keeps that type. A number
// keeps its type only when finite and, if it is a bare integer literal, small
// enough for Number.isSafeInteger; anything else, including a JSON parse
// failure, stays the raw string.
function coerceValue(raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (typeof parsed === "boolean" || parsed === null) return parsed;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return raw;
  if (INTEGER_LITERAL.test(raw) && !Number.isSafeInteger(parsed)) return raw;
  return parsed;
}

// A key the CLI reserves for its own marks can never become a caller
// attribute, so a forged one is folded into madeit.invalid_attribute exactly
// like an empty key or a bare argument, rather than overwriting the real mark.
const RESERVED_ATTRIBUTE_KEYS = new Set([
  "madeit.invalid_attribute",
  "madeit.invalid_sink",
  "madeit.missing_resource",
]);

function parseAttributes(args: readonly string[]): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  const invalid: string[] = [];
  for (const arg of args) {
    const separator = arg.indexOf("=");
    const key = separator > 0 ? arg.slice(0, separator) : "";
    if (separator <= 0 || RESERVED_ATTRIBUTE_KEYS.has(key)) {
      invalid.push(arg);
      continue;
    }
    attributes[key] = coerceValue(arg.slice(separator + 1));
  }
  if (invalid.length > 0) attributes["madeit.invalid_attribute"] = invalid.join(" ");
  return attributes;
}

function describeMisuse(level: string | undefined, event: string | undefined, body: string | undefined): string {
  if (level === undefined) return `no command given. Usage: ${USAGE}`;
  if (!isLevel(level)) return `unknown level "${level}". Usage: ${USAGE}`;
  if (event === undefined) return `missing event for level "${level}". Usage: ${USAGE}`;
  if (body === undefined) return `missing body for event "${event}". Usage: ${USAGE}`;
  return `madeit-log was called incorrectly. Usage: ${USAGE}`;
}

function emitMisuse(logger: Logger, extraAttributes: Record<string, unknown>, reason: string): void {
  logger.error("log.meta", "madeit-log was called incorrectly", {
    ...extraAttributes,
    "madeit.error": reason,
  });
}

export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  try {
    if (argv[0] === "--help" || argv[0] === "-h") {
      io.stdout.write(HELP);
      return 0;
    }

    const { fields, missing } = buildResource(env);
    const sinkChoice = chooseSink(env);
    const logger = getLogger({
      service: fields["service.name"],
      version: fields["service.version"],
      environment: fields["deployment.environment"],
      repo: fields["madeit.repo"],
      component: fields["madeit.component"],
      sinks: [sinkChoice.sink],
    }).withTrace(env.TRACEPARENT);

    // A fresh object here, not a mutation of chooseSink's return value, keeps
    // chooseSink's result a pure description of the sink it picked.
    const markerAttributes: Record<string, unknown> = { ...sinkChoice.extraAttributes };
    if (missing.length > 0) markerAttributes["madeit.missing_resource"] = missing.join(",");

    const [level, event, body, ...rest] = argv;
    if (!isLevel(level) || event === undefined || body === undefined) {
      emitMisuse(logger, markerAttributes, describeMisuse(level, event, body));
      return 0;
    }

    const attributes = { ...parseAttributes(rest), ...markerAttributes };
    logger[level](event, body, attributes);
    return 0;
  } catch (error) {
    // Whatever survives everything above lands here: a sink whose directory
    // cannot be created, or any other unexpected failure. Either way the
    // caller still sees exit 0, not a crashed shell.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`madeit-log: ${message}\n`);
    return 0;
  }
}
