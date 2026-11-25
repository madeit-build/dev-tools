import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claudeCodeSessionDir } from "./session.ts";
import { tempDir } from "./testing/repos.ts";

const SESSION = "41f5ac32-9333-4487-a98f-c7eb1f3863cf";
const OTHER = "66f59bc3-8681-4ce7-8a35-5561398a5fe5";
let claudeDir: string;

function writeTranscript(
  project: string,
  sessionId: string,
  rows: (object | string)[],
): string {
  const dir = path.join(claudeDir, "projects", project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(
    file,
    rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row)))
        .join("\n") + "\n",
  );
  return file;
}

beforeAll(() => {
  claudeDir = tempDir();
  writeTranscript("-work-other", OTHER, [{ type: "user", cwd: "/work/other" }]);
  writeTranscript("-work-box-provisioning", SESSION, [
    { type: "summary" },
    "this row is not json",
    { type: "attachment", cwd: "/work/box.provisioning", sessionId: SESSION },
    { type: "user", cwd: "/work/somewhere-else" },
  ]);
});
afterAll(() => {
  fs.rmSync(claudeDir, { recursive: true, force: true });
});

describe("claudeCodeSessionDir", () => {
  it("finds the first cwd by session id, skipping rows that are not JSON or have none", () => {
    expect(claudeCodeSessionDir({ sessionId: SESSION, claudeDir }).dir).toBe(
      "/work/box.provisioning",
    );
  });

  it("uses transcriptPath when given and ignores sessionId", () => {
    const transcriptPath = path.join(
      claudeDir,
      "projects",
      "-work-other",
      `${OTHER}.jsonl`,
    );
    expect(
      claudeCodeSessionDir({ sessionId: SESSION, transcriptPath, claudeDir })
        .dir,
    ).toBe("/work/other");
  });

  it("null with a detail when no session id is available", () => {
    const result = claudeCodeSessionDir({ sessionId: "", claudeDir });
    expect(result.dir).toBeNull();
    expect(result.detail).toContain("CLAUDE_CODE_SESSION_ID");
  });

  it("null when the session id is not a UUID, without touching the filesystem", () => {
    const result = claudeCodeSessionDir({
      sessionId: "../../etc/passwd",
      claudeDir: "/nonexistent-claude-dir",
    });
    expect(result.dir).toBeNull();
    expect(result.detail).toContain("not a session id");
  });

  it("null when no transcript matches", () => {
    expect(
      claudeCodeSessionDir({
        sessionId: "00000000-0000-4000-8000-000000000000",
        claudeDir,
      }).dir,
    ).toBeNull();
  });

  it("null when the claude directory does not exist", () => {
    const result = claudeCodeSessionDir({
      sessionId: SESSION,
      claudeDir: path.join(claudeDir, "missing"),
    });
    expect(result.dir).toBeNull();
    expect(result.detail).toContain("projects");
  });

  it("null when transcriptPath does not exist", () => {
    expect(
      claudeCodeSessionDir({
        transcriptPath: path.join(claudeDir, "nope.jsonl"),
      }).dir,
    ).toBeNull();
  });

  it("null when no row in the first 64 KiB has a cwd", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    writeTranscript("-work-big", id, [
      { type: "summary", padding: "x".repeat(70 * 1024) },
      { type: "user", cwd: "/work/too-late" },
    ]);
    expect(claudeCodeSessionDir({ sessionId: id, claudeDir }).dir).toBeNull();
  });

  it("ignores a cwd that is not an absolute path", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    writeTranscript("-work-odd", id, [
      { cwd: 7 },
      { cwd: "relative/dir" },
      { cwd: "/work/real" },
    ]);
    expect(claudeCodeSessionDir({ sessionId: id, claudeDir }).dir).toBe(
      "/work/real",
    );
  });

  it("skips a row that belongs to a different session", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    writeTranscript("-work-mixed", id, [
      { cwd: "/work/someone-elses", sessionId: OTHER },
      { cwd: "/work/mine", sessionId: id },
    ]);
    expect(claudeCodeSessionDir({ sessionId: id, claudeDir }).dir).toBe(
      "/work/mine",
    );
  });

  it("the detail never contains the session id or the transcript's content", () => {
    for (const result of [
      claudeCodeSessionDir({ sessionId: SESSION, claudeDir }),
      claudeCodeSessionDir({
        sessionId: SESSION,
        claudeDir: path.join(claudeDir, "missing"),
      }),
      claudeCodeSessionDir({
        sessionId: "00000000-0000-4000-8000-000000000000",
        claudeDir,
      }),
    ]) {
      expect(result.detail).not.toContain(SESSION);
      expect(result.detail).not.toContain("00000000-0000");
      expect(result.detail).not.toContain("attachment");
    }
  });
});
