import {
  createMessageConnection,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
  type CancellationToken,
} from "vscode-jsonrpc/node.js";
import {
  ASK_ABOUT_STEP_METHOD,
  CHECK_TOUR_DRIFT_METHOD,
  GENERATE_TOUR_METHOD,
  GENERATION_AUTH_REQUIRED_ERROR_CODE,
  GENERATION_BUDGET_EXCEEDED_ERROR_CODE,
  GENERATION_FAILED_ERROR_CODE,
  GENERATION_PROGRESS_NOTIFICATION,
  GET_TOUR_METHOD,
  LIST_TOURS_METHOD,
  PING_METHOD,
  REANCHOR_STEP_METHOD,
  SAVE_TOUR_METHOD,
  SAVE_TOUR_FAILED_ERROR_CODE,
  TOUR_NOT_FOUND_ERROR_CODE,
  type AskAboutStepParams,
  type CheckTourDriftParams,
  type GenerateTourParams,
  type GetTourParams,
  type ListToursParams,
  type PingParams,
  type ReanchorStepParams,
  type SaveTourParams,
} from "@made-i-t/hdtw-protocol";
import { createObserver, parseLogLevel } from "@made-i-t/hdtw-observability";
import { handlePing } from "./pingHandler.js";
import { getTour, listTours, TourNotFoundError } from "./tourHandlers.js";
import { saveTour } from "./saveTourHandler.js";
import { TourSaveError } from "./tourStorage.js";
import { checkTourDrift, reanchorStep } from "./driftHandlers.js";
import { runGeneration } from "./generationPipeline.js";
import { createStepAnswerer, runStepAnswer } from "./stepAnswerPipeline.js";
import OpenAI from "openai";
import { FakeTourGenerator } from "./fakeTourGenerator.js";
import { ClaudeAgentTourGenerator } from "./claudeTourGenerator.js";
import { OpenAiAgentTourGenerator, type ChatClient } from "./openaiTourGenerator.js";
import { StderrSink } from "./stderrSink.js";
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

const minLevel = parseLogLevel(process.env.HDTW_LOG_LEVEL, "info");
const observer = createObserver({ sink: new StderrSink(), minLevel });

function createGenerator(params: GenerateTourParams): TourGenerator {
  if (process.env.HDTW_GENERATOR === "fake") return new FakeTourGenerator();
  if (params.provider === "openai") {
    return new OpenAiAgentTourGenerator(
      () =>
        new OpenAI({
          apiKey: process.env.OPENAI_API_KEY ?? "ollama",
          baseURL: params.baseUrl,
        }) as unknown as ChatClient,
      { usdPer1kInput: params.usdPer1kInput, usdPer1kOutput: params.usdPer1kOutput }
    );
  }
  return new ClaudeAgentTourGenerator();
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
        createGenerator(params),
        observer,
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

connection.onRequest(
  ASK_ABOUT_STEP_METHOD,
  async (params: AskAboutStepParams, token: CancellationToken) => {
    const abort = new AbortController();
    const cancelSubscription = token.onCancellationRequested(() => abort.abort());
    try {
      return await runStepAnswer(
        params,
        createStepAnswerer(),
        observer,
        (progress) => connection.sendNotification(GENERATION_PROGRESS_NOTIFICATION, progress),
        abort.signal
      );
    } catch (error) {
      if (error instanceof GenerationCancelledError) {
        throw new ResponseError(REQUEST_CANCELLED_ERROR_CODE, "answer cancelled");
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

connection.onRequest(SAVE_TOUR_METHOD, async (params: SaveTourParams) => {
  try {
    return await saveTour(params);
  } catch (error) {
    if (error instanceof TourSaveError) {
      throw new ResponseError(SAVE_TOUR_FAILED_ERROR_CODE, error.message);
    }
    throw error;
  }
});

connection.onRequest(CHECK_TOUR_DRIFT_METHOD, async (params: CheckTourDriftParams) => {
  try {
    return await checkTourDrift(params);
  } catch (error) {
    if (error instanceof TourNotFoundError) {
      throw new ResponseError(TOUR_NOT_FOUND_ERROR_CODE, error.message);
    }
    throw error;
  }
});

connection.onRequest(REANCHOR_STEP_METHOD, async (params: ReanchorStepParams) => {
  try {
    return await reanchorStep(params);
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
