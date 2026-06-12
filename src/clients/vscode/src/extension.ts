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
} from "@made-i-t/hdtw-protocol";

const HANDSHAKE_TIMEOUT_MS = 5000;

let engineProcess: childProcess.ChildProcess | undefined;
let engineConnection: MessageConnection | undefined;

export async function activate(_context: vscode.ExtensionContext): Promise<void> {
  if (engineProcess) {
    return;
  }
  try {
    const result = await connectToEngine();
    void vscode.window.showInformationMessage(
      `HDTW engine connected (${result.engineName} v${result.engineVersion}, protocol v${result.protocolVersion})`
    );
  } catch (error) {
    disposeEngine();
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`HDTW engine failed to start: ${message}`);
  }
}

async function connectToEngine(): Promise<PingResult> {
  // Resolves to the engine-server package's "main" (dist/main.js) via the
  // workspace symlink. The client never imports engine code — it only needs
  // the path to spawn the process.
  const serverEntry = require.resolve("@made-i-t/hdtw-engine-server");

  // The extension host is Electron; ELECTRON_RUN_AS_NODE makes the spawned
  // process behave as plain Node.js (same technique vscode-languageclient uses).
  // The piped stdin doubles as orphan cleanup: the engine exits on stdin EOF.
  const serverProcess = childProcess.spawn(process.execPath, [serverEntry], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  engineProcess = serverProcess;

  serverProcess.stderr?.on("data", (chunk: Buffer) => {
    console.error(`[hdtw-engine] ${chunk.toString().trimEnd()}`);
  });

  if (!serverProcess.stdout || !serverProcess.stdin) {
    throw new Error("engine process has no stdio streams");
  }

  const connection = createMessageConnection(
    new StreamMessageReader(serverProcess.stdout),
    new StreamMessageWriter(serverProcess.stdin)
  );
  engineConnection = connection;
  connection.listen();

  const params: PingParams = {
    clientName: "vscode",
    protocolVersion: PROTOCOL_VERSION,
  };

  // Reject promptly and distinctly for each failure mode (spawn failure,
  // engine crash, request error) instead of letting them all degrade into
  // the generic handshake timeout.
  return new Promise<PingResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`engine handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms`));
    }, HANDSHAKE_TIMEOUT_MS);
    const settleWith = (callback: () => void) => {
      clearTimeout(timer);
      callback();
    };

    serverProcess.on("error", (error) =>
      settleWith(() => reject(new Error(`engine process failed to spawn: ${error.message}`)))
    );
    serverProcess.on("exit", (code) =>
      settleWith(() => reject(new Error(`engine process exited before handshake completed (code ${code})`)))
    );
    connection.sendRequest<PingResult>(PING_METHOD, params).then(
      (result) => settleWith(() => resolve(result)),
      (error) => settleWith(() => reject(error instanceof Error ? error : new Error(String(error))))
    );
  });
}

function disposeEngine(): void {
  engineConnection?.dispose();
  engineConnection = undefined;
  engineProcess?.kill();
  engineProcess = undefined;
}

export function deactivate(): void {
  disposeEngine();
}
