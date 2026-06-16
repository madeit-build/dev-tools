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
  SAVE_TOUR_METHOD,
  type GenerateTourResult,
  type SaveTourResult,
} from "@made-i-t/hdtw-protocol";

const serverEntry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
let serverProcess: ChildProcess | undefined;
let connection: MessageConnection | undefined;
let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "hdtw-save-"));
  await writeFile(path.join(workspaceRoot, "README.md"), "fixture readme\n");
});
afterEach(async () => {
  connection?.dispose();
  connection = undefined;
  serverProcess?.kill();
  serverProcess = undefined;
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("generate save:false writes nothing; saveTour then persists it", async () => {
  serverProcess = spawn(process.execPath, [serverEntry], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, HDTW_GENERATOR: "fake" },
  });
  connection = createMessageConnection(
    new StreamMessageReader(serverProcess.stdout!),
    new StreamMessageWriter(serverProcess.stdin!)
  );
  connection.listen();

  const generated = await connection.sendRequest<GenerateTourResult>(GENERATE_TOUR_METHOD, {
    workspaceRoot,
    topic: "how does the readme work",
    save: false,
  });
  expect(generated.savedPath).toBeUndefined();

  const saved = await connection.sendRequest<SaveTourResult>(SAVE_TOUR_METHOD, {
    workspaceRoot,
    tour: generated.tour,
  });
  expect(saved.savedPath).toBe(".hdtw/tours/fake-tour.tour.json");
  const onDisk = JSON.parse(await readFile(path.join(workspaceRoot, saved.savedPath), "utf8"));
  expect(onDisk.id).toBe("fake-tour");

  const saved2 = await connection.sendRequest<SaveTourResult>(SAVE_TOUR_METHOD, {
    workspaceRoot,
    tour: generated.tour,
  });
  expect(saved2.savedPath).toBe(".hdtw/tours/fake-tour-2.tour.json");
});
