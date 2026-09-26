import { describe, expect, it, vi } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
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
        expect(value).not.toBeUndefined();
      }
    });
  }

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

  // Review Focus 1: a sink that throws inside main (here, fileSink's directory
  // creation failing because a path segment is an ordinary file) must not stop main
  // from resolving 0.
  it("resolves 0 when the chosen file sink's directory cannot be created", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "cli-"));
    const blocker = path.join(parent, "blocker");
    fs.writeFileSync(blocker, "not a directory");
    const target = path.join(blocker, "nested", "out.jsonl");
    const exitCode = await main(
      ["info", "probe.hello", "hi"],
      { ...baseEnv, MADEIT_LOG_SINK: `file:${target}` },
      fakeIo(),
    );
    expect(exitCode).toBe(0);
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
