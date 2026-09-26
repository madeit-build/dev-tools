#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { fileSink, getLogger, stderrSink, stdoutSink, type Logger, type LogRecord, type Sink } from "./index.ts";

export interface CliIo {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: {
    write(chunk: string | Uint8Array): unknown;
    on?(event: string, listener: (...args: unknown[]) => void): unknown;
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

// A CLI-generated failure reason must never destroy a caller's own
// madeit.error, and two CLI reasons (a bad sink, then a later misuse) must
// not destroy each other either: every CLI reason folds into
// madeit.cli_error, joined by "; ", while madeit.error is left to the caller.
function addCliError(attributes: Record<string, unknown>, reason: string): Record<string, unknown> {
  const existing = attributes["madeit.cli_error"];
  const combined = typeof existing === "string" ? `${existing}; ${reason}` : reason;
  return { ...attributes, "madeit.cli_error": combined };
}

function markSinkFailure(record: LogRecord, rawSinkValue: string, reason: string): LogRecord {
  return {
    ...record,
    Attributes: addCliError({ ...record.Attributes, "madeit.invalid_sink": rawSinkValue }, reason),
  };
}

// A synchronous throw from sink() is fully caught here and rerouted to
// stderr as one JSON record, with the failure disabling that sink for the
// rest of the process rather than retrying it on every call. stdout's own
// real failures (a broken pipe) surface asynchronously and never reach this
// catch; the entrypoint's permanent 'error' listener covers those instead.
function withStderrFallback(sink: Sink, rawSinkValue: string): Sink {
  const fallback = stderrSink();
  let failure: string | undefined;
  return (record) => {
    if (failure !== undefined) {
      fallback(markSinkFailure(record, rawSinkValue, failure));
      return;
    }
    try {
      sink(record);
    } catch (error) {
      failure = errorMessage(error);
      fallback(markSinkFailure(record, rawSinkValue, failure));
    }
  };
}

function chooseSink(env: Record<string, string | undefined>): SinkChoice {
  const raw = env.MADEIT_LOG_SINK;
  if (raw === undefined || raw === "stderr") return { sink: stderrSink(), extraAttributes: {} };
  if (raw === "stdout") return { sink: withStderrFallback(stdoutSink(), raw), extraAttributes: {} };
  if (raw.startsWith("file:")) {
    const filePath = raw.slice("file:".length);
    if (filePath !== "") {
      try {
        return { sink: withStderrFallback(fileSink(filePath), raw), extraAttributes: {} };
      } catch (error) {
        // fileSink's mkdirSync can fail before any record is ever written (an
        // ENOTDIR path segment, for example). The record, the sink value and
        // the failure reason must all still reach stderr, not just a
        // diagnostic-only line.
        return {
          sink: stderrSink(),
          extraAttributes: addCliError({ "madeit.invalid_sink": raw }, errorMessage(error)),
        };
      }
    }
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
// attribute, so a forged one is folded into madeit.invalid_attribute_count
// exactly like an empty key or a bare argument, rather than overwriting the
// real mark.
const RESERVED_ATTRIBUTE_KEYS = new Set([
  "madeit.invalid_attribute_count",
  "madeit.invalid_sink",
  "madeit.missing_resource",
  "madeit.cli_error",
]);

// A bare argument's text is counted, never echoed: a forgotten "=" is exactly
// how a caller who meant "key=value" ends up passing a raw secret instead.
function parseAttributes(args: readonly string[]): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  let invalidCount = 0;
  for (const arg of args) {
    const separator = arg.indexOf("=");
    const key = separator > 0 ? arg.slice(0, separator) : "";
    if (separator <= 0 || RESERVED_ATTRIBUTE_KEYS.has(key)) {
      invalidCount++;
      continue;
    }
    attributes[key] = coerceValue(arg.slice(separator + 1));
  }
  if (invalidCount > 0) attributes["madeit.invalid_attribute_count"] = invalidCount;
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

// An unrecognized argument is described by its key only: a "key=value" shape
// is exactly how a caller who meant event mode's attributes ends up passing
// one to pipe, and the value half can be a credential.
function describePipeArgument(flag: string, position: number): string {
  const separator = flag.indexOf("=");
  if (separator > 0) return flag.slice(0, separator);
  if (flag.startsWith("-")) return flag;
  return `argument ${position + 1}`;
}

// Flags come after the event and are parsed left to right; any of them missing
// its value, or an argument this loop does not recognize, is misuse and must
// be caught before stdin is read for a record (draining it to avoid SIGPIPE
// happens separately, in main).
function parsePipeArgs(args: readonly string[]): PipeParseResult {
  const [event, ...rest] = args;
  if (event === undefined) return { ok: false, reason: `missing event for pipe. Usage: ${PIPE_USAGE}` };
  // A flag in the event slot (a forgotten event, most often) must not
  // silently become the event: "--tee" there would otherwise disable tee.
  if (event.startsWith("-")) return { ok: false, reason: `event cannot start with "-". Usage: ${PIPE_USAGE}` };

  let level: Level = "info";
  let stream: Stream = "stdout";
  let tee = false;
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index]!;
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
      return {
        ok: false,
        reason: `unknown argument "${describePipeArgument(flag, index)}" for pipe. Usage: ${PIPE_USAGE}`,
      };
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
  logger.error("log.meta", body, addCliError(extraAttributes, reason));
}

interface TeeGuard {
  readonly forward: (buffer: Buffer) => Promise<void>;
  readonly flush: () => Promise<void>;
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
  // forward() and flush() are always awaited in sequence, so at most one
  // drain wait is ever pending at a time. One slot for its release is
  // enough: each new wait overwrites it instead of accumulating.
  let releasePendingDrain: (() => void) | undefined;

  function breakTee(error: unknown): void {
    if (broken) return;
    broken = true;
    emitLogMeta(logger, markerAttributes, "madeit-log pipe tee failed", errorMessage(error));
    releasePendingDrain?.();
  }

  const onError = (error: unknown): void => breakTee(error);
  const onClose = (): void => breakTee(new Error("tee target closed before all output was written"));

  if (tee) {
    // 'error' can fire more than once, so its listener must stay attached.
    // 'close' fires exactly once per stream, so once() already matches it.
    stdout.on?.("error", onError);
    stdout.once?.("close", onClose);
  }

  async function awaitDrain(): Promise<void> {
    if (typeof stdout.once !== "function" || broken) return;
    await new Promise<void>((resolve) => {
      const onDrain = (): void => {
        releasePendingDrain = undefined;
        resolve();
      };
      releasePendingDrain = (): void => {
        stdout.off?.("drain", onDrain);
        releasePendingDrain = undefined;
        resolve();
      };
      stdout.once?.("drain", onDrain);
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

  // Node only ever emits 'drain' after a write() call that returned false;
  // waiting for it when nothing set that flag would wait forever for an
  // event that is never coming. writableNeedDrain mirrors that flag exactly,
  // so this only waits when a real drain is actually still owed, while the
  // race against breakage in awaitDrain still catches a late failure.
  async function flush(): Promise<void> {
    if (!tee || broken) return;
    if ((stdout as { writableNeedDrain?: unknown }).writableNeedDrain !== true) return;
    await awaitDrain();
  }

  function dispose(): void {
    stdout.off?.("error", onError);
    stdout.off?.("close", onClose);
  }

  return { forward, flush, dispose };
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
    // A late failure in whatever the tee still has queued must be seen while
    // the guard's listeners are attached, or it only reaches the
    // entrypoint's silent, permanent listener instead of this tee's log.meta.
    await teeGuard.flush();
    teeGuard.dispose();
  }
}

// A real terminal has no piped input to drain, and reading from one would
// block until a human types something: draining is only for a redirected or
// piped stdin, which is the only shape that can SIGPIPE an upstream producer.
function isPipedStdin(stdin: NodeJS.ReadableStream): boolean {
  return (stdin as { isTTY?: boolean }).isTTY !== true;
}

// A misused pipe call, or one whose event slot turned out to be "--help",
// must still drain stdin to EOF: leaving it unread is what SIGPIPEs an
// upstream producer under `set -o pipefail`. The same tee guard as a real
// run keeps a broken or slow stdout from crashing or hanging this drain.
async function drainPipedStdin(
  logger: Logger,
  markerAttributes: Record<string, unknown>,
  io: CliIo,
  tee: boolean,
): Promise<void> {
  if (!isPipedStdin(io.stdin)) return;
  const teeGuard = attachTeeGuard(logger, markerAttributes, io.stdout, tee);
  try {
    try {
      for await (const chunk of io.stdin) {
        await teeGuard.forward(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    } catch {
      // Whatever stdin does while draining is not its own report: the
      // caller already has the misuse record, or none was needed for help.
    }
  } finally {
    await teeGuard.flush();
    teeGuard.dispose();
  }
}

// The outer catch below can run before logger even exists (a failure inside
// its own construction), so this fallback drain has no reporting: it only
// keeps an upstream producer from seeing SIGPIPE, best-effort.
async function drainStdinRaw(io: CliIo, tee: boolean): Promise<void> {
  if (!isPipedStdin(io.stdin)) return;
  let stillTeeing = tee;
  try {
    for await (const chunk of io.stdin) {
      if (!stillTeeing) continue;
      try {
        io.stdout.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      } catch {
        stillTeeing = false;
      }
    }
  } catch {
    // best effort only
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
  const isPipeInvocation = argv[0] === "pipe";
  const wantsTee = argv.includes("--tee");
  try {
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

    // Checked anywhere in argv, not only argv[0], so "pipe --help" prints
    // help instead of treating "--help" as the event and hanging on stdin.
    if (argv.includes("--help") || argv.includes("-h")) {
      io.stdout.write(HELP);
      if (isPipeInvocation) await drainPipedStdin(logger, markerAttributes, io, wantsTee);
      return 0;
    }

    if (isPipeInvocation) {
      const parsed = parsePipeArgs(argv.slice(1));
      if (!parsed.ok) {
        emitMisuse(logger, markerAttributes, parsed.reason);
        await drainPipedStdin(logger, markerAttributes, io, wantsTee);
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
    // Whatever survives everything above (chooseSink and runPipe already
    // handle their own known failure modes) is unexpected, and the caller
    // still sees exit 0, not a crashed shell.
    process.stderr.write(`madeit-log: ${errorMessage(error)}\n`);
    if (isPipeInvocation) await drainStdinRaw(io, wantsTee);
    return 0;
  }
}

// Node reports EPIPE or EBADF on process.stdout/process.stderr as
// asynchronous 'error' events, which crash the process if nothing is
// listening, even after main already resolved. The listener stays silent:
// writing to the broken stream here would just repeat the same failure.
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

// realpathSync throws when argv[1] names a path that does not exist, which
// happens for a script fed on stdin or a module imported with an arbitrary
// argv[1]. Any failure here just means this module was not run directly.
function isDirectEntrypoint(invokedPath: string | undefined): boolean {
  if (invokedPath === undefined) return false;
  try {
    return fs.realpathSync(invokedPath) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectEntrypoint(process.argv[1])) {
  // main already resolves 0 for any input; this only guards a rejection that
  // reaches past it, so the process still exits 0 instead of crashing on an
  // unhandled rejection.
  void runAsEntrypoint().catch(() => {
    process.exitCode = 0;
  });
}
