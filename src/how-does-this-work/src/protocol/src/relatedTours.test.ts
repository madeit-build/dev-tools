import { expect, test } from "vitest";
import type { RelatedTour, TourStep } from "./index.js";

test("a step can carry related tours and remains schemaVersion-1 compatible", () => {
  const related: RelatedTour = { tourId: "jsonrpc", label: "How JSON-RPC works" };
  const step: TourStep = {
    title: "s",
    narration: "n",
    anchor: { file: "a.ts", startLine: 1, endLine: 1, snippetHash: "sha256:aa" },
    relatedTours: [related],
  };
  expect(step.relatedTours?.[0].tourId).toBe("jsonrpc");
  // A step without relatedTours is still valid (additive).
  const bare: TourStep = { title: "s", narration: "n", anchor: step.anchor };
  expect(bare.relatedTours).toBeUndefined();
});
