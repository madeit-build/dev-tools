import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ALLOWED_GIT_ARGS,
  probeDirectory,
  runGit,
  type GitRun,
} from "./probe.ts";
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
      path: dir,
      exists: true,
      folder: "on-branch",
      commonDir: path.join(dir, ".git"),
      repoFolder: "on-branch",
      origin: null,
      ref: "main",
      refKind: "branch",
      failures: [],
    });
  });

  it("a subdirectory of a repo reports the repo", () => {
    const dir = makeRepo(root, "with-subdir");
    const sub = path.join(dir, "deep", "er");
    fs.mkdirSync(sub, { recursive: true });
    expect(probeDirectory(sub)).toMatchObject({
      folder: "er",
      repoFolder: "with-subdir",
      ref: "main",
    });
  });

  it("a worktree reports its repo", () => {
    const dir = makeRepo(root, "main-checkout");
    const worktree = path.join(root, "main-checkout-worktrees", "feature");
    git(dir, "worktree", "add", "-q", worktree, "-b", "feat/thing");
    expect(probeDirectory(worktree)).toMatchObject({
      folder: "feature",
      commonDir: path.join(dir, ".git"),
      repoFolder: "main-checkout",
      ref: "feat/thing",
      refKind: "branch",
    });
  });

  it("a detached tag", () => {
    const dir = makeRepo(root, "at-tag");
    git(dir, "tag", "v1.2.3");
    git(dir, "checkout", "-q", "--detach", "v1.2.3");
    expect(probeDirectory(dir)).toMatchObject({
      ref: "v1.2.3",
      refKind: "tag",
    });
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
    expect(probeDirectory(dir)).toMatchObject({
      repoFolder: "no-commits",
      ref: "main",
      refKind: "branch",
      failures: [],
    });
  });

  it("a foreign origin", () => {
    const dir = makeRepo(root, "gufo-v0.35.0", {
      origin: "https://github.com/gufo-org/gufo",
    });
    expect(probeDirectory(dir).origin).toEqual({
      host: "github.com",
      owner: "gufo-org",
      name: "gufo",
    });
  });

  it("an origin carrying a credential never surfaces it", () => {
    const dir = makeRepo(root, "with-credential", {
      origin:
        "https://someuser:s3cr3tvalue@github.com/madeit-build/example.git",
    });
    const facts = probeDirectory(dir);
    expect(facts.origin).toEqual({
      host: "github.com",
      owner: "madeit-build",
      name: "example",
    });
    expect(JSON.stringify(facts)).not.toContain("s3cr3tvalue");
    expect(JSON.stringify(facts)).not.toContain("someuser");
  });

  it("an unparseable origin is a failure that does not quote it", () => {
    const dir = makeRepo(root, "local-origin", {
      origin: "/srv/git/s3cr3tplace.git",
    });
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
      path: dir,
      exists: true,
      folder: "plain",
      commonDir: null,
      repoFolder: null,
      origin: null,
      ref: null,
      refKind: null,
      failures: [],
    });
  });

  it("a directory that does not exist", () => {
    const facts = probeDirectory(path.join(root, "never-made"));
    expect(facts).toMatchObject({
      exists: false,
      folder: "never-made",
      commonDir: null,
      ref: null,
    });
    expect(facts.failures).toEqual([
      {
        source: "git-common-dir",
        detail: "never-made does not exist; pass a directory that does",
      },
    ]);
  });

  it("a file is not a directory", () => {
    const file = path.join(root, "a-file");
    fs.writeFileSync(file, "");
    expect(probeDirectory(file)).toMatchObject({
      exists: false,
      folder: "a-file",
    });
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
    const tagged = makeRepo(root, "recorded", {
      origin: "https://github.com/gufo-org/gufo",
    });
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

describe("a hostile repository", () => {
  // git fetches a missing object from a promisor remote on demand, and runs the remote's
  // uploadpack setting through a shell to do it. An allowed command can trigger that.
  it("cannot make the probe run a program through a lazy fetch", () => {
    const upstream = makeRepo(root, "lazy-upstream");
    const marker = path.join(root, "lazy-marker");
    const dir = makeRepo(root, "lazy-hostile", { commit: false });
    const missing = "1234567890abcdef1234567890abcdef12345678";
    git(dir, "config", "extensions.partialClone", "origin");
    git(dir, "config", "remote.origin.url", upstream);
    git(dir, "config", "remote.origin.promisor", "true");
    git(
      dir,
      "config",
      "remote.origin.uploadpack",
      `touch ${marker}; git-upload-pack`,
    );
    fs.mkdirSync(path.join(dir, ".git", "refs", "tags"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".git", "refs", "tags", "v1"),
      `${missing}\n`,
    );
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), `${missing}\n`);
    probeDirectory(dir);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("a bare repo planted inside a clone is not believed over the clone", () => {
    const host = makeRepo(root, "plant-host");
    const planted = path.join(host, "vendor", "x");
    fs.mkdirSync(planted, { recursive: true });
    git(planted, "init", "-q", "--bare");
    git(
      planted,
      "config",
      "remote.origin.url",
      "https://github.com/madeit-build/box.provisioning",
    );
    const facts = probeDirectory(planted);
    // git refuses the planted repo outright instead of looking further up, so the folder is all we report.
    expect(facts).toMatchObject({
      origin: null,
      commonDir: null,
      folder: "x",
      failures: [],
    });
  });
});

describe("the caller's environment", () => {
  const KEYS = ["PATH", "GIT_DIR", "GIT_WORK_TREE"] as const;
  const saved = KEYS.map((key) => [key, process.env[key]] as const);
  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("an inherited GIT_DIR does not redirect the probe", () => {
    const other = makeRepo(root, "env-other", {
      origin: "https://github.com/madeit-build/seaboard.git",
    });
    const plain = path.join(root, "env-plain");
    fs.mkdirSync(plain);
    process.env.GIT_DIR = path.join(other, ".git");
    process.env.GIT_WORK_TREE = other;
    expect(probeDirectory(plain)).toMatchObject({
      commonDir: null,
      origin: null,
    });
  });

  it("git missing from PATH is code -1 from the real runner", () => {
    process.env.PATH = "";
    expect(runGit(root, ALLOWED_GIT_ARGS[0])).toEqual({ code: -1, stdout: "" });
  });
});

describe("a lookup that fails partway", () => {
  it("an origin lookup that times out is a failure, not a missing remote", () => {
    const dir = makeRepo(root, "origin-timeout", {
      origin: "https://github.com/madeit-build/seaboard.git",
    });
    const flaky: GitRun = (cwd, args) =>
      args[0] === "config" ? { code: -1, stdout: "" } : runGit(cwd, args);
    const facts = probeDirectory(dir, flaky);
    expect(facts.origin).toBeNull();
    expect(facts.failures.map((failure) => failure.source)).toEqual(["origin"]);
  });

  it("passes host aliases through to the origin parser", () => {
    const dir = makeRepo(root, "aliased", {
      origin: "gh:madeit-build/box.provisioning",
    });
    expect(probeDirectory(dir).origin).toBeNull();
    expect(
      probeDirectory(dir, runGit, ["github.com", "gh"]).origin,
    ).toMatchObject({ host: "gh", name: "box.provisioning" });
  });
});
