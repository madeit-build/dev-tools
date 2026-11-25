import fs from "node:fs";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main, type CliIo } from "./cli.ts";
import { makeRepo, tempDir } from "./testing/repos.ts";

const schema = JSON.parse(fs.readFileSync(new URL("../../schema/madeit-workspace-project-v1.json", import.meta.url), "utf8"));
const validate = new Ajv2020({ strict: false }).compile(schema);
const SESSION = "41f5ac32-9333-4487-a98f-c7eb1f3863cf";

let root: string;
let ours: string;
let foreign: string;
let claudeDir: string;

beforeAll(() => {
  root = tempDir();
  ours = makeRepo(root, "box.provisioning", { origin: "https://someuser:s3cr3tvalue@github.com/madeit-build/box.provisioning.git" });
  foreign = makeRepo(root, "gufo", { origin: "https://github.com/gufo-org/gufo" });
  claudeDir = path.join(root, "claude");
  fs.mkdirSync(path.join(claudeDir, "projects", "-work"), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "projects", "-work", `${SESSION}.jsonl`), JSON.stringify({ cwd: ours }) + "\n");
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function run(argv: string[], env: NodeJS.ProcessEnv = {}, cwd = ours): { code: number; out: string } {
  const lines: string[] = [];
  const io: CliIo = { out: (text) => lines.push(text), env, cwd };
  return { code: main(argv, io), out: lines.join("\n") };
}
const withSession = () => ({ CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_CONFIG_DIR: claudeDir });

describe("madeit-workspace project", () => {
  it("prints a resolution that validates against the schema", () => {
    const { code, out } = run(["project"]);
    expect(code).toBe(0);
    const resolution = JSON.parse(out);
    expect(validate(resolution), JSON.stringify(validate.errors)).toBe(true);
    expect(resolution.display).toBe("box.provisioning on branch main");
  });

  it("looks the session up from the environment", () => {
    const { out } = run(["project", "--cwd", foreign], withSession());
    expect(JSON.parse(out)).toMatchObject({ project: "box.provisioning", source: "session" });
  });

  it("--session-dir overrides the lookup", () => {
    const { out } = run(["project", "--cwd", ours, "--session-dir", foreign], withSession());
    expect(JSON.parse(out).layers.filter((layer: { where: string }) => layer.where === "session")[0].value).toBe("gufo-org/gufo");
  });

  it("--org changes who counts as ours", () => {
    expect(JSON.parse(run(["project", "--cwd", foreign, "--org", "gufo-org"]).out)).toMatchObject({ project: "gufo", ours: true });
  });
});

describe("madeit-workspace doctor", () => {
  it("returns 0 and five ok lines in a healthy repo", () => {
    const { code, out } = run(["doctor"], withSession());
    expect(out.split("\n").filter((line) => line.startsWith("ok  "))).toHaveLength(5);
    expect(code).toBe(0);
  });

  it("returns 1 and says what to try when the session id is unset", () => {
    const { code, out } = run(["doctor"]);
    expect(code).toBe(1);
    expect(out).toMatch(/^FAIL a session id is in the environment: .*CLAUDE_CODE_SESSION_ID/m);
    expect(out).toMatch(/^skip the session's transcript names a start directory/m);
  });

  it("fails the cwd check for a directory that does not exist", () => {
    const { code, out } = run(["doctor", "--cwd", path.join(root, "gone")], withSession());
    expect(code).toBe(1);
    expect(out).toMatch(/^FAIL the working directory exists/m);
  });

  it("fails the origin check for an origin it cannot read, without quoting it", () => {
    const odd = makeRepo(root, "odd", { origin: "/srv/git/s3cr3tplace.git" });
    const { code, out } = run(["doctor", "--cwd", odd], withSession());
    expect(code).toBe(1);
    expect(out).toMatch(/^FAIL the origin remote is readable/m);
    expect(out).not.toContain("s3cr3tplace");
  });

  it("never prints a remote URL, a credential, or a session id", () => {
    const outputs = [run(["doctor"], withSession()).out, run(["project"], withSession()).out];
    for (const out of outputs) {
      expect(out).not.toContain("s3cr3tvalue");
      expect(out).not.toContain("https://");
      expect(out).not.toContain(SESSION);
    }
  });
});

describe("usage", () => {
  it("--help prints usage and returns 0", () => {
    const { code, out } = run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("madeit-workspace project");
    expect(out).toContain("madeit-workspace doctor");
  });

  it.each([[["frobnicate"]], [[]], [["project", "--nope"]]])("%j returns 2 and prints usage", (argv) => {
    const { code, out } = run(argv);
    expect(code).toBe(2);
    expect(out).toContain("Usage:");
  });
});
