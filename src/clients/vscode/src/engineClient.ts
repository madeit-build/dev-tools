import * as childProcess from "node:child_process";
import {
  CancellationTokenSource,
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import {
  GENERATE_TOUR_METHOD,
  GENERATION_PROGRESS_NOTIFICATION,
  GET_TOUR_METHOD,
  LIST_TOURS_METHOD,
  PING_METHOD,
  PROTOCOL_VERSION,
  type GenerateTourParams,
  type GenerateTourResult,
  type GenerationProgressParams,
  type GetTourParams,
  type GetTourResult,
  type ListToursParams,
  type ListToursResult,
  type PingParams,
  type PingResult,
} from "@made-i-t/hdtw-protocol";
import { parseRecord } from "@made-i-t/hdtw-observability";
import type { OutputChannelSink } from "./outputChannelSink.js";

const HANDSHAKE_TIMEOUT_MS = 5000;

export class EngineClient {
  private engineProcess: childProcess.ChildProcess | undefined;
  private connection: MessageConnection | undefined;

  constructor(private readonly sink: OutputChannelSink) {}

  get isConnected(): boolean {
    return this.connection !== undefined;
  }

  async connect(extraEnv: Record<string, string> = {}): Promise<PingResult> {
    // Resolves to the engine-server package's "main" (dist/main.js) via the
    // workspace symlink. The client never imports engine code — it only needs
    // the path to spawn the process.
    const serverEntry = require.resolve("@made-i-t/hdtw-engine-server");

    // The extension host is Electron; ELECTRON_RUN_AS_NODE makes the spawned
    // process behave as plain Node.js (same technique vscode-languageclient uses).
    // The piped stdin doubles as orphan cleanup: the engine exits on stdin EOF.
    const serverProcess = childProcess.spawn(process.execPath, [serverEntry], {
      env: { ...process.env, ...extraEnv, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.engineProcess = serverProcess;

    let stderrBuffer = "";
    serverProcess.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
      let newlineIndex = stderrBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stderrBuffer.slice(0, newlineIndex);
        stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
        const record = parseRecord(line);
        if (record) {
          this.sink.record(record);
        } else if (line.trim().length > 0) {
          this.sink.appendRaw(`[engine] ${line}`);
        }
        newlineIndex = stderrBuffer.indexOf("\n");
      }
    });

    if (!serverProcess.stdout || !serverProcess.stdin) {
      throw new Error("engine process has no stdio streams");
    }

    const connection = createMessageConnection(
      new StreamMessageReader(serverProcess.stdout),
      new StreamMessageWriter(serverProcess.stdin)
    );
    this.connection = connection;
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
        settleWith(() =>
          reject(new Error(`engine process exited before handshake completed (code ${code})`))
        )
      );
      connection.sendRequest<PingResult>(PING_METHOD, params).then(
        (result) => settleWith(() => resolve(result)),
        (error) => settleWith(() => reject(error instanceof Error ? error : new Error(String(error))))
      );
    });
  }

  async listTours(workspaceRoot: string): Promise<ListToursResult> {
    const params: ListToursParams = { workspaceRoot };
    return this.request<ListToursResult>(LIST_TOURS_METHOD, params);
  }

  async getTour(workspaceRoot: string, tourId: string): Promise<GetTourResult> {
    const params: GetTourParams = { workspaceRoot, tourId };
    return this.request<GetTourResult>(GET_TOUR_METHOD, params);
  }

  async generateTour(
    params: GenerateTourParams,
    onProgress: (progress: GenerationProgressParams) => void,
    cancellation: { onCancellationRequested(listener: () => void): { dispose(): void } }
  ): Promise<GenerateTourResult> {
    if (!this.connection) {
      throw new Error("engine not connected");
    }
    const progressSubscription = this.connection.onNotification(
      GENERATION_PROGRESS_NOTIFICATION,
      onProgress
    );
    const source = new CancellationTokenSource();
    const cancelSubscription = cancellation.onCancellationRequested(() => source.cancel());
    try {
      return await this.connection.sendRequest<GenerateTourResult>(
        GENERATE_TOUR_METHOD,
        params,
        source.token
      );
    } finally {
      progressSubscription.dispose();
      cancelSubscription.dispose();
      source.dispose();
    }
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    if (!this.connection) {
      return Promise.reject(new Error("engine not connected"));
    }
    return Promise.resolve(this.connection.sendRequest<T>(method, params));
  }

  dispose(): void {
    this.connection?.dispose();
    this.connection = undefined;
    this.engineProcess?.kill();
    this.engineProcess = undefined;
  }
}
