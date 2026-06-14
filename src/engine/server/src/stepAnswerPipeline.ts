import type {
  AskAboutStepParams,
  AskAboutStepResult,
  GenerationProgressParams,
} from "@made-i-t/hdtw-protocol";
import type { Observer } from "@made-i-t/hdtw-observability";
import {
  BudgetExceededError,
  GenerationCancelledError,
  type GenerationHooks,
} from "./tourGenerator.js";
import type { StepAnswerer } from "./stepAnswerer.js";
import { FakeStepAnswerer } from "./fakeStepAnswerer.js";
import { ClaudeStepAnswerer } from "./claudeStepAnswerer.js";

const DEFAULT_MAX_BUDGET_USD = 2;

export function createStepAnswerer(): StepAnswerer {
  if (process.env.HDTW_GENERATOR === "fake") {
    // HDTW_FAKE_AUTH_ERROR lets e2e tests exercise the auth → error-code mapping.
    return new FakeStepAnswerer({ throwAuth: process.env.HDTW_FAKE_AUTH_ERROR === "1" });
  }
  return new ClaudeStepAnswerer();
}

export async function runStepAnswer(
  params: AskAboutStepParams,
  answerer: StepAnswerer,
  observer: Observer,
  onProgress: (progress: GenerationProgressParams) => void,
  cancelSignal: AbortSignal
): Promise<AskAboutStepResult> {
  const maxBudgetUsd = params.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD;
  const abort = new AbortController();
  let budgetBreachedAtUsd: number | undefined;

  if (cancelSignal.aborted) {
    throw new GenerationCancelledError("answer cancelled");
  }
  const forwardAbort = () => abort.abort();
  cancelSignal.addEventListener("abort", forwardAbort, { once: true });

  observer.logger.info("qa.asked", { file: params.context.file, question: params.question });

  try {
    const hooks: GenerationHooks = {
      signal: abort.signal,
      observer,
      onProgress: (progress) => {
        onProgress(progress);
        if (progress.estimatedCostUsd > maxBudgetUsd && budgetBreachedAtUsd === undefined) {
          budgetBreachedAtUsd = progress.estimatedCostUsd;
          abort.abort();
        }
      },
    };

    let answer: string;
    try {
      answer = await answerer.answer(
        params.workspaceRoot,
        params.context,
        params.question,
        params.model && params.model.trim().length > 0 ? params.model : undefined,
        hooks
      );
    } catch (error) {
      if (budgetBreachedAtUsd !== undefined) {
        throw new BudgetExceededError(
          `answer aborted: estimated cost $${budgetBreachedAtUsd.toFixed(2)} exceeded budget $${maxBudgetUsd.toFixed(2)}`,
          budgetBreachedAtUsd
        );
      }
      if (cancelSignal.aborted || abort.signal.aborted) {
        throw new GenerationCancelledError("answer cancelled");
      }
      throw error;
    }

    observer.logger.info("qa.answered", { chars: answer.length });
    return { answer };
  } finally {
    cancelSignal.removeEventListener("abort", forwardAbort);
  }
}
