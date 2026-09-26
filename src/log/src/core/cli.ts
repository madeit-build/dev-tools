#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { fileSink, getLogger, stderrSink, stdoutSink, type Logger, type Sink } from "./index.ts";

export interface CliIo {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: {
    write(chunk: string | Uint8Array): unknown;
    once?(event: string, listener: (...args: unknown[]) => void): unknown;
    off?(event: string, listener: (...args: unknown[]) => void): unknown;
  };
}

const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

const USAGE = "madeit-log <debug|info|warn|error> <event> <body> [key=value ...]";
const PIPE_USAGE =
  "madeit-log pipe <event> [--level debug|info|warn|error] [--stream stdout|stderr] [--tee]";

const HELP = `madeit-log: emit one madeit-log-v1 record from bash

Usage:
  ${USAGE}
  ${PIPE_USAGE}
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
      process.stderr.write(`madeit-log: ${errorMessage(error)}\n`);
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

type Stream = "stdout" | "stderr";

interface PipeOptions {
  readonly event: string;
  readonly level: Level;
  readonly stream: Stream;
  readonly tee: boolean;
}

type PipeParseResult =
  | { readonly ok: true; readonly options: PipeOptions }
  | { readonly ok: false; readonly reason: string };

function isStream(value: string | undefined): value is Stream {
  return value === "stdout" || value === "stderr";
}

// Flags come after the event and are parsed left to right; any of them missing
// its value, or an argument this loop does not recognize, is misuse and must
// be caught before stdin is ever touched.
function parsePipeArgs(args: readonly string[]): PipeParseResult {
  const [event, ...rest] = args;
  if (event === undefined) return { ok: false, reason: `missing event for pipe. Usage: ${PIPE_USAGE}` };

  let level: Level = "info";
  let stream: Stream = "stdout";
  let tee = false;
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === "--level") {
      const value = rest[++index];
      if (value === undefined) return { ok: false, reason: `missing value for --level. Usage: ${PIPE_USAGE}` };
      if (!isLevel(value)) return { ok: false, reason: `unknown --level "${value}". Usage: ${PIPE_USAGE}` };
      level = value;
    } else if (flag === "--stream") {
      const value = rest[++index];
      if (value === undefined) return { ok: false, reason: `missing value for --stream. Usage: ${PIPE_USAGE}` };
      if (!isStream(value)) return { ok: false, reason: `unknown --stream "${value}". Usage: ${PIPE_USAGE}` };
      stream = value;
    } else if (flag === "--tee") {
      tee = true;
    } else {
      return { ok: false, reason: `unknown argument "${flag}" for pipe. Usage: ${PIPE_USAGE}` };
    }
  }
  return { ok: true, options: { event, level, stream, tee } };
}

const MAX_LINE_BYTES = 16384;
// One byte beyond the cap is enough to tell, without retaining a whole huge
// line, whether its true length (after any trailing \r) is at or under
// MAX_LINE_BYTES.
const PENDING_CAP = MAX_LINE_BYTES + 1;
// The record's message, fixed per the core's contract: Body carries no
// interpolated data, so a piped line's content lives only in madeit.line.
const PIPE_LINE_BODY = "output line";

interface ProcessedLine {
  readonly text: string;
  readonly truncated: boolean;
  readonly lineBytes: number;
}

// Backs off up to three trailing UTF-8 continuation bytes (10xxxxxx), then
// drops the lead byte too if its full sequence would not fit before the cut,
// so a multi-byte character is never split into a trailing replacement char.
function utf8SafeBoundary(buffer: Buffer, cut: number): number {
  let index = cut;
  let continuationBytes = 0;
  while (index > 0 && continuationBytes < 3 && (buffer[index - 1]! & 0b11000000) === 0b10000000) {
    index--;
    continuationBytes++;
  }
  if (index === 0) return cut;
  const leadByte = buffer[index - 1]!;
  const sequenceLength =
    leadByte >= 0b11110000 ? 4 : leadByte >= 0b11100000 ? 3 : leadByte >= 0b11000000 ? 2 : 1;
  return index - 1 + sequenceLength <= cut ? cut : index - 1;
}

// Invalid UTF-8 decodes to U+FFFD, three bytes apiece, so a byte-for-byte
// truncation of the input can still produce a re-encoded string longer than
// MAX_LINE_BYTES. This trims whole characters off the end until it fits.
function capDecodedText(text: string): { readonly text: string; readonly wasCapped: boolean } {
  if (Buffer.byteLength(text, "utf8") <= MAX_LINE_BYTES) return { text, wasCapped: false };
  let kept = "";
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > MAX_LINE_BYTES) break;
    kept += character;
    bytes += characterBytes;
  }
  return { text: kept, wasCapped: true };
}

// madeit.line_bytes counts the raw segment between newlines, including a
// trailing \r when present. Stripping that \r and cutting to MAX_LINE_BYTES
// both happen afterward, to the logged text, so they never shrink this count.
function processLine(rawLine: Buffer): ProcessedLine {
  const lineBytes = rawLine.length;
  const hasTrailingCr = lineBytes > 0 && rawLine[lineBytes - 1] === 0x0d;
  const content = hasTrailingCr ? rawLine.subarray(0, lineBytes - 1) : rawLine;
  const byteTruncated = content.length > MAX_LINE_BYTES;
  const decoded = byteTruncated
    ? content.subarray(0, utf8SafeBoundary(content, MAX_LINE_BYTES)).toString("utf8")
    : content.toString("utf8");
  const capped = capDecodedText(decoded);
  return { text: capped.text, truncated: byteTruncated || capped.wasCapped, lineBytes };
}

// Once a line's raw bytes exceed PENDING_CAP, any trailing \r would land past
// the truncation point regardless, so the retained prefix alone, without the
// rest of the line, is enough to produce the correct truncated text.
function finishOversizedLine(prefix: Buffer, lineBytes: number): ProcessedLine {
  const boundary = utf8SafeBoundary(prefix, MAX_LINE_BYTES);
  const decoded = prefix.subarray(0, boundary).toString("utf8");
  return { text: capDecodedText(decoded).text, truncated: true, lineBytes };
}

function emitProcessedLine(
  logger: Logger,
  options: PipeOptions,
  markerAttributes: Record<string, unknown>,
  processed: ProcessedLine,
): void {
  const attributes: Record<string, unknown> = {
    "madeit.line": processed.text,
    "madeit.stream": options.stream,
    ...(processed.truncated ? { "madeit.truncated": true, "madeit.line_bytes": processed.lineBytes } : {}),
    ...markerAttributes,
  };
  logger[options.level](options.event, PIPE_LINE_BODY, attributes);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emitLogMeta(
  logger: Logger,
  extraAttributes: Record<string, unknown>,
  body: string,
  reason: string,
): void {
  logger.error("log.meta", body, { ...extraAttributes, "madeit.error": reason });
}

interface TeeGuard {
  readonly forward: (buffer: Buffer) => Promise<void>;
  readonly dispose: () => void;
}

// A dead tee target only ever announces itself through 'error' or 'close',
// never through another 'drain', so a pending write must be released by
// either one, not only by a synchronous throw from write() itself.
function attachTeeGuard(
  logger: Logger,
  markerAttributes: Record<string, unknown>,
  stdout: CliIo["stdout"],
  tee: boolean,
): TeeGuard {
  let broken = false;
  let resolveBroken: (() => void) | undefined;
  const brokenSignal = new Promise<void>((resolve) => {
    resolveBroken = resolve;
  });

  function breakTee(error: unknown): void {
    if (broken) return;
    broken = true;
    emitLogMeta(logger, markerAttributes, "madeit-log pipe tee failed", errorMessage(error));
    resolveBroken?.();
  }

  const onError = (error: unknown): void => breakTee(error);
  const onClose = (): void => breakTee(new Error("tee target closed before all output was written"));

  if (tee) {
    stdout.once?.("error", onError);
    stdout.once?.("close", onClose);
  }

  async function awaitDrain(): Promise<void> {
    if (typeof stdout.once !== "function") return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const onDrain = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      stdout.once?.("drain", onDrain);
      void brokenSignal.then(() => {
        if (settled) return;
        settled = true;
        stdout.off?.("drain", onDrain);
        resolve();
      });
    });
  }

  async function forward(buffer: Buffer): Promise<void> {
    if (!tee || broken) return;
    try {
      const wroteImmediately = stdout.write(buffer);
      if (wroteImmediately === false) await awaitDrain();
    } catch (error) {
      breakTee(error);
    }
  }

  function dispose(): void {
    stdout.off?.("error", onError);
    stdout.off?.("close", onClose);
  }

  return { forward, dispose };
}

// A tee failure or a broken stdin must not discard lines that already
// arrived, so both paths flush whatever is pending and keep the call
// resolving 0 rather than losing the rest of the captured output.
async function runPipe(
  logger: Logger,
  options: PipeOptions,
  markerAttributes: Record<string, unknown>,
  io: CliIo,
): Promise<void> {
  // The pending line is a fixed-size buffer, not a growing one: once it fills
  // to PENDING_CAP, further bytes only advance lineBytes, so an unbounded
  // newline-free stream costs one capped buffer, not the whole stream.
  const pendingBuffer = Buffer.alloc(PENDING_CAP);
  let pendingLength = 0;
  let lineBytes = 0;
  let hasPendingLine = false;

  function appendToPending(slice: Buffer): void {
    hasPendingLine = true;
    lineBytes += slice.length;
    if (pendingLength >= PENDING_CAP) return;
    const copyLength = Math.min(PENDING_CAP - pendingLength, slice.length);
    slice.copy(pendingBuffer, pendingLength, 0, copyLength);
    pendingLength += copyLength;
  }

  function flushPendingLine(): void {
    if (!hasPendingLine) return;
    const prefix = pendingBuffer.subarray(0, pendingLength);
    const processed =
      lineBytes <= PENDING_CAP ? processLine(prefix) : finishOversizedLine(prefix, lineBytes);
    emitProcessedLine(logger, options, markerAttributes, processed);
    pendingLength = 0;
    lineBytes = 0;
    hasPendingLine = false;
  }

  const teeGuard = attachTeeGuard(logger, markerAttributes, io.stdout, options.tee);
  try {
    try {
      for await (const chunk of io.stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        await teeGuard.forward(buffer);
        let offset = 0;
        while (offset < buffer.length) {
          const newlineIndex = buffer.indexOf(0x0a, offset);
          if (newlineIndex === -1) {
            appendToPending(buffer.subarray(offset));
            offset = buffer.length;
          } else {
            appendToPending(buffer.subarray(offset, newlineIndex));
            flushPendingLine();
            offset = newlineIndex + 1;
          }
        }
      }
    } catch (error) {
      // Whatever stdin already delivered is still worth keeping, so the
      // pending line is flushed before the failure itself is recorded.
      flushPendingLine();
      emitLogMeta(logger, markerAttributes, "madeit-log pipe failed", errorMessage(error));
      return;
    }
    // A final line with no trailing newline is still a record, not a dropped tail.
    flushPendingLine();
  } finally {
    teeGuard.dispose();
  }
}

function describeMisuse(level: string | undefined, event: string | undefined, body: string | undefined): string {
  if (level === undefined) return `no command given. Usage: ${USAGE}`;
  if (!isLevel(level)) return `unknown level "${level}". Usage: ${USAGE}`;
  if (event === undefined) return `missing event for level "${level}". Usage: ${USAGE}`;
  if (body === undefined) return `missing body for event "${event}". Usage: ${USAGE}`;
  return `madeit-log was called incorrectly. Usage: ${USAGE}`;
}

function emitMisuse(logger: Logger, extraAttributes: Record<string, unknown>, reason: string): void {
  emitLogMeta(logger, extraAttributes, "madeit-log was called incorrectly", reason);
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

    if (argv[0] === "pipe") {
      const parsed = parsePipeArgs(argv.slice(1));
      if (!parsed.ok) {
        emitMisuse(logger, markerAttributes, parsed.reason);
        return 0;
      }
      await runPipe(logger, parsed.options, markerAttributes, io);
      return 0;
    }

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
    process.stderr.write(`madeit-log: ${errorMessage(error)}\n`);
    return 0;
  }
}

// Node reports EPIPE or EBADF on process.stdout/process.stderr as
// asynchronous 'error' events. With no listener, that crashes the process
// after main has already resolved, so a permanent, silent listener has to be
// in place before main ever runs. It must not itself write to the broken
// stream.
function ignoreStreamErrors(stream: NodeJS.WritableStream): void {
  stream.on("error", () => {});
}

async function runAsEntrypoint(): Promise<void> {
  ignoreStreamErrors(process.stdout);
  ignoreStreamErrors(process.stderr);
  const exitCode = await main(process.argv.slice(2), process.env, {
    stdin: process.stdin,
    stdout: process.stdout,
  });
  process.exitCode = exitCode;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && fs.realpathSync(invokedPath) === fileURLToPath(import.meta.url)) {
  void runAsEntrypoint();
}
