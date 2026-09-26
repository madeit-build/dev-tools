import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

// MADEIT_LOG_SINK from the outer test run must never leak into a subprocess
// meant to exercise the CLI's own default.
function subprocessEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.MADEIT_LOG_SINK;
  return { ...env, ...overrides };
}

describe("cli bin entrypoint, run as a subprocess through a symlink", () => {
  it("emits a valid record and exits 0 when invoked through a symlink, npm .bin style", () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "madeit-log-bin-"));
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
});

describe("process-level stream errors, at the entrypoint (subprocess repros)", () => {
  // Concrete repro (Task 3 review): a slow downstream reader lets the tee
  // target's pipe buffer fill, forcing a drain wait, then the reader exits
  // after only a few bytes. Node reports the resulting EPIPE on process.stdout
  // asynchronously, after runPipe's own tee guard has already been torn down,
  // and an unhandled 'error' event crashes the process even though main
  // already resolved 0.
  it("pipe --tee resolves 0 even when the downstream reader closes early (EPIPE)", () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "madeit-log-epipe-in-"));
    const inputPath = path.join(inputDir, "input.txt");
    const lineText = "x".repeat(48);
    const lines: string[] = [];
    let bytes = 0;
    while (bytes < 70_000) {
      lines.push(lineText);
      bytes += lineText.length + 1;
    }
    fs.writeFileSync(inputPath, `${lines.join("\n")}\n`);

    const sinkDir = fs.mkdtempSync(path.join(os.tmpdir(), "madeit-log-epipe-sink-"));
    const sinkFile = path.join(sinkDir, "out.jsonl");

    const script = [
      "set -o pipefail",
      `node ${JSON.stringify(cliDistPath)} pipe build.output --tee < ${JSON.stringify(inputPath)} | (sleep 2; head -c 10) > /dev/null`,
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
    expect(records.length).toBe(lines.length);
  }, 20_000);

  // Concrete repro (Task 3 review): the default sink is stderr, and a caller
  // that closes fd 2 before invoking madeit-log must still see exit 0, not a
  // crash from writing to a closed file descriptor.
  it("exits 0 when stderr is closed (2>&-) and the default sink is stderr", () => {
    const script = `node ${JSON.stringify(cliDistPath)} info probe.x hi 2>&-`;
    const result = spawnSync("bash", ["-c", script], {
      env: subprocessEnv(),
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  }, 10_000);
});
