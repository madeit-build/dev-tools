import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  ASK_ABOUT_STEP_METHOD,
  GENERATION_PROGRESS_NOTIFICATION,
  type AskAboutStepResult,
  type GenerationProgressParams,
} from "@made-i-t/hdtw-protocol";

const serverEntry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
let serverProcess: ChildProcess | undefined;
let connection: MessageConnection | undefined;
let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "hdtw-qa-"));
  await writeFile(path.join(workspaceRoot, "README.md"), "fixture\n");
});
afterEach(async () => {
  connection?.dispose();
  connection = undefined;
  serverProcess?.kill();
  serverProcess = undefined;
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("askAboutStep returns an answer and emits an answering progress event", async () => {
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

  const result = await connection.sendRequest<AskAboutStepResult>(ASK_ABOUT_STEP_METHOD, {
    workspaceRoot,
    question: "why stdio?",
    context: { file: "README.md", startLine: 1, endLine: 1, narration: "n", tourTitle: "T" },
  });

  expect(result.answer).toBe("Fake answer to: why stdio?");
  expect(progress.map((p) => p.phase)).toContain("answering");
});
