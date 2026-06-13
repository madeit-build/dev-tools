import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  parseTour,
  verifyAnchor,
} from "@made-i-t/hdtw-engine-core";
import type {
  GenerateTourParams,
  GenerateTourResult,
  GenerationProgressParams,
  RelatedTour,
  Tour,
  TourStep,
  TourSummary,
} from "@made-i-t/hdtw-protocol";
import { listTours } from "./tourHandlers.js";
import type { Observer } from "@made-i-t/hdtw-observability";
import {
  BudgetExceededError,
  GenerationCancelledError,
  GenerationFailedError,
  type DraftStep,
  type DraftTour,
  type TourGenerator,
} from "./tourGenerator.js";
import { slugify, writeTourToCatalog } from "./tourStorage.js";

const DEFAULT_MAX_BUDGET_USD = 2;

export async function runGeneration(
  params: GenerateTourParams,
  generator: TourGenerator,
  observer: Observer,
  onProgress: (progress: GenerationProgressParams) => void,
  cancelSignal: AbortSignal
): Promise<GenerateTourResult> {
  const maxBudgetUsd = params.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD;
  const span = observer.metrics.startSpan("generate.duration_ms", { topic: params.topic });
  observer.logger.info("generate.start", {
    topic: params.topic,
    model: params.model ?? "(default)",
    maxBudgetUsd,
  });
  // One controller feeds the generator: aborted by client cancellation OR budget breach.
  const abort = new AbortController();
  let budgetBreachedAtUsd: number | undefined;

  if (cancelSignal.aborted) {
    throw new GenerationCancelledError("generation cancelled");
  }
  const forwardAbort = () => abort.abort();
  cancelSignal.addEventListener("abort", forwardAbort, { once: true });

  try {
    const hooks = {
      signal: abort.signal,
      observer,
      onProgress: (progress: GenerationProgressParams) => {
        onProgress(progress);
        if (progress.estimatedCostUsd > maxBudgetUsd && budgetBreachedAtUsd === undefined) {
          budgetBreachedAtUsd = progress.estimatedCostUsd;
          abort.abort();
        }
      },
    };

    const catalogResult = await listTours({ workspaceRoot: params.workspaceRoot });
    const catalog: TourSummary[] = catalogResult.tours.filter((tour) => tour.error === undefined);
    const catalogIds = new Set(catalog.map((tour) => tour.id));

    const translateAbort = (error: unknown): never => {
      if (budgetBreachedAtUsd !== undefined) {
        throw new BudgetExceededError(
          `generation aborted: estimated cost $${budgetBreachedAtUsd.toFixed(2)} exceeded budget $${maxBudgetUsd.toFixed(2)}`,
          budgetBreachedAtUsd
        );
      }
      if (cancelSignal.aborted || abort.signal.aborted) {
        throw new GenerationCancelledError("generation cancelled");
      }
      throw error;
    };

    let draft: DraftTour;
    try {
      draft = await generator.generate(params.workspaceRoot, params.topic, normalizeModel(params.model), catalog, hooks);
    } catch (error) {
      translateAbort(error);
      throw error; // unreachable; satisfies control flow
    }

    let verified = await verifyDraft(params.workspaceRoot, draft, catalogIds, observer, onProgress);
    if (!verified.ok) {
      observer.logger.info("repair.round", { errors: verified.errors });
      observer.metrics.count("generate.repair_rounds");
      try {
        draft = await generator.repair(
          params.workspaceRoot,
          params.topic,
          normalizeModel(params.model),
          catalog,
          draft,
          verified.errors,
          hooks
        );
      } catch (error) {
        translateAbort(error);
        throw error;
      }
      verified = await verifyDraft(params.workspaceRoot, draft, catalogIds, observer, onProgress);
      if (!verified.ok) {
        throw new GenerationFailedError(
          `agent could not produce verifiable anchors after one repair round: ${verified.errors.join("; ")}`
        );
      }
    }

    const tour = assembleTour(draft, verified.steps);

    if (params.save === false) {
      observer.logger.info("generate.done", { id: tour.id, steps: tour.steps.length, saved: false });
      span.end({ steps: tour.steps.length });
      return { tour, savedPath: undefined };
    }

    onProgress({ phase: "saving", message: "Saving tour", tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0 });
    let saved;
    try {
      saved = await writeTourToCatalog(params.workspaceRoot, tour);
    } catch (error) {
      throw new GenerationFailedError(error instanceof Error ? error.message : String(error));
    }
    observer.logger.info("generate.done", {
      id: saved.tour.id,
      steps: saved.tour.steps.length,
      savedPath: saved.savedPath,
    });
    span.end({ steps: saved.tour.steps.length });
    return { tour: saved.tour, savedPath: saved.savedPath };
  } finally {
    cancelSignal.removeEventListener("abort", forwardAbort);
  }
}

