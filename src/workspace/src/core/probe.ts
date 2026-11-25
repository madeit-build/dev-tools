import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DirectoryFacts, Failure, RefKind } from "./facts.ts";
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
// reads the working tree can run a program the repo's own config names.
export const ALLOWED_GIT_ARGS: readonly (readonly string[])[] = [
  COMMON_DIR,
  BRANCH,
  EXACT_TAG,
  SHORT_COMMIT,
  ORIGIN_URL,
];

const CANNOT_START = { code: -1, stdout: "" } as const;
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
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
      },
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
): { origin: DirectoryFacts["origin"]; failures: Failure[] } {
  const result = run(dir, ORIGIN_URL);
  if (result.code !== 0 || result.stdout === "")
    return { origin: null, failures: [] };
  const origin = parseOrigin(result.stdout);
  if (origin) return { origin, failures: [] };
  // The URL is never quoted: it can carry a credential.
  const detail =
    "the origin remote is not a host/owner/name URL, so the repo is named by its folder; check it with git remote -v";
  return { origin: null, failures: [{ source: "origin", detail }] };
}

export function probeDirectory(
  dir: string,
  run: GitRun = runGit,
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
    ...originOf(resolved, safeRun),
  };
}

export function gitCanStart(run: GitRun = runGit): boolean {
  return safely(run)(process.cwd(), COMMON_DIR).code !== -1;
}
