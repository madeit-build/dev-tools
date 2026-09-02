import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  computeSnippetHash,
  extractAnchoredText,
  parseTour,
  toErrorSummary,
  toTourSummary,
} from "@made-i-t/hdtw-engine-core";
import type {
  GetTourParams,
  GetTourResult,
  ListToursParams,
  ListToursResult,
  Tour,
  TourStep,
} from "@made-i-t/hdtw-protocol";
import { resolveSymbol } from "./symbolResolver.js";

const TOURS_DIR_SEGMENTS = [".hdtw", "tours"];
const TOUR_FILE_SUFFIX = ".tour.json";
const SAFE_TOUR_ID = /^[\w.-]+$/;

export class TourNotFoundError extends Error {}

/**
 * Load and parse a tour from disk without re-resolving symbol anchors.
 * Used by drift/reanchor handlers that need the raw cached line positions.
 */
export async function loadRawTour(
  workspaceRoot: string,
  tourId: string,
): Promise<{ tour: Tour }> {
  if (!SAFE_TOUR_ID.test(tourId) || tourId.includes("..")) {
    throw new TourNotFoundError(`no tour with id "${tourId}"`);
  }
  const filePath = path.join(
    workspaceRoot,
    ...TOURS_DIR_SEGMENTS,
    `${tourId}${TOUR_FILE_SUFFIX}`,
  );
  let jsonText: string;
  try {
    jsonText = await readFile(filePath, "utf8");
  } catch {
    throw new TourNotFoundError(`no tour with id "${tourId}"`);
  }
  const result = parseTour(jsonText, tourId);
  if (!result.ok) {
    throw new TourNotFoundError(
      `tour "${tourId}" is invalid: ${result.errors.join("; ")}`,
    );
  }
  return { tour: result.tour };
}

export async function listTours(
  params: ListToursParams,
): Promise<ListToursResult> {
  const toursDir = path.join(params.workspaceRoot, ...TOURS_DIR_SEGMENTS);
  let entries: string[];
  try {
    entries = await readdir(toursDir);
  } catch {
    return { tours: [] };
  }
  const tourFiles = entries
    .filter((name) => name.endsWith(TOUR_FILE_SUFFIX))
    .sort();
  const tours = await Promise.all(
    tourFiles.map(async (name) => {
      const stem = name.slice(0, -TOUR_FILE_SUFFIX.length);
      // Graceful degradation: one unreadable file becomes an error badge,
      // never a rejection that blanks the whole tour list.
      let jsonText: string;
      try {
        jsonText = await readFile(path.join(toursDir, name), "utf8");
      } catch (error) {
        return toErrorSummary(stem, [
          `could not read file: ${(error as Error).message}`,
        ]);
      }
      const result = parseTour(jsonText, stem);
      return result.ok
        ? toTourSummary(result.tour)
        : toErrorSummary(stem, result.errors);
    }),
  );
  return { tours };
}

export async function getTour(params: GetTourParams): Promise<GetTourResult> {
  const { tour: rawTour } = await loadRawTour(
    params.workspaceRoot,
    params.tourId,
  );
  const tour = await resolveSymbolAnchors(params.workspaceRoot, rawTour);
  return { tour };
}

/**
 * Best-effort re-resolution of symbol-anchored steps in a tour. For each step
 * with a symbol anchor, resolves the symbol to its current line range and
 * updates the served anchor's startLine/endLine/snippetHash. Line-anchored
 * steps are returned untouched. Failures never throw — any per-step error
 * falls back to the cached anchor unchanged.
 */
async function resolveSymbolAnchors(
  workspaceRoot: string,
  tour: Tour,
): Promise<Tour> {
  // Cache file contents keyed by workspace-relative file path so each file is
  // read at most once per getTour call.
  const fileContentCache = new Map<string, string | null>();

  async function getFileContent(file: string): Promise<string | null> {
    if (fileContentCache.has(file)) {
      return fileContentCache.get(file)!;
    }
    const resolvedRoot = path.resolve(workspaceRoot);
    const resolved = path.resolve(resolvedRoot, ...file.split("/"));
    if (
      resolved !== resolvedRoot
      && !resolved.startsWith(resolvedRoot + path.sep)
    ) {
      fileContentCache.set(file, null);
      return null;
    }
    try {
      const content = await readFile(resolved, "utf8");
      fileContentCache.set(file, content);
      return content;
    } catch {
      fileContentCache.set(file, null);
      return null;
    }
  }

  const resolvedSteps = await Promise.all(
    tour.steps.map(async (step): Promise<TourStep> => {
      if (!step.anchor.symbol) {
        return step;
      }
      try {
        const resolved = await resolveSymbol(
          workspaceRoot,
          step.anchor.file,
          step.anchor.symbol,
          { startLine: step.anchor.startLine, endLine: step.anchor.endLine },
        );
        if (resolved.kind !== "resolved") {
          return step;
        }
        const content = await getFileContent(step.anchor.file);
        if (content === null) {
          return step;
        }
        const anchoredText = extractAnchoredText(
          content,
          resolved.startLine,
          resolved.endLine,
        );
        const snippetHash = computeSnippetHash(anchoredText);
        return {
          ...step,
          anchor: {
            ...step.anchor,
            startLine: resolved.startLine,
            endLine: resolved.endLine,
            snippetHash,
          },
        };
      } catch {
        // Best-effort: any failure returns the cached anchor unchanged.
        return step;
      }
    }),
  );

  return { ...tour, steps: resolvedSteps };
}
