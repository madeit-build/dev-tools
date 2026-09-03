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
  serverProcess = spawn(process.execPath, [serverEntry], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  connection = createMessageConnection(
    new StreamMessageReader(serverProcess.stdout!),
    new StreamMessageWriter(serverProcess.stdin!),
  );
  connection.listen();
  return connection;
}

test("checkTourDrift reports fresh then drifted after the file shifts", async () => {
  await writeFile(
    path.join(workspaceRoot, "src.ts"),
    "line1\nline2\nline3\nline4\n",
  );
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
        {
          title: "s",
          narration: "n",
          anchor: {
            file: "src.ts",
            startLine: 2,
            endLine: 3,
            snippetHash: hash,
          },
        },
      ],
    }),
  );

  const conn = startServer();
  const fresh = await conn.sendRequest<CheckTourDriftResult>(
    CHECK_TOUR_DRIFT_METHOD,
    {
      workspaceRoot,
      tourId: "t",
    },
  );
  expect(fresh.statuses).toEqual([{ index: 0, status: "fresh" }]);

  await writeFile(
    path.join(workspaceRoot, "src.ts"),
    "pad\npad\nline1\nline2\nline3\nline4\n",
  );
  const drifted = await conn.sendRequest<CheckTourDriftResult>(
    CHECK_TOUR_DRIFT_METHOD,
    {
      workspaceRoot,
      tourId: "t",
    },
  );
  expect(drifted.statuses).toEqual([{ index: 0, status: "drifted" }]);
});

test("checkTourDrift reports relocated for a symbol-anchor whose function moved", async () => {
  await mkdir(path.join(workspaceRoot, ".hdtw", "tours"), { recursive: true });
  const { computeSnippetHash } = await import("@made-i-t/hdtw-engine-core");

  // Write target.ts with a 3-line function at lines 1-3
  const originalContent = "export function target() {\n  return 42;\n}\n";
  await writeFile(path.join(workspaceRoot, "target.ts"), originalContent);
  const hash = computeSnippetHash(
    "export function target() {\n  return 42;\n}",
  );

  await writeFile(
    path.join(workspaceRoot, ".hdtw/tours/sym.tour.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "sym",
      title: "Sym",
      summary: "",
      steps: [
        {
          title: "s",
          narration: "n",
          anchor: {
            file: "target.ts",
            symbol: "target",
            startLine: 1,
            endLine: 3,
            snippetHash: hash,
          },
        },
      ],
    }),
  );

  // Prepend two blank lines so the function is now at lines 3-5
  await writeFile(
    path.join(workspaceRoot, "target.ts"),
    "\n\nexport function target() {\n  return 42;\n}\n",
  );

  const conn = startServer();
  const relocated = await conn.sendRequest<CheckTourDriftResult>(
    CHECK_TOUR_DRIFT_METHOD,
    {
      workspaceRoot,
      tourId: "sym",
    },
  );
  expect(relocated.statuses).toEqual([{ index: 0, status: "relocated" }]);
});

test("checkTourDrift reports symbol-missing when the symbol no longer exists", async () => {
  await mkdir(path.join(workspaceRoot, ".hdtw", "tours"), { recursive: true });
  const { computeSnippetHash } = await import("@made-i-t/hdtw-engine-core");

  // Write target.ts with a 3-line function at lines 1-3
  const originalContent = "export function target() {\n  return 42;\n}\n";
  await writeFile(path.join(workspaceRoot, "target.ts"), originalContent);
  const hash = computeSnippetHash(
    "export function target() {\n  return 42;\n}",
  );

  await writeFile(
    path.join(workspaceRoot, ".hdtw/tours/sym2.tour.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "sym2",
      title: "Sym2",
      summary: "",
      steps: [
        {
          title: "s",
          narration: "n",
          anchor: {
            file: "target.ts",
            symbol: "target",
            startLine: 1,
            endLine: 3,
            snippetHash: hash,
          },
        },
      ],
    }),
  );

  // Overwrite target.ts with a file that does NOT contain `target`
  await writeFile(
    path.join(workspaceRoot, "target.ts"),
    "export function other() { return 0; }\n",
  );

  const conn = startServer();
  const missing = await conn.sendRequest<CheckTourDriftResult>(
    CHECK_TOUR_DRIFT_METHOD,
    {
      workspaceRoot,
      tourId: "sym2",
    },
  );
  expect(missing.statuses).toEqual([{ index: 0, status: "symbol-missing" }]);
});

test("reanchorStep relocates a drifted step and rewrites the tour", async () => {
  await writeFile(
    path.join(workspaceRoot, "src.ts"),
    "line1\nline2\nline3\nline4\n",
  );
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
        {
          title: "s",
          narration: "n",
          anchor: {
            file: "src.ts",
            startLine: 2,
            endLine: 3,
            snippetHash: hash,
          },
        },
      ],
    }),
  );
  await writeFile(
    path.join(workspaceRoot, "src.ts"),
    "pad\npad\nline1\nline2\nline3\nline4\n",
  );

  const conn = startServer();
  const reanchor = await conn.sendRequest<ReanchorStepResult>(
    REANCHOR_STEP_METHOD,
    {
      workspaceRoot,
      tourId: "t",
      stepIndex: 0,
    },
  );
  expect(reanchor.outcome).toBe("reanchored");
  expect(reanchor.anchor).toMatchObject({ startLine: 4, endLine: 5 });

  const { readFile } = await import("node:fs/promises");
  const onDisk = JSON.parse(await readFile(tourPath, "utf8"));
  expect(onDisk.steps[0].anchor.startLine).toBe(4);
  expect(onDisk.steps[0].anchor.endLine).toBe(5);

  const recheck = await conn.sendRequest<CheckTourDriftResult>(
    CHECK_TOUR_DRIFT_METHOD,
    {
      workspaceRoot,
      tourId: "t",
    },
  );
  expect(recheck.statuses).toEqual([{ index: 0, status: "fresh" }]);
});
