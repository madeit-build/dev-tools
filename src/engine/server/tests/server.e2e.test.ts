import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { PING_METHOD, PROTOCOL_VERSION, type PingResult } from "@made-i-t/hdtw-protocol";

const serverEntry = fileURLToPath(new URL("../dist/main.js", import.meta.url));

let serverProcess: ChildProcess | undefined;

afterEach(() => {
  serverProcess?.kill();
});

test("engine server responds to ping over stdio JSON-RPC", async () => {
  serverProcess = spawn(process.execPath, [serverEntry], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const connection = createMessageConnection(
    new StreamMessageReader(serverProcess.stdout!),
    new StreamMessageWriter(serverProcess.stdin!)
  );
  connection.listen();

  const result = await connection.sendRequest<PingResult>(PING_METHOD, {
    clientName: "e2e-test",
    protocolVersion: PROTOCOL_VERSION,
  });

  expect(result).toEqual({
    engineName: "hdtw-engine",
    engineVersion: "0.0.1",
    protocolVersion: PROTOCOL_VERSION,
  });
  connection.dispose();
});
