import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import {
  GET_TOUR_METHOD,
  LIST_TOURS_METHOD,
  PING_METHOD,
  PROTOCOL_VERSION,
  type GetTourResult,
  type ListToursResult,
  type PingResult,
} from "@made-i-t/hdtw-protocol";

const serverEntry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const fixtureWorkspace = fileURLToPath(new URL("./fixtures/workspace", import.meta.url));

let serverProcess: ChildProcess | undefined;
let connection: MessageConnection | undefined;

function startServer(): MessageConnection {
  serverProcess = spawn(process.execPath, [serverEntry], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  connection = createMessageConnection(
    new StreamMessageReader(serverProcess.stdout!),
    new StreamMessageWriter(serverProcess.stdin!)
  );
  connection.listen();
  return connection;
}

afterEach(() => {
  connection?.dispose();
  connection = undefined;
  serverProcess?.kill();
  serverProcess = undefined;
});

test("engine server responds to ping over stdio JSON-RPC", async () => {
  const conn = startServer();
  const result = await conn.sendRequest<PingResult>(PING_METHOD, {
    clientName: "e2e-test",
    protocolVersion: PROTOCOL_VERSION,
  });
  expect(result).toEqual({
    engineName: "hdtw-engine",
    engineVersion: "0.0.1",
    protocolVersion: PROTOCOL_VERSION,
  });
});

test("engine server lists and fetches tours over stdio", async () => {
  const conn = startServer();

  const list = await conn.sendRequest<ListToursResult>(LIST_TOURS_METHOD, {
    workspaceRoot: fixtureWorkspace,
  });
  expect(list.tours.map((tour) => tour.id)).toEqual(["broken-tour", "good-tour"]);

  const fetched = await conn.sendRequest<GetTourResult>(GET_TOUR_METHOD, {
    workspaceRoot: fixtureWorkspace,
    tourId: "good-tour",
  });
  expect(fetched.tour.title).toBe("Good tour");

  await expect(
    conn.sendRequest(GET_TOUR_METHOD, {
      workspaceRoot: fixtureWorkspace,
      tourId: "missing",
    })
  ).rejects.toMatchObject({ code: -32001 });
});
