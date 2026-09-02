import { access, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseTour } from "@made-i-t/hdtw-engine-core";
import type { Tour } from "@made-i-t/hdtw-protocol";

export const TOURS_DIR_SEGMENTS = [".hdtw", "tours"];
const TOUR_FILE_SUFFIX = ".tour.json";

export class TourSaveError extends Error {}

export function slugify(title: string): string {
  const slug = title.toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "tour";
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function uniqueTourId(
  toursDir: string,
  baseId: string,
): Promise<string> {
  let id = baseId;
  let counter = 2;
  while (await exists(path.join(toursDir, `${id}${TOUR_FILE_SUFFIX}`))) {
    id = `${baseId}-${counter}`;
    counter += 1;
  }
  return id;
}

/** Assign a unique id, gate the result, and atomically write the tour into the catalog. */
export async function writeTourToCatalog(
  workspaceRoot: string,
  tour: Tour,
): Promise<{ savedPath: string; tour: Tour }> {
  const toursDir = path.join(workspaceRoot, ...TOURS_DIR_SEGMENTS);
  await mkdir(toursDir, { recursive: true });

  const id = await uniqueTourId(toursDir, slugify(tour.title));
  const finalTour: Tour = { ...tour, id };
  const serialized = JSON.stringify(finalTour, null, 2) + "\n";
  const gate = parseTour(serialized, id);
  if (!gate.ok) {
    throw new TourSaveError(
      `tour failed validation: ${gate.errors.join("; ")}`,
    );
  }

  const finalPath = path.join(toursDir, `${id}${TOUR_FILE_SUFFIX}`);
  const tempPath = `${finalPath}.tmp`;
  await writeFile(tempPath, serialized, "utf8");
  await rename(tempPath, finalPath);

  return {
    savedPath: [...TOURS_DIR_SEGMENTS, `${id}${TOUR_FILE_SUFFIX}`].join("/"),
    tour: finalTour,
  };
}
