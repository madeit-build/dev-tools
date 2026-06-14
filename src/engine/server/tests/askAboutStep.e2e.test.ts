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
  GENERATION_AUTH_REQUIRED_ERROR_CODE,
  GENERATION_BUDGET_EXCEEDED_ERROR_CODE,
  GENERATION_PROGRESS_NOTIFICATION,
  type AskAboutStepParams,
  type AskAboutStepResult,
  type GenerationProgressParams,
} from "@made-i-t/hdtw-protocol";

const serverEntry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
let serverProcess: ChildProcess | undefined;
let connection: MessageConnection | undefined;
let workspaceRoot: string;
let progress: GenerationProgressParams[];

/** Spawns the engine with the fake answerer and returns a listening connection. */
function startServer(extraEnv: Record<string, string> = {}): MessageConnection {
  serverProcess = spawn(process.execPath, [serverEntry], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, HDTW_GENERATOR: "fake", ...extraEnv },
  });
  const conn = createMessageConnection(
    new StreamMessageReader(serverProcess.stdout!),
    new StreamMessageWriter(serverProcess.stdin!)
  );
  conn.onNotification(GENERATION_PROGRESS_NOTIFICATION, (p: GenerationProgressParams) =>
    progress.push(p)
  );
  conn.listen();
  return conn;
}

function askParams(overrides: Partial<AskAboutStepParams> = {}): AskAboutStepParams {
  return {
    workspaceRoot,
    question: "why stdio?",
    context: { file: "README.md", startLine: 1, endLine: 1, narration: "n", tourTitle: "T" },
    ...overrides,
  };
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "hdtw-qa-"));
  await writeFile(path.join(workspaceRoot, "README.md"), "fixture\n");
  progress = [];
});
afterEach(async () => {
  connection?.dispose();
  connection = undefined;
  serverProcess?.kill();
  serverProcess = undefined;
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("askAboutStep returns an answer and emits an answering progress event", async () => {
  connection = startServer();

  const result = await connection.sendRequest<AskAboutStepResult>(
    ASK_ABOUT_STEP_METHOD,
    askParams()
  );

  expect(result.answer).toBe("Fake answer to: why stdio?");
  expect(progress.map((p) => p.phase)).toContain("answering");
});

test("askAboutStep maps an auth failure to GENERATION_AUTH_REQUIRED", async () => {
  connection = startServer({ HDTW_FAKE_AUTH_ERROR: "1" });

  await expect(
    connection.sendRequest<AskAboutStepResult>(ASK_ABOUT_STEP_METHOD, askParams())
  ).rejects.toMatchObject({ code: GENERATION_AUTH_REQUIRED_ERROR_CODE });
});

test("askAboutStep maps a budget breach to GENERATION_BUDGET_EXCEEDED", async () => {
  connection = startServer();

  // The fake reports ~$0.01; a sub-cent budget forces the pipeline to abort and surface budget.
  await expect(
    connection.sendRequest<AskAboutStepResult>(
      ASK_ABOUT_STEP_METHOD,
      askParams({ maxBudgetUsd: 0.001 })
    )
  ).rejects.toMatchObject({ code: GENERATION_BUDGET_EXCEEDED_ERROR_CODE });
});
