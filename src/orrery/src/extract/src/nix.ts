import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type NixErrorKind =
  | "missing-attr"
  | "not-serializable"
  | "bad-flake-ref"
  | "nix-not-found"
  | "timeout"
  | "eval-error";

export class NixError extends Error {
  constructor(
    readonly kind: NixErrorKind,
    message: string,
    readonly attrPath: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "NixError";
  }
}

// Matched against real nix stderr, captured 2026-08-21 rather than recalled.
// Order matters: the first hit wins, so specific patterns sit above general.
//
// The absent-attribute case is the one worth reading carefully. Nix does NOT
// say "attribute 'x' missing" for a flake output; it says the flake "does not
// provide attribute 'packages.<system>.x', 'legacyPackages.<system>.x' or 'x'".
// Classifying that phrase as a bad flake ref would make every Linux-only flake
// (no darwinConfigurations) fail discovery instead of skipping the attribute.
const PATTERNS: ReadonlyArray<[RegExp, NixErrorKind]> = [
  [/does not provide attribute|attribute '[^']+' missing/i, "missing-attr"],
  [/cannot coerce|is not allowed to refer to|derivationStrict/i, "not-serializable"],
  [/cannot find flake|unable to download|Could not find source file|getting status of/i, "bad-flake-ref"],
];

export function classifyNixError(stderr: string): NixErrorKind {
  for (const [re, kind] of PATTERNS) if (re.test(stderr)) return kind;
  return "eval-error";
}

// Both flags on every call. Evaluating a flake can otherwise rewrite
// flake.lock, and a tool that dirties the tree it inspects is a defect.
export function buildEvalArgs(flakeRef: string, attrPath: string, apply: string | undefined): string[] {
  const args = ["eval", "--json", "--read-only", "--no-write-lock-file", `${flakeRef}#${attrPath}`];
  if (apply) args.push("--apply", apply);
  return args;
}

export interface EvalOptions {
  timeoutMs?: number;
  cwd?: string;
}

const DEFAULT_TIMEOUT_MS = 300_000;
// A full systemd.services projection on the real box returns well over a
// megabyte, so the default 1MB execFile buffer is not enough.
const MAX_BUFFER = 64 * 1024 * 1024;

export async function nixEval<T>(
  flakeRef: string,
  attrPath: string,
  apply?: string,
  opts: EvalOptions = {},
): Promise<T> {
  const args = buildEvalArgs(flakeRef, attrPath, apply);
  try {
    const { stdout } = await run("nix", args, {
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      cwd: opts.cwd,
    });
    return JSON.parse(stdout) as T;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (e.code === "ENOENT") {
      throw new NixError("nix-not-found", "nix is not on PATH", attrPath, "");
    }
    if (e.killed) {
      throw new NixError("timeout", `evaluation of ${attrPath} timed out`, attrPath, e.stderr ?? "");
    }
    const stderr = e.stderr ?? "";
    throw new NixError(classifyNixError(stderr), `evaluation of ${attrPath} failed`, attrPath, stderr);
  }
}

// For attributes that legitimately may not exist. A flake with no Macs has no
// darwinConfigurations, and that is not an error.
export async function nixEvalOptional<T>(
  flakeRef: string,
  attrPath: string,
  apply?: string,
  opts: EvalOptions = {},
): Promise<T | null> {
  try {
    return await nixEval<T>(flakeRef, attrPath, apply, opts);
  } catch (err) {
    if (err instanceof NixError && err.kind === "missing-attr") return null;
    throw err;
  }
}

export interface FlakeMetadata {
  description?: string;
  locks: { nodes: Record<string, { inputs?: Record<string, string | string[]> }> };
}

// nix flake metadata does NOT accept --read-only. Verified 2026-08-21 against
// `nix flake metadata --help`. Do not share a flag builder with nixEval.
export async function flakeMetadata(flakeRef: string, opts: EvalOptions = {}): Promise<FlakeMetadata> {
  const args = ["flake", "metadata", "--json", "--no-write-lock-file", flakeRef];
  try {
    const { stdout } = await run("nix", args, {
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      cwd: opts.cwd,
    });
    return JSON.parse(stdout) as FlakeMetadata;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") throw new NixError("nix-not-found", "nix is not on PATH", "<metadata>", "");
    throw new NixError(classifyNixError(e.stderr ?? ""), "flake metadata failed", "<metadata>", e.stderr ?? "");
  }
}
