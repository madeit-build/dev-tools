import { describe, expect, it, vi } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { main, type CliIo } from "./cli.ts";
import type { LogRecord } from "./record.ts";

const schema = JSON.parse(
  fs.readFileSync(new URL("../../schema/madeit-log-v1.json", import.meta.url), "utf8"),
);
const validate = new Ajv2020({ strict: false }).compile(schema);

interface RedactionCase {
  readonly key: string;
  readonly value: string;
  readonly expect: "keep" | "drop" | "truncate";
}

const redactionCases: RedactionCase[] = JSON.parse(
  fs.readFileSync(new URL("../../schema/redaction-cases.json", import.meta.url), "utf8"),
);

const baseEnv: Record<string, string> = {
  MADEIT_SERVICE: "hookd",
  MADEIT_VERSION: "abc1234",
  MADEIT_ENVIRONMENT: "test",
  MADEIT_REPO: "dev-tools",
  MADEIT_COMPONENT: "cli",
};

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cli-")), "out.jsonl");
}

function readLines(filePath: string): LogRecord[] {
  return fs.readFileSync(filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function fakeIo(): CliIo & { written: string[] } {
  const written: string[] = [];
  return {
    stdin: Readable.from([]),
    stdout: {
      write: (chunk: string | Uint8Array) => {
        written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      },
    },
    written,
  };
}

async function runToFile(argv: string[], env: Record<string, string> = {}): Promise<LogRecord[]> {
  const file = tmpFile();
  const exitCode = await main(argv, { ...baseEnv, ...env, MADEIT_LOG_SINK: `file:${file}` }, fakeIo());
  expect(exitCode).toBe(0);
  return readLines(file);
}

describe("cli main, event mode", () => {
  it("emits one schema-valid record for a plain call", async () => {
    const [record] = await runToFile(["info", "probe.hello", "hello", "madeit.n=1"]);
    expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
    expect(record?.SeverityText).toBe("INFO");
    expect(record?.Body).toBe("hello");
    expect(record?.Attributes["madeit.n"]).toBe(1);
  });

  for (const level of ["debug", "info", "warn", "error"] as const) {
    it(`maps level "${level}" to SeverityText ${level.toUpperCase()}`, async () => {
      const [record] = await runToFile([level, "probe.hello", "hi"]);
      expect(record?.SeverityText).toBe(level.toUpperCase());
    });
  }

  it("types a=true, b=null, c=01 and d=x=y as boolean, null, and two strings", async () => {
    const [record] = await runToFile(["info", "probe.hello", "hi", "a=true", "b=null", "c=01", "d=x=y"]);
    expect(record?.Attributes.a).toBe(true);
    expect(record?.Attributes.b).toBeNull();
    expect(record?.Attributes.c).toBe("01");
    expect(record?.Attributes.d).toBe("x=y");
  });

  it("collects an argument without '=' into madeit.invalid_attribute", async () => {
    const [record] = await runToFile(["info", "probe.hello", "hi", "bare"]);
    expect(record?.Attributes["madeit.invalid_attribute"]).toBe("bare");
  });

  // Mirrors the CLI's key=value JSON-typing rule, so the "keep" branch below can
  // assert on the exact typed value rather than only its presence.
  function expectedAttributeValue(raw: string): unknown {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return raw;
    }
    if (typeof parsed === "boolean" || parsed === null) return parsed;
    if (typeof parsed !== "number" || !Number.isFinite(parsed)) return raw;
    if (/^-?\d+$/.test(raw) && !Number.isSafeInteger(parsed)) return raw;
    return parsed;
  }

  for (const testCase of redactionCases) {
    it(`redaction case "${testCase.key}" is ${testCase.expect}`, async () => {
      const [record] = await runToFile(["info", "probe.redact", "hi", `${testCase.key}=${testCase.value}`]);
      expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
      const value = record?.Attributes[testCase.key];
      if (testCase.expect === "drop") {
        expect(value).toBeUndefined();
      } else if (testCase.expect === "truncate") {
        expect(String(value)).toHaveLength(12);
      } else {
        expect(value).toBe(expectedAttributeValue(testCase.value));
      }
    });
  }

  it("keeps a normal integer's numeric type", async () => {
    const [record] = await runToFile(["info", "probe.hello", "hi", "n=42"]);
    expect(record?.Attributes.n).toBe(42);
  });

  it("keeps an integer-looking value outside Number.isSafeInteger as the raw string", async () => {
    const [record] = await runToFile(["info", "probe.hello", "hi", "n=12345678901234567890"]);
    expect(record?.Attributes.n).toBe("12345678901234567890");
  });

  it("keeps a value that parses to a non-finite number as the raw string", async () => {
    const [record] = await runToFile(["info", "probe.hello", "hi", "n=1e999"]);
    expect(record?.Attributes.n).toBe("1e999");
  });

  it("treats an empty key ('=v') as invalid, not as an attribute named \"\"", async () => {
    const [record] = await runToFile(["info", "probe.hello", "hi", "=v"]);
    expect(record?.Attributes["madeit.invalid_attribute"]).toBe("=v");
  });

  it("does not let a caller forge madeit.invalid_sink, madeit.missing_resource or madeit.invalid_attribute", async () => {
    const [record] = await runToFile([
      "info", "probe.hello", "hi",
      "madeit.invalid_sink=forged", "madeit.missing_resource=forged", "madeit.invalid_attribute=forged",
    ]);
    expect(record?.Attributes["madeit.invalid_sink"]).toBeUndefined();
    expect(record?.Attributes["madeit.missing_resource"]).toBeUndefined();
    expect(record?.Attributes["madeit.invalid_attribute"]).toBe(
      "madeit.invalid_sink=forged madeit.missing_resource=forged madeit.invalid_attribute=forged",
    );
  });

  it("reads unknown for every resource field and names all five in madeit.missing_resource", async () => {
    const file = tmpFile();
    const exitCode = await main(["info", "probe.hello", "hi"], { MADEIT_LOG_SINK: `file:${file}` }, fakeIo());
    expect(exitCode).toBe(0);
    const [record] = readLines(file);
    expect(record?.Resource).toEqual({
      "service.name": "unknown",
      "service.version": "unknown",
      "deployment.environment": "unknown",
      "madeit.repo": "unknown",
      "madeit.component": "unknown",
    });
    expect(record?.Attributes["madeit.missing_resource"]).toBe(
      "MADEIT_SERVICE,MADEIT_VERSION,MADEIT_ENVIRONMENT,MADEIT_REPO,MADEIT_COMPONENT",
    );
  });

  it("treats an empty MADEIT_SERVICE as missing, not as an empty resource field", async () => {
    const [record] = await runToFile(["info", "probe.hello", "hi"], { MADEIT_SERVICE: "" });
    expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
    expect(record?.Resource["service.name"]).toBe("unknown");
    expect(record?.Attributes["madeit.missing_resource"]).toContain("MADEIT_SERVICE");
  });

  it("treats a whitespace-only MADEIT_COMPONENT as missing too", async () => {
    const [record] = await runToFile(["info", "probe.hello", "hi"], { MADEIT_COMPONENT: "   " });
    expect(record?.Resource["madeit.component"]).toBe("unknown");
    expect(record?.Attributes["madeit.missing_resource"]).toContain("MADEIT_COMPONENT");
  });

  it("TRACEPARENT sets TraceId and SpanId", async () => {
    const [record] = await runToFile(["info", "probe.hello", "hi"], {
      TRACEPARENT: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    });
    expect(record?.TraceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(record?.SpanId).toBe("00f067aa0ba902b7");
  });

  async function assertSingleMisuse(argv: string[]): Promise<void> {
    const lines = await runToFile(argv);
    expect(lines).toHaveLength(1);
    expect(validate(lines[0]), JSON.stringify(validate.errors)).toBe(true);
    expect(lines[0]?.Attributes["madeit.event"]).toBe("log.meta");
    expect(lines[0]?.SeverityText).toBe("ERROR");
    expect(lines[0]?.Body).toBe("madeit-log was called incorrectly");
  }

  it("misuse (no arguments) resolves 0 and emits exactly one log.meta record", async () => {
    await assertSingleMisuse([]);
  });

  it("misuse (unknown level) resolves 0 and emits exactly one log.meta record", async () => {
    await assertSingleMisuse(["shout", "x", "y"]);
  });

  it("misuse (missing event) resolves 0 and emits exactly one log.meta record", async () => {
    await assertSingleMisuse(["info"]);
  });

  it("MADEIT_LOG_SINK=bogus still emits, to stderr, and carries madeit.invalid_sink", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const exitCode = await main(
        ["info", "probe.hello", "hi"],
        { ...baseEnv, MADEIT_LOG_SINK: "bogus" },
        fakeIo(),
      );
      expect(exitCode).toBe(0);
      expect(spy).toHaveBeenCalledOnce();
      const written = spy.mock.calls[0]?.[0];
      const str = typeof written === "string" ? written : String(written);
      const record = JSON.parse(str.trim()) as LogRecord;
      expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
      expect(record.Attributes["madeit.invalid_sink"]).toBe("bogus");
    } finally {
      spy.mockRestore();
    }
  });

  // A path segment that is an ordinary file makes fileSink's directory creation
  // throw before any record is written. main must still resolve 0, and the
  // record must still reach stderr, marked with the sink value that failed,
  // rather than being lost behind a diagnostic-only line.
  it("falls back to stderr with madeit.invalid_sink when the chosen file sink's directory cannot be created", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "cli-"));
    const blocker = path.join(parent, "blocker");
    fs.writeFileSync(blocker, "not a directory");
    const target = path.join(blocker, "nested", "out.jsonl");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const exitCode = await main(
        ["info", "probe.hello", "hi"],
        { ...baseEnv, MADEIT_LOG_SINK: `file:${target}` },
        fakeIo(),
      );
      expect(exitCode).toBe(0);
      expect(spy).toHaveBeenCalledOnce();
      const written = spy.mock.calls[0]?.[0];
      const str = typeof written === "string" ? written : String(written);
      const record = JSON.parse(str.trim()) as LogRecord;
      expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
      expect(record.Body).toBe("hi");
      expect(record.Attributes["madeit.invalid_sink"]).toBe(`file:${target}`);
    } finally {
      spy.mockRestore();
    }
  });

  // A sink that fails only when it writes (a directory in the file's place, here)
  // must not lose the record: fanOut has nowhere left to route its own death notice.
  it("falls back to stderr, without losing the record, when the file sink fails at write time", async () => {
    const targetDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cli-"));
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const exitCode = await main(
        ["info", "probe.hello", "hi"],
        { ...baseEnv, MADEIT_LOG_SINK: `file:${targetDirectory}` },
        fakeIo(),
      );
      expect(exitCode).toBe(0);
      const calls = spy.mock.calls.map(([chunk]) => (typeof chunk === "string" ? chunk : String(chunk)));
      expect(calls.some((line) => line.startsWith("madeit-log: "))).toBe(true);
      const recordLine = calls.find((line) => line.trimStart().startsWith("{"));
      expect(recordLine).toBeDefined();
      const record = JSON.parse((recordLine ?? "").trim()) as LogRecord;
      expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
      expect(record.Body).toBe("hi");
    } finally {
      spy.mockRestore();
    }
  });

  it("treats an empty file: path as an invalid sink and falls back to stderr", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const exitCode = await main(
        ["info", "probe.hello", "hi"],
        { ...baseEnv, MADEIT_LOG_SINK: "file:" },
        fakeIo(),
      );
      expect(exitCode).toBe(0);
      expect(spy).toHaveBeenCalledOnce();
      const written = spy.mock.calls[0]?.[0];
      const str = typeof written === "string" ? written : String(written);
      const record = JSON.parse(str.trim()) as LogRecord;
      expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
      expect(record.Attributes["madeit.invalid_sink"]).toBe("file:");
    } finally {
      spy.mockRestore();
    }
  });
});

