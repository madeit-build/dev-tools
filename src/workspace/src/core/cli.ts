#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gitCanStart, probeDirectory } from "./probe.ts";
import { resolveProject } from "./project.ts";
import { claudeCodeSessionDir, type SessionDir } from "./session.ts";

export type CliIo = {
  out(text: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
};

const USAGE = `madeit-workspace: which project is this work about, and how do we know

Usage:
  madeit-workspace project [--cwd DIR] [--session-dir DIR] [--org ORG]
  madeit-workspace doctor [--cwd DIR]
  madeit-workspace --help

project prints the full resolution as JSON, every layer it considered included.
doctor checks the things most likely to be wrong, in that order, and exits 1 if any fails.

The session's start directory comes from CLAUDE_CODE_SESSION_ID unless --session-dir is given.
CLAUDE_CONFIG_DIR overrides where Claude Code's transcripts are looked for.`;

const EXIT_OK = 0;
const EXIT_CHECK_FAILED = 1;
const EXIT_USAGE = 2;

type Options = {
  cwd?: string;
  "session-dir"?: string;
  org?: string;
  help?: boolean;
};

function sessionFromEnvironment(env: NodeJS.ProcessEnv): SessionDir {
  return claudeCodeSessionDir({
    sessionId: env.CLAUDE_CODE_SESSION_ID ?? "",
    claudeDir: env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME ?? "", ".claude"),
  });
}

function project(options: Options, io: CliIo): number {
  const sessionDir =
    options["session-dir"] ?? sessionFromEnvironment(io.env).dir;
  const resolution = resolveProject({
    cwd: options.cwd ?? io.cwd,
    sessionDir,
    org: options.org,
  });
  io.out(JSON.stringify(resolution, null, 2));
  return EXIT_OK;
}

type Check = { name: string; outcome: "ok" | "fail" | "skip"; detail: string };

// Ordered by how often each is the reason an answer looks wrong.
function checks(cwd: string, env: NodeJS.ProcessEnv): Check[] {
  const facts = probeDirectory(cwd);
  const hasSessionId = (env.CLAUDE_CODE_SESSION_ID ?? "") !== "";
  const session = hasSessionId ? sessionFromEnvironment(env) : null;
  const originFailure = facts.failures.find(
    (failure) => failure.source === "origin",
  );
  const check = (name: string, passed: boolean, detail: string): Check => ({
    name,
    outcome: passed ? "ok" : "fail",
    detail,
  });

  return [
    check("git starts", gitCanStart(), "install git or fix PATH"),
    check(
      "the working directory exists",
      facts.exists,
      "pass --cwd with a directory that exists",
    ),
    check(
      "a session id is in the environment",
      hasSessionId,
      "CLAUDE_CODE_SESSION_ID is unset; run inside a Claude Code session or pass --session-dir to project",
    ),
    session === null
      ? {
          name: "the session's transcript names a start directory",
          outcome: "skip",
          detail: "there is no session id to look up",
        }
      : check(
          "the session's transcript names a start directory",
          session.dir !== null,
          session.detail,
        ),
    check(
      "the origin remote is readable",
      originFailure === undefined,
      originFailure?.detail ?? "",
    ),
  ];
}

function doctor(options: Options, io: CliIo): number {
  const results = checks(options.cwd ?? io.cwd, io.env);
  for (const result of results) {
    if (result.outcome === "ok") io.out(`ok   ${result.name}`);
    else
      io.out(
        `${result.outcome === "fail" ? "FAIL" : "skip"} ${result.name}: ${result.detail}`,
      );
  }
  return results.some((result) => result.outcome === "fail")
    ? EXIT_CHECK_FAILED
    : EXIT_OK;
}

function usage(io: CliIo, code: number): number {
  io.out(code === EXIT_OK ? USAGE : `Usage:\n${USAGE.split("Usage:\n")[1]}`);
  return code;
}

export function main(argv: string[], io: CliIo): number {
  let parsed: { values: Options; positionals: string[] };
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: {
        cwd: { type: "string" },
        "session-dir": { type: "string" },
        org: { type: "string" },
        help: { type: "boolean" },
      },
    });
  } catch {
    return usage(io, EXIT_USAGE);
  }
  if (parsed.values.help) return usage(io, EXIT_OK);
  const [command, ...rest] = parsed.positionals;
  if (rest.length > 0) return usage(io, EXIT_USAGE);
  if (command === "project") return project(parsed.values, io);
  if (command === "doctor") return doctor(parsed.values, io);
  return usage(io, EXIT_USAGE);
}

// realpath because a bin is reached through a symlink; a failure only means this module was imported, not run.
function isDirectEntrypoint(invokedPath: string | undefined): boolean {
  if (!invokedPath) return false;
  try {
    return fs.realpathSync(invokedPath) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectEntrypoint(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2), {
    out: (text) => console.log(text),
    env: process.env,
    cwd: process.cwd(),
  });
}
