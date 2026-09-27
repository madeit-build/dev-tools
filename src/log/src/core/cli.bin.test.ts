import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { LogRecord } from "./record.ts";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const cliDistPath = path.join(packageRoot, "dist", "cli.js");

const schema = JSON.parse(
  fs.readFileSync(new URL("../../schema/madeit-log-v1.json", import.meta.url), "utf8"),
);
const validate = new Ajv2020({ strict: false }).compile(schema);

beforeAll(() => {
  execFileSync("pnpm", ["run", "build"], { cwd: packageRoot, stdio: "inherit" });
}, 60_000);

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// MADEIT_LOG_SINK from the outer test run must never leak into a subprocess
// meant to exercise the CLI's own default.
function subprocessEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.MADEIT_LOG_SINK;
  return { ...env, ...overrides };
}

describe("cli bin entrypoint, run as a subprocess through a symlink", () => {
  it("emits a valid record and exits 0 when invoked through a symlink, npm .bin style", () => {
    const binDir = makeTempDir("madeit-log-bin-");
    const symlinkPath = path.join(binDir, "madeit-log");
    fs.symlinkSync(cliDistPath, symlinkPath);

    const eventResult = spawnSync(process.execPath, [symlinkPath, "info", "probe.bin", "hi"], {
      env: subprocessEnv(),
      encoding: "utf8",
    });
    expect(eventResult.status, eventResult.stderr).toBe(0);
    const record = JSON.parse(eventResult.stderr.trim()) as LogRecord;
    expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
    expect(record.Body).toBe("hi");

    const misuseResult = spawnSync(process.execPath, [symlinkPath, "shout"], {
      env: subprocessEnv(),
      encoding: "utf8",
    });
    expect(misuseResult.status, misuseResult.stderr).toBe(0);
    const misuseRecord = JSON.parse(misuseResult.stderr.trim()) as LogRecord;
    expect(misuseRecord.Attributes["madeit.event"]).toBe("log.meta");
  });

  it("keeps the shebang as the first line of dist/cli.js", () => {
    const firstLine = fs.readFileSync(cliDistPath, "utf8").split("\n")[0];
    expect(firstLine).toBe("#!/usr/bin/env node");
  });

  // fs.realpathSync throws for a path that does not exist. A script fed on
  // stdin, or any other caller of this module with an unrelated argv[1],
  // must not crash the import; it must just mean "not the entrypoint".
  it("stays inert, printing nothing, when argv[1] names a path that does not exist", () => {
    const importScript = `import(${JSON.stringify(pathToFileURL(cliDistPath).href)})`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", importScript, "/does/not/exist"],
      { env: subprocessEnv(), encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});

describe("process-level stream errors, at the entrypoint (subprocess repros)", () => {
  // A downstream reader that never reads anything lets the tee target's pipe
  // buffer fill and then close, making the resulting EPIPE unconditional and
  // reportable as this tee's own log.meta. A reader that consumes even a few
  // bytes first (e.g. `head -c 10`) can free enough capacity for the rest to
  // flush before it exits, turning the outcome into a race on some platforms.
  it("pipe --tee resolves 0, does not crash, and reports exactly one tee failure when the downstream reader exits without reading", () => {
    const inputDir = makeTempDir("madeit-log-epipe-in-");
    const inputPath = path.join(inputDir, "input.txt");
    const lineText = "x".repeat(48);
    const lines: string[] = [];
    let bytes = 0;
    while (bytes < 200_000) {
      lines.push(lineText);
      bytes += lineText.length + 1;
    }
    fs.writeFileSync(inputPath, `${lines.join("\n")}\n`);

    const sinkDir = makeTempDir("madeit-log-epipe-sink-");
    const sinkFile = path.join(sinkDir, "out.jsonl");

    const script = [
      "set -o pipefail",
      `${JSON.stringify(process.execPath)} ${JSON.stringify(cliDistPath)} pipe build.output --tee < ${JSON.stringify(inputPath)} | (sleep 2) > /dev/null`,
      'echo "MADEIT_EXIT:${PIPESTATUS[0]}"',
    ].join("\n");

    const result = spawnSync("bash", ["-c", script], {
      env: subprocessEnv({ MADEIT_LOG_SINK: `file:${sinkFile}` }),
      encoding: "utf8",
    });

    expect(result.stdout, result.stderr).toContain("MADEIT_EXIT:0");
    expect(result.stderr).not.toContain("Unhandled 'error' event");

    const records = fs
      .readFileSync(sinkFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as LogRecord);
    const lineRecords = records.filter((record) => record.Attributes["madeit.event"] !== "log.meta");
    const metaRecords = records.filter((record) => record.Attributes["madeit.event"] === "log.meta");
    expect(lineRecords.length).toBe(lines.length);
    expect(metaRecords).toHaveLength(1);
    expect(String(metaRecords[0]?.Attributes["madeit.cli_error"])).toMatch(/EPIPE|closed/);
  }, 20_000);
});

describe("pipe misuse drains stdin so an upstream producer never sees SIGPIPE (subprocess)", () => {
  function writeLargeInput(): string {
    const dir = makeTempDir("madeit-log-sigpipe-in-");
    const inputPath = path.join(dir, "input.bin");
    const lineText = "x".repeat(48);
    const lines: string[] = [];
    let bytes = 0;
    while (bytes < 200_000) {
      lines.push(lineText);
      bytes += lineText.length + 1;
    }
    fs.writeFileSync(inputPath, `${lines.join("\n")}\n`);
    return inputPath;
  }

  it("a large producer piped into a misused pipe call exits 0, and no bytes reach stdout without --tee", () => {
    const inputPath = writeLargeInput();
    const outDir = makeTempDir("madeit-log-sigpipe-out-");
    const outPath = path.join(outDir, "out.bin");

    const script = [
      "set -o pipefail",
      `cat ${JSON.stringify(inputPath)} | ${JSON.stringify(process.execPath)} ${JSON.stringify(cliDistPath)} pipe build.output --steam stderr > ${JSON.stringify(outPath)}`,
      'echo "PRODUCER_EXIT:${PIPESTATUS[0]} MADEIT_EXIT:${PIPESTATUS[1]}"',
    ].join("\n");

    const result = spawnSync("bash", ["-c", script], { env: subprocessEnv(), encoding: "utf8" });

    expect(result.stdout, result.stderr).toContain("PRODUCER_EXIT:0 MADEIT_EXIT:0");
    expect(fs.statSync(outPath).size).toBe(0);
  }, 20_000);

  it("a large producer piped into a misused pipe call with --tee exits 0, and the bytes pass through exactly", () => {
    const inputPath = writeLargeInput();
    const outDir = makeTempDir("madeit-log-sigpipe-out-");
    const outPath = path.join(outDir, "out.bin");

    const script = [
      "set -o pipefail",
      `cat ${JSON.stringify(inputPath)} | ${JSON.stringify(process.execPath)} ${JSON.stringify(cliDistPath)} pipe --tee > ${JSON.stringify(outPath)}`,
      'echo "PRODUCER_EXIT:${PIPESTATUS[0]} MADEIT_EXIT:${PIPESTATUS[1]}"',
    ].join("\n");

    const result = spawnSync("bash", ["-c", script], { env: subprocessEnv(), encoding: "utf8" });

    expect(result.stdout, result.stderr).toContain("PRODUCER_EXIT:0 MADEIT_EXIT:0");
    expect(fs.readFileSync(outPath).equals(fs.readFileSync(inputPath))).toBe(true);
  }, 20_000);
});
