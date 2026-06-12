import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { PING_METHOD, type PingParams } from "@made-i-t/hdtw-protocol";
import { handlePing } from "./pingHandler.js";

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout)
);

connection.onRequest(PING_METHOD, (params: PingParams) => handlePing(params));

// Shutdown contract: the server exits when stdin reaches EOF, which doubles
// as orphan cleanup — if the parent client dies, the closed pipe tears us
// down. Keep this property if the transport ever changes.
connection.listen();
