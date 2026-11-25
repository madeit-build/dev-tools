import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_HOSTS,
  type DirectoryFacts,
  type Failure,
  type RefKind,
} from "./facts.ts";
import { parseOrigin } from "./origin.ts";

export type GitRun = (
  dir: string,
  args: readonly string[],
) => { code: number; stdout: string };

const COMMON_DIR = [
  "rev-parse",
  "--path-format=absolute",
  "--git-common-dir",
] as const;
const BRANCH = ["symbolic-ref", "--quiet", "--short", "HEAD"] as const;
const EXACT_TAG = ["describe", "--tags", "--exact-match", "HEAD"] as const;
const SHORT_COMMIT = ["rev-parse", "--short", "HEAD"] as const;
const ORIGIN_URL = ["config", "--get", "remote.origin.url"] as const;

// The directory is often an untrusted clone. These read refs and config only; a command that
// reads the working tree can run a program the repo's own config names. The list limits the
// arguments, not what git does with them: HARDENING below is what stops the rest.
export const ALLOWED_GIT_ARGS: readonly (readonly string[])[] = [
  COMMON_DIR,
  BRANCH,
  EXACT_TAG,
  SHORT_COMMIT,
  ORIGIN_URL,
];

const CANNOT_START = { code: -1, stdout: "" } as const;

// Settings that outrank the repo's own config. Without them an allowed command can still run a
// repo-named program: a missing object in a promisor repo is fetched on demand, through a shell.
const HARDENING: readonly (readonly [string, string])[] = [
  ["safe.bareRepository", "explicit"],
  ["protocol.allow", "never"],
  ["core.fsmonitor", "false"],
];

// The caller's GIT_* variables are dropped: under a git hook, GIT_DIR would point every probe at the hook's repo.
function gitEnvironment(): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(
    ([name]) => !name.startsWith("GIT_"),
  );
  const hardening = HARDENING.flatMap(([key, value], i) => [
    [`GIT_CONFIG_KEY_${i}`, key],
    [`GIT_CONFIG_VALUE_${i}`, value],
  ]);
  return {
    ...Object.fromEntries(inherited),
    ...Object.fromEntries(hardening),
    GIT_CONFIG_COUNT: String(HARDENING.length),
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}
const GIT_TIMEOUT_MS = 2000;

function isAllowed(args: readonly string[]): boolean {
  return ALLOWED_GIT_ARGS.some(
    (allowed) => allowed.length === args.length
                 && allowed.every((arg, i) => arg === args[i]),
  );
}

export const runGit: GitRun = (dir, args) => {
  if (!isAllowed(args)) return CANNOT_START;
  try {
    const stdout = execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      // Not the caller's working directory, which may have been removed.
      cwd: os.tmpdir(),
      env: gitEnvironment(),
    });
    return { code: 0, stdout: stdout.trim() };
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number"
      ? { code: status, stdout: "" }
      : CANNOT_START;
  }
};

function safely(run: GitRun): GitRun {
  return (dir, args) => {
    try {
      return run(dir, args);
    } catch {
      return CANNOT_START;
    }
  };
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// A bare repo's common dir is the repo itself; every other repo keeps it in a .git folder.
function repoFolderOf(commonDir: string): string {
  const base = path.basename(commonDir);
  if (base === ".git") return path.basename(path.dirname(commonDir));
  return base.endsWith(".git") ? base.slice(0, -4) : base;
}

function refOf(
  dir: string,
  run: GitRun,
): { ref: string | null; refKind: RefKind | null } {
  const attempts: [readonly string[], RefKind][] = [
    [BRANCH, "branch"],
    [EXACT_TAG, "tag"],
    [SHORT_COMMIT, "commit"],
  ];
  for (const [args, refKind] of attempts) {
    const result = run(dir, args);
    if (result.code === 0 && result.stdout !== "")
      return { ref: result.stdout, refKind };
  }
  return { ref: null, refKind: null };
}

function originOf(
  dir: string,
  run: GitRun,
  hosts: readonly string[],
): { origin: DirectoryFacts["origin"]; failures: Failure[] } {
  const failed = (detail: string) => ({
    origin: null,
    failures: [{ source: "origin" as const, detail }],
  });
  const result = run(dir, ORIGIN_URL);
  if (result.code === -1) {
    return failed(
      "git did not answer when asked for the origin remote, so the repo is named by its folder; run madeit-workspace doctor",
    );
  }
  if (result.code !== 0 || result.stdout === "")
    return { origin: null, failures: [] };
  const origin = parseOrigin(result.stdout, hosts);
  if (origin) return { origin, failures: [] };
  // The URL is never quoted: it can carry a credential.
  return failed(
    "the origin remote is not a host/owner/name URL this package reads, so the repo is named by its folder; an ssh host alias must be passed as a host",
  );
}

export function probeDirectory(
  dir: string,
  run: GitRun = runGit,
  hosts: readonly string[] = DEFAULT_HOSTS,
): DirectoryFacts {
  const resolved = path.resolve(dir);
  const folder = path.basename(resolved);
  const facts: DirectoryFacts = {
    path: resolved,
    exists: true,
    folder,
    commonDir: null,
    repoFolder: null,
    origin: null,
    ref: null,
    refKind: null,
    failures: [],
  };
  if (!isDirectory(resolved)) {
    return {
      ...facts,
      exists: false,
      failures: [
        {
          source: "git-common-dir",
          detail: `${folder} does not exist; pass a directory that does`,
        },
      ],
    };
  }

  const safeRun = safely(run);
  const common = safeRun(resolved, COMMON_DIR);
  if (common.code === -1) {
    const detail =
      "git could not start or timed out, so only the folder name is known; install git or fix PATH";
    return { ...facts, failures: [{ source: "git-common-dir", detail }] };
  }
  if (common.code !== 0 || common.stdout === "") return facts;

  return {
    ...facts,
    commonDir: common.stdout,
    repoFolder: repoFolderOf(common.stdout),
    ...refOf(resolved, safeRun),
    ...originOf(resolved, safeRun, hosts),
  };
}

export function gitCanStart(run: GitRun = runGit): boolean {
  return safely(run)(os.tmpdir(), COMMON_DIR).code !== -1;
}
