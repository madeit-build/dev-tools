import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  parseTour,
  toErrorSummary,
  toTourSummary,
} from "@made-i-t/hdtw-engine-core";
import type {
  GetTourParams,
  GetTourResult,
  ListToursParams,
  ListToursResult,
} from "@made-i-t/hdtw-protocol";

const TOURS_DIR_SEGMENTS = [".hdtw", "tours"];
const TOUR_FILE_SUFFIX = ".tour.json";
const SAFE_TOUR_ID = /^[\w.-]+$/;

export class TourNotFoundError extends Error {}

export async function listTours(params: ListToursParams): Promise<ListToursResult> {
  const toursDir = path.join(params.workspaceRoot, ...TOURS_DIR_SEGMENTS);
  let entries: string[];
  try {
    entries = await readdir(toursDir);
  } catch {
    return { tours: [] };
  }
  const tourFiles = entries.filter((name) => name.endsWith(TOUR_FILE_SUFFIX)).sort();
  const tours = await Promise.all(
    tourFiles.map(async (name) => {
      const stem = name.slice(0, -TOUR_FILE_SUFFIX.length);
      const jsonText = await readFile(path.join(toursDir, name), "utf8");
      const result = parseTour(jsonText, stem);
      return result.ok ? toTourSummary(result.tour) : toErrorSummary(stem, result.errors);
    })
  );
  return { tours };
}

export async function getTour(params: GetTourParams): Promise<GetTourResult> {
  if (!SAFE_TOUR_ID.test(params.tourId) || params.tourId.includes("..")) {
    throw new TourNotFoundError(`no tour with id "${params.tourId}"`);
  }
  const filePath = path.join(
    params.workspaceRoot,
    ...TOURS_DIR_SEGMENTS,
    `${params.tourId}${TOUR_FILE_SUFFIX}`
  );
  let jsonText: string;
  try {
    jsonText = await readFile(filePath, "utf8");
  } catch {
    throw new TourNotFoundError(`no tour with id "${params.tourId}"`);
  }
  const result = parseTour(jsonText, params.tourId);
  if (!result.ok) {
    throw new TourNotFoundError(
      `tour "${params.tourId}" is invalid: ${result.errors.join("; ")}`
    );
  }
  return { tour: result.tour };
}
