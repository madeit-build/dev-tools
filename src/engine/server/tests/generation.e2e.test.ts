import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  GENERATE_TOUR_METHOD,
  GENERATION_PROGRESS_NOTIFICATION,
  type GenerateTourResult,
  type GenerationProgressParams,
} from "@made-i-t/hdtw-protocol";

const serverEntry = fileURLToPath(new URL("../dist/main.js", import.meta.url));

let serverProcess: ChildProcess | undefined;
let connection: MessageConnection | undefined;
let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "hdtw-e2e-gen-"));
  await writeFile(path.join(workspaceRoot, "README.md"), "fixture readme\n");
});

afterEach(async () => {
  connection?.dispose();
  connection = undefined;
  serverProcess?.kill();
  serverProcess = undefined;
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("generateTour over stdio with the fake generator: progress + saved tour", async () => {
  serverProcess = spawn(process.execPath, [serverEntry], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, HDTW_GENERATOR: "fake" },
  });
  connection = createMessageConnection(
    new StreamMessageReader(serverProcess.stdout!),
    new StreamMessageWriter(serverProcess.stdin!)
  );
  const progress: GenerationProgressParams[] = [];
  connection.onNotification(GENERATION_PROGRESS_NOTIFICATION, (p: GenerationProgressParams) =>
    progress.push(p)
  );
  connection.listen();

  const result = await connection.sendRequest<GenerateTourResult>(GENERATE_TOUR_METHOD, {
    workspaceRoot,
    topic: "how does the readme work",
  });

  expect(result.tour.id).toBe("fake-tour");
  expect(result.savedPath).toBe(".hdtw/tours/fake-tour.tour.json");
  const onDisk = JSON.parse(
    await readFile(path.join(workspaceRoot, result.savedPath), "utf8")
  );
  expect(onDisk.steps[0].anchor.snippetHash).toMatch(/^sha256:/);
  expect(progress.map((p) => p.phase)).toContain("exploring");
  expect(progress.map((p) => p.phase)).toContain("saving");
});
