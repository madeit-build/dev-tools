import { expect, test } from "vitest";
import type { TourAnchor } from "./tours.js";
import {
  GET_TOUR_METHOD,
  LIST_TOURS_METHOD,
  TOUR_NOT_FOUND_ERROR_CODE,
} from "./index.js";

test("tour protocol constants are stable", () => {
  expect(LIST_TOURS_METHOD).toBe("hdtw/listTours");
  expect(GET_TOUR_METHOD).toBe("hdtw/getTour");
  expect(TOUR_NOT_FOUND_ERROR_CODE).toBe(-32001);
});

test("TourAnchor accepts an optional symbol (symbol-anchor) without breaking line-anchors", () => {
  const lineAnchor: TourAnchor = { file: "a.ts", startLine: 1, endLine: 2, snippetHash: "sha256:x" };
  const symbolAnchor: TourAnchor = { file: "a.ts", startLine: 1, endLine: 2, snippetHash: "sha256:x", symbol: "alpha" };
  expect(symbolAnchor.symbol).toBe("alpha");
  expect(lineAnchor.symbol).toBeUndefined();
});
