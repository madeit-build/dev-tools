import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { PING_METHOD, type PingParams } from "@hdtw/protocol";
import { handlePing } from "./pingHandler.js";

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout)
);

connection.onRequest(PING_METHOD, (params: PingParams) => handlePing(params));

connection.listen();
