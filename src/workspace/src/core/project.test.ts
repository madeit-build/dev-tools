import fs from "node:fs";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveProject, type ProjectResolution } from "./project.ts";
import { git, makeRepo, tempDir } from "./testing/repos.ts";

const schema = JSON.parse(
  fs.readFileSync(
    new URL("../../schema/madeit-workspace-project-v1.json", import.meta.url),
    "utf8",
  ),
);
const validate = new Ajv2020({ strict: false }).compile(schema);

let root: string;
let ours: string;
let foreign: string;
const seen: ProjectResolution[] = [];
const resolve = (
  ...args: Parameters<typeof resolveProject>
): ProjectResolution => {
  const resolution = resolveProject(...args);
  seen.push(resolution);
  return resolution;
};

beforeAll(() => {
  root = tempDir();
  ours = makeRepo(root, "box.provisioning", {
    origin: "https://github.com/madeit-build/box.provisioning.git",
  });
  foreign = makeRepo(path.join(root, "scratchpad", "src"), "gufo-v0.35.0", {
    origin: "https://github.com/gufo-org/gufo",
  });
  git(foreign, "tag", "v0.35.0");
  git(foreign, "checkout", "-q", "--detach", "v0.35.0");
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveProject", () => {
  it("the 2026-11-24 case: a foreign clone at a tag, in a session that started in our repo", () => {
    const resolution = resolve({ cwd: foreign, sessionDir: ours });
    expect(resolution.display).toBe(
      "box.provisioning on branch main, while inside a clone of gufo-org/gufo at tag v0.35.0",
    );
    expect(resolution).toMatchObject({
      project: "box.provisioning",
      source: "session",
      sessionSource: "origin",
      ours: true,
    });
  });

  it("the same clone with no session is named as not ours", () => {
    expect(resolve({ cwd: foreign }).display).toBe(
      "gufo-org/gufo at tag v0.35.0 (not one of ours)",
    );
  });

  it("a worktree of ours names the repo, not the worktree folder", () => {
    const worktree = path.join(
      root,
      "box.provisioning-worktrees",
      "caretaker-scrub-paths",
    );
    git(
      ours,
      "worktree",
      "add",
      "-q",
      worktree,
      "-b",
      "fix/caretaker-scrub-paths",
    );
    expect(resolve({ cwd: worktree }).display).toBe(
      "box.provisioning on branch fix/caretaker-scrub-paths",
    );
  });

  it("a cwd that does not exist falls back to its folder name", () => {
    const resolution = resolve({ cwd: path.join(root, "removed-worktree") });
    expect(resolution).toMatchObject({
      project: "removed-worktree",
      source: "folder",
    });
    expect(
      resolution.layers.filter((layer) => layer.outcome === "failed"),
    ).toHaveLength(1);
  });

  it("a session directory that no longer exists is a failed layer and the cwd is judged alone", () => {
    const resolution = resolve({
      cwd: foreign,
      sessionDir: path.join(root, "gone"),
    });
    expect(resolution).toMatchObject({
      project: "gufo-org/gufo",
      source: "origin",
      context: null,
    });
    expect(
      resolution.layers.filter(
        (layer) => layer.where === "session" && layer.outcome === "failed",
      ),
    ).toHaveLength(1);
  });

  it("an empty or null session directory is the same as none", () => {
    expect(
      resolve({ cwd: ours, sessionDir: null }).layers.some(
        (layer) => layer.where === "session",
      ),
    ).toBe(false);
    expect(
      resolve({ cwd: ours, sessionDir: "" }).layers.some(
        (layer) => layer.where === "session",
      ),
    ).toBe(false);
  });

  it("never throws when the runner throws", () => {
    const resolution = resolve({ cwd: ours }, () => {
      throw new Error("boom");
    });
    expect(resolution).toMatchObject({
      project: "box.provisioning",
      source: "folder",
    });
  });

  it("never throws on input that is not a string", () => {
    const resolution = resolve({ cwd: undefined as unknown as string });
    expect(resolution.source).toBe("folder");
    expect(resolution.layers.some((layer) => layer.outcome === "failed")).toBe(
      true,
    );
  });

  it("org is an input", () => {
    expect(resolve({ cwd: foreign, org: "gufo-org" })).toMatchObject({
      project: "gufo",
      ours: true,
    });
  });

  it("no display line carries an absolute path", () => {
    for (const resolution of seen)
      expect(resolution.display).not.toContain(root);
  });

  it("every result validates against the schema", () => {
    expect(seen.length).toBeGreaterThan(8);
    for (const resolution of seen)
      expect(validate(resolution), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("who counts as ours", () => {
  it("our org's name on a host we do not use is not ours, and does not beat the session", () => {
    const lookalike = makeRepo(root, "lookalike", {
      origin: "https://git.example.net/madeit-build/box.provisioning.git",
    });
    const resolution = resolveProject({ cwd: lookalike, sessionDir: ours });
    expect(resolution).toMatchObject({
      project: "box.provisioning",
      source: "session",
      ours: true,
    });
    expect(resolution.context?.project).toBe(
      "git.example.net/madeit-build/box.provisioning",
    );
  });

  it("hosts is an input", () => {
    const lookalike = makeRepo(root, "mirror", {
      origin: "https://git.example.net/madeit-build/seaboard.git",
    });
    expect(
      resolveProject({
        cwd: lookalike,
        hosts: ["github.com", "git.example.net"],
      }),
    ).toMatchObject({ project: "seaboard", ours: true });
  });
});

describe("host aliases", () => {
  it("an ssh host alias is ours once the caller names it", () => {
    const aliased = makeRepo(root, "aliased-clone", {
      origin: "gh:madeit-build/seaboard.git",
    });
    expect(resolveProject({ cwd: aliased }).display).toBe(
      "aliased-clone on branch main (a repo whose remote could not be read)",
    );
    expect(
      resolveProject({ cwd: aliased, hosts: ["github.com", "gh"] }),
    ).toMatchObject({ project: "seaboard", ours: true });
  });
});
