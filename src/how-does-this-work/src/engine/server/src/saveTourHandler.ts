import type { SaveTourParams, SaveTourResult } from "@made-i-t/hdtw-protocol";
import { writeTourToCatalog } from "./tourStorage.js";

export async function saveTour(params: SaveTourParams): Promise<SaveTourResult> {
  const { savedPath } = await writeTourToCatalog(params.workspaceRoot, params.tour);
  return { savedPath };
}
