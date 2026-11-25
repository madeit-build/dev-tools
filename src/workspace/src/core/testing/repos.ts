import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"];

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...IDENTITY, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// realpath because git reports resolved paths and macOS's temp directory is a symlink.
export function tempDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "madeit-workspace-")));
}

export function makeRepo(parent: string, name: string, options: { commit?: boolean; origin?: string } = {}): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  if (options.commit !== false) git(dir, "commit", "-q", "--allow-empty", "-m", "first");
  if (options.origin) git(dir, "remote", "add", "origin", options.origin);
  return dir;
}
