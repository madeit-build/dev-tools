import { describe, expect, test } from "vitest";
import { createSaveState } from "./saveState.js";

describe("saveState", () => {
  test("a saved walk shows no save affordance", () => {
    const s = createSaveState();
    s.setSaved();
    expect(s.unsavedTour()).toBeUndefined();
  });
  test("an unsaved walk exposes its tour until saved", () => {
    const s = createSaveState();
    const tour = { id: "t" } as unknown as import("@made-i-t/hdtw-protocol").Tour;
    s.setUnsaved(tour);
    expect(s.unsavedTour()).toBe(tour);
    s.setSaved();
    expect(s.unsavedTour()).toBeUndefined();
  });
});
