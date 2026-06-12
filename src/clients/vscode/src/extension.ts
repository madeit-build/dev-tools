import * as childProcess from "node:child_process";
import * as vscode from "vscode";
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import {
  PING_METHOD,
  PROTOCOL_VERSION,
  type PingParams,
  type PingResult,
} from "@hdtw/protocol";

const HANDSHAKE_TIMEOUT_MS = 5000;

let engineProcess: childProcess.ChildProcess | undefined;
let engineConnection: MessageConnection | undefined;

export async function activate(_context: vscode.ExtensionContext): Promise<void> {
  try {
    const result = await connectToEngine();
    void vscode.window.showInformationMessage(
      `HDTW engine connected (${result.engineName} v${result.engineVersion}, protocol v${result.protocolVersion})`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`HDTW engine failed to start: ${message}`);
  }
}

async function connectToEngine(): Promise<PingResult> {
  // Resolves to the engine-server package's "main" (dist/main.js) via the
  // workspace symlink. The client never imports engine code — it only needs
  // the path to spawn the process.
  const serverEntry = require.resolve("@hdtw/engine-server");

  // The extension host is Electron; ELECTRON_RUN_AS_NODE makes the spawned
  // process behave as plain Node.js (same technique vscode-languageclient uses).
  engineProcess = childProcess.spawn(process.execPath, [serverEntry], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!engineProcess.stdout || !engineProcess.stdin) {
    throw new Error("engine process has no stdio streams");
  }

  engineConnection = createMessageConnection(
    new StreamMessageReader(engineProcess.stdout),
    new StreamMessageWriter(engineProcess.stdin)
  );
  engineConnection.listen();

  const params: PingParams = {
    clientName: "vscode",
    protocolVersion: PROTOCOL_VERSION,
  };
  const ping = engineConnection.sendRequest<PingResult>(PING_METHOD, params);
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(
      () => reject(new Error(`engine handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms`)),
      HANDSHAKE_TIMEOUT_MS
    );
  });
  return Promise.race([ping, timeout]);
}

export function deactivate(): void {
  engineConnection?.dispose();
  engineConnection = undefined;
  engineProcess?.kill();
  engineProcess = undefined;
}
