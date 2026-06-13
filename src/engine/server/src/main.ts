import {
  createMessageConnection,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
  type CancellationToken,
} from "vscode-jsonrpc/node.js";
import {
  GENERATE_TOUR_METHOD,
  GENERATION_AUTH_REQUIRED_ERROR_CODE,
  GENERATION_BUDGET_EXCEEDED_ERROR_CODE,
  GENERATION_FAILED_ERROR_CODE,
  GENERATION_PROGRESS_NOTIFICATION,
  GET_TOUR_METHOD,
  LIST_TOURS_METHOD,
  PING_METHOD,
  TOUR_NOT_FOUND_ERROR_CODE,
  type GenerateTourParams,
  type GetTourParams,
  type ListToursParams,
  type PingParams,
} from "@made-i-t/hdtw-protocol";
import { handlePing } from "./pingHandler.js";
import { getTour, listTours, TourNotFoundError } from "./tourHandlers.js";
import { runGeneration } from "./generationPipeline.js";
import { FakeTourGenerator } from "./fakeTourGenerator.js";
import { ClaudeAgentTourGenerator } from "./claudeTourGenerator.js";
import {
  AuthRequiredError,
  BudgetExceededError,
  GenerationCancelledError,
  GenerationFailedError,
  type TourGenerator,
} from "./tourGenerator.js";

// JSON-RPC standard code for a request the client cancelled.
const REQUEST_CANCELLED_ERROR_CODE = -32800;

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout)
);

function createGenerator(): TourGenerator {
  return process.env.HDTW_GENERATOR === "fake"
    ? new FakeTourGenerator()
    : new ClaudeAgentTourGenerator();
}

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

connection.onRequest(
  GENERATE_TOUR_METHOD,
  async (params: GenerateTourParams, token: CancellationToken) => {
    const abort = new AbortController();
    const cancelSubscription = token.onCancellationRequested(() => abort.abort());
    try {
      return await runGeneration(
        params,
        createGenerator(),
        (progress) => connection.sendNotification(GENERATION_PROGRESS_NOTIFICATION, progress),
        abort.signal
      );
    } catch (error) {
      if (error instanceof GenerationCancelledError) {
        throw new ResponseError(REQUEST_CANCELLED_ERROR_CODE, "generation cancelled");
      }
      if (error instanceof AuthRequiredError) {
        throw new ResponseError(GENERATION_AUTH_REQUIRED_ERROR_CODE, error.message);
      }
      if (error instanceof BudgetExceededError) {
        throw new ResponseError(GENERATION_BUDGET_EXCEEDED_ERROR_CODE, error.message);
      }
      if (error instanceof GenerationFailedError) {
        throw new ResponseError(GENERATION_FAILED_ERROR_CODE, error.message);
      }
      throw error;
    } finally {
      cancelSubscription.dispose();
    }
  }
);

// Shutdown contract: the server exits when stdin reaches EOF, which doubles
// as orphan cleanup — if the parent client dies, the closed pipe tears us
// down. Keep this property if the transport ever changes.
connection.listen();