function normalizeModel(model: string | undefined): string | undefined {
  return model && model.trim().length > 0 ? model : undefined;
}

type VerifiedDraft =
  | { ok: true; steps: TourStep[] }
  | { ok: false; errors: string[] };

async function verifyDraft(
  workspaceRoot: string,
  draft: DraftTour,
  catalogIds: Set<string>,
  observer: Observer,
  onProgress: (progress: GenerationProgressParams) => void
): Promise<VerifiedDraft> {
  onProgress({ phase: "verifying", message: "Verifying anchors", tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0 });
  const errors: string[] = [];
  const steps: TourStep[] = [];
  for (const draftStep of draft.steps) {
    const verifiedStep = await verifyStep(workspaceRoot, draftStep);
    if (typeof verifiedStep === "string") {
      observer.logger.warn("verify.step", { ok: false, file: draftStep.anchor.file, error: verifiedStep });
      observer.metrics.count("verify.drift");
      errors.push(verifiedStep);
    } else {
      observer.logger.info("verify.step", { ok: true, title: draftStep.title, file: draftStep.anchor.file });
      const related = resolveRelatedTours(draftStep.relatedTours, catalogIds, observer);
      steps.push(related.length > 0 ? { ...verifiedStep, relatedTours: related } : verifiedStep);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, steps };
}

function resolveRelatedTours(
  related: RelatedTour[] | undefined,
  catalogIds: Set<string>,
  observer: Observer
): RelatedTour[] {
  if (!related) {
    return [];
  }
  const kept: RelatedTour[] = [];
  for (const link of related) {
    if (catalogIds.has(link.tourId)) {
      kept.push(link);
    } else {
      observer.logger.info("verify.related_dropped", { tourId: link.tourId });
    }
  }
  return kept;
}

async function verifyStep(workspaceRoot: string, step: DraftStep): Promise<TourStep | string> {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolved = path.resolve(resolvedRoot, ...step.anchor.file.split("/"));
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    return `${step.anchor.file}: anchor path escapes the workspace`;
  }
  let fileContent: string;
  try {
    fileContent = await readFile(resolved, "utf8");
  } catch {
    return `${step.anchor.file}: file does not exist in the workspace`;
  }
  const verification = verifyAnchor(step.anchor, fileContent);
  if (!verification.ok) {
    return verification.errors.join("; ");
  }
  return {
    title: step.title,
    narration: step.narration,
    anchor: { ...step.anchor, snippetHash: verification.snippetHash },
  };
}

function assembleTour(draft: DraftTour, steps: TourStep[]): Tour {
  const tour: Tour = {
    schemaVersion: 1,
    id: slugify(draft.title),
    title: draft.title,
    summary: draft.summary,
    steps,
  };
  const serialized = JSON.stringify(tour, null, 2) + "\n";
  const gate = parseTour(serialized, tour.id);
  if (!gate.ok) {
    throw new GenerationFailedError(`generated tour failed validation: ${gate.errors.join("; ")}`);
  }
  return tour;
}

