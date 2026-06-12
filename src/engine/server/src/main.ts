import {
  createMessageConnection,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import {
  GET_TOUR_METHOD,
  LIST_TOURS_METHOD,
  PING_METHOD,
  TOUR_NOT_FOUND_ERROR_CODE,
  type GetTourParams,
  type ListToursParams,
  type PingParams,
} from "@made-i-t/hdtw-protocol";
import { handlePing } from "./pingHandler.js";
import { getTour, listTours, TourNotFoundError } from "./tourHandlers.js";

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout)
);

connection.onRequest(PING_METHOD, (params: PingParams) => handlePing(params));

connection.onRequest(LIST_TOURS_METHOD, (params: ListToursParams) => listTours(params));

connection.onRequest(GET_TOUR_METHOD, async (params: GetTourParams) => {
  try {
    return await getTour(params);
  } catch (error) {
    if (error instanceof TourNotFoundError) {
      throw new ResponseError(TOUR_NOT_FOUND_ERROR_CODE, error.message);
    }
    throw error;
  }
});

// Shutdown contract: the server exits when stdin reaches EOF, which doubles
// as orphan cleanup — if the parent client dies, the closed pipe tears us
// down. Keep this property if the transport ever changes.
connection.listen();
