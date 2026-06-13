import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import {
  CHECK_TOUR_DRIFT_METHOD,
  REANCHOR_STEP_METHOD,
  type CheckTourDriftResult,
  type ReanchorStepResult,
} from "@made-i-t/hdtw-protocol";

const serverEntry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
let serverProcess: ChildProcess | undefined;
let connection: MessageConnection | undefined;
let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "hdtw-drift-"));
});

afterEach(async () => {
  connection?.dispose();
  connection = undefined;
  serverProcess?.kill();
  serverProcess = undefined;
  await rm(workspaceRoot, { recursive: true, force: true });
});

function startServer(): MessageConnection {
  serverProcess = spawn(process.execPath, [serverEntry], { stdio: ["pipe", "pipe", "inherit"] });
  connection = createMessageConnection(
    new StreamMessageReader(serverProcess.stdout!),
    new StreamMessageWriter(serverProcess.stdin!)
  );
  connection.listen();
  return connection;
}

test("checkTourDrift reports fresh then drifted after the file shifts", async () => {
  await writeFile(path.join(workspaceRoot, "src.ts"), "line1\nline2\nline3\nline4\n");
  await mkdir(path.join(workspaceRoot, ".hdtw", "tours"), { recursive: true });
  const { computeSnippetHash } = await import("@made-i-t/hdtw-engine-core");
  const hash = computeSnippetHash("line2\nline3");
  await writeFile(
    path.join(workspaceRoot, ".hdtw/tours/t.tour.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "t",
      title: "T",
      summary: "",
      steps: [
        { title: "s", narration: "n", anchor: { file: "src.ts", startLine: 2, endLine: 3, snippetHash: hash } },
      ],
    })
  );

  const conn = startServer();
  const fresh = await conn.sendRequest<CheckTourDriftResult>(CHECK_TOUR_DRIFT_METHOD, {
    workspaceRoot,
    tourId: "t",
  });
  expect(fresh.statuses).toEqual([{ index: 0, status: "fresh" }]);

  await writeFile(path.join(workspaceRoot, "src.ts"), "pad\npad\nline1\nline2\nline3\nline4\n");
  const drifted = await conn.sendRequest<CheckTourDriftResult>(CHECK_TOUR_DRIFT_METHOD, {
    workspaceRoot,
    tourId: "t",
  });
  expect(drifted.statuses).toEqual([{ index: 0, status: "drifted" }]);
});

test("reanchorStep relocates a drifted step and rewrites the tour", async () => {
  await writeFile(path.join(workspaceRoot, "src.ts"), "line1\nline2\nline3\nline4\n");
  await mkdir(path.join(workspaceRoot, ".hdtw", "tours"), { recursive: true });
  const { computeSnippetHash } = await import("@made-i-t/hdtw-engine-core");
  const hash = computeSnippetHash("line2\nline3");
  const tourPath = path.join(workspaceRoot, ".hdtw/tours/t.tour.json");
  await writeFile(
    tourPath,
    JSON.stringify({
      schemaVersion: 1,
      id: "t",
      title: "T",
      summary: "",
      steps: [
        { title: "s", narration: "n", anchor: { file: "src.ts", startLine: 2, endLine: 3, snippetHash: hash } },
      ],
    })
  );
  await writeFile(path.join(workspaceRoot, "src.ts"), "pad\npad\nline1\nline2\nline3\nline4\n");

  const conn = startServer();
  const reanchor = await conn.sendRequest<ReanchorStepResult>(REANCHOR_STEP_METHOD, {
    workspaceRoot,
    tourId: "t",
    stepIndex: 0,
  });
  expect(reanchor.outcome).toBe("reanchored");
  expect(reanchor.anchor).toMatchObject({ startLine: 4, endLine: 5 });

  const { readFile } = await import("node:fs/promises");
  const onDisk = JSON.parse(await readFile(tourPath, "utf8"));
  expect(onDisk.steps[0].anchor.startLine).toBe(4);
  expect(onDisk.steps[0].anchor.endLine).toBe(5);

  const recheck = await conn.sendRequest<CheckTourDriftResult>(CHECK_TOUR_DRIFT_METHOD, {
    workspaceRoot,
    tourId: "t",
  });
  expect(recheck.statuses).toEqual([{ index: 0, status: "fresh" }]);
});