function fakePipeIo(chunks: readonly Buffer[]): { io: CliIo; stdoutBytes: () => Buffer } {
  const written: Buffer[] = [];
  const io: CliIo = {
    stdin: Readable.from(chunks),
    stdout: {
      write: (chunk: string | Uint8Array) => {
        written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        return true;
      },
    },
  };
  return { io, stdoutBytes: () => Buffer.concat(written) };
}

async function runPipeToFile(
  argv: string[],
  chunks: readonly Buffer[],
  env: Record<string, string> = {},
): Promise<{ records: LogRecord[]; stdoutBytes: Buffer }> {
  const file = tmpFile();
  const { io, stdoutBytes } = fakePipeIo(chunks);
  const exitCode = await main(argv, { ...baseEnv, ...env, MADEIT_LOG_SINK: `file:${file}` }, io);
  expect(exitCode).toBe(0);
  return { records: readLines(file), stdoutBytes: stdoutBytes() };
}

describe("cli main, pipe mode", () => {
  it("emits one schema-valid record per line, defaulting to stdout and INFO", async () => {
    const { records } = await runPipeToFile(["pipe", "build.output"], [Buffer.from("a\nb\n")]);
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
      expect(record?.SeverityText).toBe("INFO");
      expect(record?.Attributes["madeit.stream"]).toBe("stdout");
    }
    expect(records[0]?.Attributes["madeit.line"]).toBe("a");
    expect(records[1]?.Attributes["madeit.line"]).toBe("b");
  });

  it("reflects --stream and --level in every record", async () => {
    const { records } = await runPipeToFile(
      ["pipe", "build.output", "--stream", "stderr", "--level", "warn"],
      [Buffer.from("a\nb\n")],
    );
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record?.SeverityText).toBe("WARN");
      expect(record?.Attributes["madeit.stream"]).toBe("stderr");
    }
  });

  it("treats a final line without a trailing newline as its own record", async () => {
    const { records } = await runPipeToFile(["pipe", "build.output"], [Buffer.from("a\nb")]);
    expect(records).toHaveLength(2);
    expect(records[0]?.Attributes["madeit.line"]).toBe("a");
    expect(records[1]?.Attributes["madeit.line"]).toBe("b");
  });

  it("tees CRLF input byte for byte", async () => {
    const input = Buffer.from("a\r\nb");
    const { stdoutBytes } = await runPipeToFile(["pipe", "build.output", "--tee"], [input]);
    expect(stdoutBytes.equals(input)).toBe(true);
  });

  it("tees input split mid-line and mid-UTF-8 character across chunks", async () => {
    // "é" is 0xC3 0xA9 in UTF-8; splitting between its two bytes must still tee
    // byte for byte and still decode to "é" once the full line has arrived.
    const full = Buffer.from("café\n", "utf8");
    const chunks = [full.subarray(0, 4), full.subarray(4)];
    const { records, stdoutBytes } = await runPipeToFile(["pipe", "build.output", "--tee"], chunks);
    expect(stdoutBytes.equals(full)).toBe(true);
    expect(records[0]?.Attributes["madeit.line"]).toBe("café");
  });

  it("tees binary-ish bytes byte for byte", async () => {
    const input = Buffer.from([0x00, 0xff, 0x0a]);
    const { stdoutBytes } = await runPipeToFile(["pipe", "build.output", "--tee"], [input]);
    expect(stdoutBytes.equals(input)).toBe(true);
  });

  it("strips a trailing \\r from the logged line", async () => {
    const { records } = await runPipeToFile(["pipe", "build.output"], [Buffer.from("a\r\nb")]);
    expect(records.map((record) => record?.Attributes["madeit.line"])).toEqual(["a", "b"]);
  });

  it("cuts a 20000-byte line to 16384 bytes and marks it truncated", async () => {
    const line = Buffer.alloc(20000, "x");
    const { records } = await runPipeToFile(
      ["pipe", "build.output"],
      [Buffer.concat([line, Buffer.from("\n")])],
    );
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
    expect(record?.Attributes["madeit.truncated"]).toBe(true);
    expect(record?.Attributes["madeit.line_bytes"]).toBe(20000);
    expect(String(record?.Attributes["madeit.line"])).toHaveLength(16384);
  });

  it("cuts an incomplete trailing multi-byte character back to a whole-character boundary", async () => {
    const prefix = Buffer.alloc(16383, "x");
    const full = Buffer.concat([prefix, Buffer.from("é", "utf8"), Buffer.from("\n")]);
    const { records } = await runPipeToFile(["pipe", "build.output"], [full]);
    expect(records).toHaveLength(1);
    const [record] = records;
    const line = String(record?.Attributes["madeit.line"]);
    expect(line).toBe(prefix.toString("utf8"));
    expect(line).not.toContain("�");
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(16384);
    expect(record?.Attributes["madeit.line_bytes"]).toBe(16385);
  });

  it("produces 10,000 records from one main call", async () => {
    const lines = `${Array.from({ length: 10_000 }, (_, i) => `line-${i}`).join("\n")}\n`;
    const { records } = await runPipeToFile(["pipe", "build.output"], [Buffer.from(lines)]);
    expect(records).toHaveLength(10_000);
  });

  it("bounds a very long newline-free line delivered in many small chunks to one truncated record", async () => {
    const totalBytes = 200_000;
    const chunkSize = 37;
    const chunks: Buffer[] = [];
    for (let sent = 0; sent < totalBytes; sent += chunkSize) {
      chunks.push(Buffer.alloc(Math.min(chunkSize, totalBytes - sent), "y"));
    }
    const { records } = await runPipeToFile(["pipe", "build.output"], chunks);
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.Attributes["madeit.truncated"]).toBe(true);
    expect(record?.Attributes["madeit.line_bytes"]).toBe(totalBytes);
    expect(Buffer.byteLength(String(record?.Attributes["madeit.line"]), "utf8")).toBeLessThanOrEqual(16384);
  });

  it("gives every pipe record the same fixed Body, whatever the line's content", async () => {
    const { records } = await runPipeToFile(["pipe", "build.output"], [Buffer.from("a\n\nbb\n")]);
    expect(records).toHaveLength(3);
    expect(records.map((record) => record?.Attributes["madeit.line"])).toEqual(["a", "", "bb"]);
    const bodies = new Set(records.map((record) => record?.Body));
    expect(bodies.size).toBe(1);
    expect(records[0]?.Body).toBeTruthy();
  });

  it("keeps records for complete lines, flushes the pending line, and adds one log.meta when stdin errors", async () => {
    async function* erroringSource(): AsyncGenerator<Buffer> {
      yield Buffer.from("a\nb\npart");
      throw new Error("boom");
    }
    const file = tmpFile();
    const exitCode = await main(
      ["pipe", "build.output"],
      { ...baseEnv, MADEIT_LOG_SINK: `file:${file}` },
      { stdin: Readable.from(erroringSource()), stdout: { write: () => true } },
    );
    expect(exitCode).toBe(0);
    const records = readLines(file);
    const lineRecords = records.filter((record) => record?.Attributes["madeit.event"] !== "log.meta");
    expect(lineRecords.map((record) => record?.Attributes["madeit.line"])).toEqual(["a", "b", "part"]);
    const metaRecords = records.filter((record) => record?.Attributes["madeit.event"] === "log.meta");
    expect(metaRecords).toHaveLength(1);
    expect(String(metaRecords[0]?.Attributes["madeit.error"])).toContain("boom");
  });

  it("stops teeing after a write failure, keeps logging remaining lines, and adds one log.meta", async () => {
    let calls = 0;
    const stdout = {
      write: () => {
        calls++;
        throw new Error("epipe");
      },
    };
    const file = tmpFile();
    const exitCode = await main(
      ["pipe", "build.output", "--tee"],
      { ...baseEnv, MADEIT_LOG_SINK: `file:${file}` },
      { stdin: Readable.from([Buffer.from("a\n"), Buffer.from("b\n")]), stdout },
    );
    expect(exitCode).toBe(0);
    const records = readLines(file);
    const lineRecords = records.filter((record) => record?.Attributes["madeit.event"] !== "log.meta");
    expect(lineRecords.map((record) => record?.Attributes["madeit.line"])).toEqual(["a", "b"]);
    const metaRecords = records.filter((record) => record?.Attributes["madeit.event"] === "log.meta");
    expect(metaRecords).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it("resolves promptly, logs every line, and emits one log.meta when a small-buffer tee target errors instead of draining", async () => {
    const stdout = new Writable({
      highWaterMark: 4,
      write(_chunk, _encoding, callback) {
        process.nextTick(() => callback(new Error("epipe")));
      },
    });
    const file = tmpFile();
    const exitCode = await main(
      ["pipe", "build.output", "--tee"],
      { ...baseEnv, MADEIT_LOG_SINK: `file:${file}` },
      { stdin: Readable.from([Buffer.from("a\n"), Buffer.from("b\n")]), stdout },
    );
    expect(exitCode).toBe(0);
    const records = readLines(file);
    const lineRecords = records.filter((record) => record?.Attributes["madeit.event"] !== "log.meta");
    expect(lineRecords.map((record) => record?.Attributes["madeit.line"])).toEqual(["a", "b"]);
    const metaRecords = records.filter((record) => record?.Attributes["madeit.event"] === "log.meta");
    expect(metaRecords).toHaveLength(1);
  });

  it("does not crash on an unhandled error when a tee target fails asynchronously", async () => {
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        process.nextTick(() => callback(new Error("epipe")));
      },
    });
    const file = tmpFile();
    const exitCode = await main(
      ["pipe", "build.output", "--tee"],
      { ...baseEnv, MADEIT_LOG_SINK: `file:${file}` },
      { stdin: Readable.from([Buffer.from("a\n"), Buffer.from("b\n")]), stdout },
    );
    expect(exitCode).toBe(0);
    const records = readLines(file);
    const lineRecords = records.filter((record) => record?.Attributes["madeit.event"] !== "log.meta");
    expect(lineRecords.map((record) => record?.Attributes["madeit.line"])).toEqual(["a", "b"]);
    const metaRecords = records.filter((record) => record?.Attributes["madeit.event"] === "log.meta");
    expect(metaRecords).toHaveLength(1);
  });

  it("caps a line whose decoded text inflates past the byte limit on invalid UTF-8", async () => {
    const line = Buffer.alloc(16384, 0xff);
    const { records } = await runPipeToFile(
      ["pipe", "build.output"],
      [Buffer.concat([line, Buffer.from("\n")])],
    );
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.Attributes["madeit.truncated"]).toBe(true);
    expect(Buffer.byteLength(String(record?.Attributes["madeit.line"]), "utf8")).toBeLessThanOrEqual(16384);
    expect(record?.Attributes["madeit.line_bytes"]).toBe(16384);
  });

  it("awaits drain when tee's write reports backpressure", async () => {
    const written: Buffer[] = [];
    let writeCalls = 0;
    let drainCallback: (() => void) | undefined;
    const stdout = {
      write: (chunk: string | Uint8Array) => {
        written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        writeCalls++;
        return writeCalls > 1;
      },
      once: (event: string, listener: () => void) => {
        if (event === "drain") drainCallback = listener;
      },
    };
    const file = tmpFile();
    const runPromise = main(
      ["pipe", "build.output", "--tee"],
      { ...baseEnv, MADEIT_LOG_SINK: `file:${file}` },
      { stdin: Readable.from([Buffer.from("a\n"), Buffer.from("b\n")]), stdout },
    );
    for (let attempt = 0; attempt < 50 && drainCallback === undefined; attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(drainCallback).toBeDefined();
    drainCallback?.();
    const exitCode = await runPromise;
    expect(exitCode).toBe(0);
    expect(Buffer.concat(written).equals(Buffer.from("a\nb\n"))).toBe(true);
    expect(readLines(file)).toHaveLength(2);
  });

  async function assertPipeMisuseWithoutReadingStdin(argv: string[], reasonPattern: RegExp): Promise<void> {
    const stdin = Readable.from([Buffer.from("should not be read\n")]);
    const readSpy = vi.spyOn(stdin, "read");
    const file = tmpFile();
    const exitCode = await main(
      argv,
      { ...baseEnv, MADEIT_LOG_SINK: `file:${file}` },
      { stdin, stdout: { write: () => true } },
    );
    expect(exitCode).toBe(0);
    const [record] = readLines(file);
    expect(record?.Attributes["madeit.event"]).toBe("log.meta");
    expect(String(record?.Attributes["madeit.error"])).toMatch(reasonPattern);
    expect(readSpy).not.toHaveBeenCalled();
  }

  it("misuse (no event) resolves 0, emits log.meta, and never reads stdin", async () => {
    const stdin = Readable.from([Buffer.from("should not be read\n")]);
    const readSpy = vi.spyOn(stdin, "read");
    const file = tmpFile();
    const exitCode = await main(
      ["pipe"],
      { ...baseEnv, MADEIT_LOG_SINK: `file:${file}` },
      { stdin, stdout: { write: () => true } },
    );
    expect(exitCode).toBe(0);
    const [record] = readLines(file);
    expect(record?.Attributes["madeit.event"]).toBe("log.meta");
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("misuse (unknown flag) resolves 0, emits log.meta, and never reads stdin", async () => {
    const stdin = Readable.from([Buffer.from("should not be read\n")]);
    const readSpy = vi.spyOn(stdin, "read");
    const file = tmpFile();
    const exitCode = await main(
      ["pipe", "build.output", "--bogus"],
      { ...baseEnv, MADEIT_LOG_SINK: `file:${file}` },
      { stdin, stdout: { write: () => true } },
    );
    expect(exitCode).toBe(0);
    const [record] = readLines(file);
    expect(record?.Attributes["madeit.event"]).toBe("log.meta");
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("misuse (bad --level value) resolves 0, emits log.meta, and never reads stdin", async () => {
    await assertPipeMisuseWithoutReadingStdin(
      ["pipe", "build.output", "--level", "bogus"],
      /unknown --level "bogus"/,
    );
  });

  it("misuse (bad --stream value) resolves 0, emits log.meta, and never reads stdin", async () => {
    await assertPipeMisuseWithoutReadingStdin(
      ["pipe", "build.output", "--stream", "bogus"],
      /unknown --stream "bogus"/,
    );
  });

  it("misuse (missing --level value) resolves 0, emits log.meta, and never reads stdin", async () => {
    await assertPipeMisuseWithoutReadingStdin(
      ["pipe", "build.output", "--level"],
      /missing value for --level/,
    );
  });

  it("misuse (missing --stream value) resolves 0, emits log.meta, and never reads stdin", async () => {
    await assertPipeMisuseWithoutReadingStdin(
      ["pipe", "build.output", "--stream"],
      /missing value for --stream/,
    );
  });
});

describe("cli main, --help", () => {
  it("writes usage, including the security sentence, to stdout and resolves 0", async () => {
    const io = fakeIo();
    const exitCode = await main(["--help"], baseEnv, io);
    expect(exitCode).toBe(0);
    const output = io.written.join("");
    expect(output).toContain("madeit-log <debug|info|warn|error> <event> <body> [key=value ...]");
    expect(output).toContain("never pipe a command whose output can carry credentials");
  });
});
