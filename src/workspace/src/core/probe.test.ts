import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALLOWED_GIT_ARGS, probeDirectory, runGit, type GitRun } from "./probe.ts";
import { git, makeRepo, tempDir } from "./testing/repos.ts";

let root: string;
beforeAll(() => {
  root = tempDir();
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("probeDirectory against real repositories", () => {
  it("a clone on a branch", () => {
    const dir = makeRepo(root, "on-branch");
    expect(probeDirectory(dir)).toEqual({
      path: dir, exists: true, folder: "on-branch", commonDir: path.join(dir, ".git"), repoFolder: "on-branch",
      origin: null, ref: "main", refKind: "branch", failures: [],
    });
  });

  it("a subdirectory of a repo reports the repo", () => {
    const dir = makeRepo(root, "with-subdir");
    const sub = path.join(dir, "deep", "er");
    fs.mkdirSync(sub, { recursive: true });
    expect(probeDirectory(sub)).toMatchObject({ folder: "er", repoFolder: "with-subdir", ref: "main" });
  });

  it("a worktree reports its repo", () => {
    const dir = makeRepo(root, "main-checkout");
    const worktree = path.join(root, "main-checkout-worktrees", "feature");
    git(dir, "worktree", "add", "-q", worktree, "-b", "feat/thing");
    expect(probeDirectory(worktree)).toMatchObject({
      folder: "feature", commonDir: path.join(dir, ".git"), repoFolder: "main-checkout", ref: "feat/thing", refKind: "branch",
    });
  });

  it("a detached tag", () => {
    const dir = makeRepo(root, "at-tag");
    git(dir, "tag", "v1.2.3");
    git(dir, "checkout", "-q", "--detach", "v1.2.3");
    expect(probeDirectory(dir)).toMatchObject({ ref: "v1.2.3", refKind: "tag" });
  });

  it("a detached commit", () => {
    const dir = makeRepo(root, "at-commit");
    git(dir, "checkout", "-q", "--detach");
    const facts = probeDirectory(dir);
    expect(facts.refKind).toBe("commit");
    expect(facts.ref).toMatch(/^[0-9a-f]{7,}$/);
  });

  it("a repo with no commits", () => {
    const dir = makeRepo(root, "no-commits", { commit: false });
    expect(probeDirectory(dir)).toMatchObject({ repoFolder: "no-commits", ref: "main", refKind: "branch", failures: [] });
  });

  it("a foreign origin", () => {
    const dir = makeRepo(root, "gufo-v0.35.0", { origin: "https://github.com/gufo-org/gufo" });
    expect(probeDirectory(dir).origin).toEqual({ owner: "gufo-org", name: "gufo" });
  });

  it("an origin carrying a credential never surfaces it", () => {
    const dir = makeRepo(root, "with-credential", { origin: "https://someuser:s3cr3tvalue@github.com/madeit-build/example.git" });
    const facts = probeDirectory(dir);
    expect(facts.origin).toEqual({ owner: "madeit-build", name: "example" });
    expect(JSON.stringify(facts)).not.toContain("s3cr3tvalue");
    expect(JSON.stringify(facts)).not.toContain("someuser");
  });

  it("an unparseable origin is a failure that does not quote it", () => {
    const dir = makeRepo(root, "local-origin", { origin: "/srv/git/s3cr3tplace.git" });
    const facts = probeDirectory(dir);
    expect(facts.origin).toBeNull();
    expect(facts.failures).toHaveLength(1);
    expect(facts.failures[0].source).toBe("origin");
    expect(JSON.stringify(facts)).not.toContain("s3cr3tplace");
  });

  it("a plain folder", () => {
    const dir = path.join(root, "plain");
    fs.mkdirSync(dir);
    expect(probeDirectory(dir)).toEqual({
      path: dir, exists: true, folder: "plain", commonDir: null, repoFolder: null, origin: null, ref: null, refKind: null, failures: [],
    });
  });

  it("a directory that does not exist", () => {
    const facts = probeDirectory(path.join(root, "never-made"));
    expect(facts).toMatchObject({ exists: false, folder: "never-made", commonDir: null, ref: null });
    expect(facts.failures).toEqual([{ source: "git-common-dir", detail: "never-made does not exist; pass a directory that does" }]);
  });

  it("a file is not a directory", () => {
    const file = path.join(root, "a-file");
    fs.writeFileSync(file, "");
    expect(probeDirectory(file)).toMatchObject({ exists: false, folder: "a-file" });
  });
});

describe("the git runner", () => {
  it("git that cannot start is one failure, not five", () => {
    const calls: string[] = [];
    const broken: GitRun = (_dir, args) => {
      calls.push(args.join(" "));
      return { code: -1, stdout: "" };
    };
    const dir = makeRepo(root, "git-missing");
    const facts = probeDirectory(dir, broken);
    expect(calls).toHaveLength(1);
    expect(facts.commonDir).toBeNull();
    expect(facts.failures).toHaveLength(1);
    expect(facts.failures[0].detail).toContain("PATH");
  });

  it("a runner that throws is treated as git that cannot start", () => {
    const dir = makeRepo(root, "git-throws");
    const facts = probeDirectory(dir, () => {
      throw new Error("boom");
    });
    expect(facts.failures[0].detail).toContain("PATH");
  });

  it("only ever passes the five allowed argument lists", () => {
    const seen = new Set<string>();
    const recording: GitRun = (dir, args) => {
      seen.add(args.join(" "));
      return runGit(dir, args);
    };
    const tagged = makeRepo(root, "recorded", { origin: "https://github.com/gufo-org/gufo" });
    git(tagged, "tag", "v9");
    git(tagged, "checkout", "-q", "--detach", "v9");
    probeDirectory(tagged, recording);
    git(tagged, "commit", "-q", "--allow-empty", "-m", "second");
    probeDirectory(tagged, recording);
    probeDirectory(path.join(root, "plain"), recording);
    const allowed = new Set(ALLOWED_GIT_ARGS.map((args) => args.join(" ")));
    expect([...seen].filter((args) => !allowed.has(args))).toEqual([]);
    expect(seen.size).toBe(5);
  });

  it("refuses an argument list that is not allowed", () => {
    expect(runGit(root, ["status"])).toEqual({ code: -1, stdout: "" });
  });
});
