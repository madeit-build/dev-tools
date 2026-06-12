import { mkdir, readFile, rename, writeFile, access } from "node:fs/promises";
import path from "node:path";
import {
  parseTour,
  verifyAnchor,
} from "@made-i-t/hdtw-engine-core";
import type {
  GenerateTourParams,
  GenerateTourResult,
  GenerationProgressParams,
  Tour,
  TourStep,
} from "@made-i-t/hdtw-protocol";
import {
  BudgetExceededError,
  GenerationCancelledError,
  GenerationFailedError,
  type DraftStep,
  type DraftTour,
  type TourGenerator,
} from "./tourGenerator.js";

const DEFAULT_MAX_BUDGET_USD = 2;
const TOURS_DIR_SEGMENTS = [".hdtw", "tours"];

export async function runGeneration(
  params: GenerateTourParams,
  generator: TourGenerator,
  onProgress: (progress: GenerationProgressParams) => void,
  cancelSignal: AbortSignal
): Promise<GenerateTourResult> {
  const maxBudgetUsd = params.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD;
  // One controller feeds the generator: aborted by client cancellation OR budget breach.
  const abort = new AbortController();
  let budgetBreachedAtUsd: number | undefined;

  if (cancelSignal.aborted) {
    throw new GenerationCancelledError("generation cancelled");
  }
  cancelSignal.addEventListener("abort", () => abort.abort(), { once: true });

  const hooks = {
    signal: abort.signal,
    onProgress: (progress: GenerationProgressParams) => {
      onProgress(progress);
      if (progress.estimatedCostUsd > maxBudgetUsd && budgetBreachedAtUsd === undefined) {
        budgetBreachedAtUsd = progress.estimatedCostUsd;
        abort.abort();
      }
    },
  };

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
    draft = await generator.generate(params.workspaceRoot, params.topic, normalizeModel(params.model), hooks);
  } catch (error) {
    translateAbort(error);
    throw error; // unreachable; satisfies control flow
  }

  let verified = await verifyDraft(params.workspaceRoot, draft, onProgress);
  if (!verified.ok) {
    try {
      draft = await generator.repair(params.workspaceRoot, params.topic, draft, verified.errors, hooks);
    } catch (error) {
      translateAbort(error);
      throw error;
    }
    verified = await verifyDraft(params.workspaceRoot, draft, onProgress);
    if (!verified.ok) {
      throw new GenerationFailedError(
        `agent could not produce verifiable anchors after one repair round: ${verified.errors.join("; ")}`
      );
    }
  }

  onProgress({ phase: "saving", message: "Saving tour", tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0 });
  return saveTour(params.workspaceRoot, draft, verified.steps);
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
  onProgress: (progress: GenerationProgressParams) => void
): Promise<VerifiedDraft> {
  onProgress({ phase: "verifying", message: "Verifying anchors", tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0 });
  const errors: string[] = [];
  const steps: TourStep[] = [];
  for (const step of draft.steps) {
    const verifiedStep = await verifyStep(workspaceRoot, step);
    if (typeof verifiedStep === "string") {
      errors.push(verifiedStep);
    } else {
      steps.push(verifiedStep);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, steps };
}

async function verifyStep(workspaceRoot: string, step: DraftStep): Promise<TourStep | string> {
  let fileContent: string;
  try {
    fileContent = await readFile(path.join(workspaceRoot, ...step.anchor.file.split("/")), "utf8");
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

async function saveTour(
  workspaceRoot: string,
  draft: DraftTour,
  steps: TourStep[]
): Promise<GenerateTourResult> {
  const toursDir = path.join(workspaceRoot, ...TOURS_DIR_SEGMENTS);
  await mkdir(toursDir, { recursive: true });

  const id = await uniqueTourId(toursDir, slugify(draft.title));
  const tour: Tour = {
    schemaVersion: 1,
    id,
    title: draft.title,
    summary: draft.summary,
    steps,
  };

  // Final gate: the generated artifact must pass the same validation playback uses.
  const serialized = JSON.stringify(tour, null, 2) + "\n";
  const gate = parseTour(serialized, id);
  if (!gate.ok) {
    throw new GenerationFailedError(`generated tour failed validation: ${gate.errors.join("; ")}`);
  }

  // Atomic write: a half-written tour file can never appear.
  const finalPath = path.join(toursDir, `${id}.tour.json`);
  const tempPath = `${finalPath}.tmp`;
  await writeFile(tempPath, serialized, "utf8");
  await rename(tempPath, finalPath);

  return { tour, savedPath: [...TOURS_DIR_SEGMENTS, `${id}.tour.json`].join("/") };
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "tour";
}

async function uniqueTourId(toursDir: string, baseId: string): Promise<string> {
  let id = baseId;
  let counter = 2;
  while (await exists(path.join(toursDir, `${id}.tour.json`))) {
    id = `${baseId}-${counter}`;
    counter += 1;
  }
  return id;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
