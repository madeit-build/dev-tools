import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkAnchorFreshness, findReanchor } from "@made-i-t/hdtw-engine-core";
import type {
  CheckTourDriftParams,
  CheckTourDriftResult,
  ReanchorStepParams,
  ReanchorStepResult,
  StepDriftStatus,
} from "@made-i-t/hdtw-protocol";
import { getTour, TourNotFoundError } from "./tourHandlers.js";

/** Read an anchored file, confined to the workspace; undefined when missing or escaping. */
async function readAnchoredFile(workspaceRoot: string, file: string): Promise<string | undefined> {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolved = path.resolve(resolvedRoot, ...file.split("/"));
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    return undefined;
  }
  try {
    return await readFile(resolved, "utf8");
  } catch {
    return undefined;
  }
}

export async function checkTourDrift(params: CheckTourDriftParams): Promise<CheckTourDriftResult> {
  const { tour } = await getTour({ workspaceRoot: params.workspaceRoot, tourId: params.tourId });
  const statuses: StepDriftStatus[] = [];
  for (let index = 0; index < tour.steps.length; index += 1) {
    const step = tour.steps[index];
    const content = await readAnchoredFile(params.workspaceRoot, step.anchor.file);
    statuses.push({
      index,
      status: content === undefined ? "file-missing" : checkAnchorFreshness(step.anchor, content),
    });
  }
  return { statuses };
}

const TOUR_FILE_SUFFIX = ".tour.json";
const SAFE_TOUR_ID = /^[\w.-]+$/;

export async function reanchorStep(params: ReanchorStepParams): Promise<ReanchorStepResult> {
  const { tour } = await getTour({ workspaceRoot: params.workspaceRoot, tourId: params.tourId });
  const step = tour.steps[params.stepIndex];
  if (!step) {
    throw new TourNotFoundError(`tour "${params.tourId}" has no step ${params.stepIndex}`);
  }
  const content = await readAnchoredFile(params.workspaceRoot, step.anchor.file);
  if (content === undefined) {
    return { outcome: "file-missing" };
  }
  const result = findReanchor(step.anchor, content);
  if (result.outcome !== "reanchored") {
    return { outcome: result.outcome };
  }
  const newAnchor = {
    ...step.anchor,
    startLine: result.startLine,
    endLine: result.endLine,
    snippetHash: result.snippetHash,
  };
  tour.steps[params.stepIndex] = { ...step, anchor: newAnchor };

  if (!SAFE_TOUR_ID.test(params.tourId) || params.tourId.includes("..")) {
    throw new TourNotFoundError(`no tour with id "${params.tourId}"`);
  }
  const finalPath = path.join(
    params.workspaceRoot,
    ".hdtw",
    "tours",
    `${params.tourId}${TOUR_FILE_SUFFIX}`
  );
  const tempPath = `${finalPath}.tmp`;
  await writeFile(tempPath, JSON.stringify(tour, null, 2) + "\n", "utf8");
  await rename(tempPath, finalPath);
  return { outcome: "reanchored", anchor: newAnchor };
}
