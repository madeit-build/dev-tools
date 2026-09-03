import { describe, expect, test } from "vitest";
import type { Tour } from "@made-i-t/hdtw-protocol";
import {
  currentStep,
  hasNext,
  hasPrevious,
  nextStep,
  previousStep,
  progressLabel,
  startWalk,
} from "./walkState.js";

const tour: Tour = {
  schemaVersion: 1,
  id: "t",
  title: "T",
  summary: "",
  steps: [
    {
      title: "one",
      anchor: {
        file: "a.ts",
        startLine: 1,
        endLine: 1,
        snippetHash: "sha256:a",
      },
      narration: "1",
    },
    {
      title: "two",
      anchor: {
        file: "b.ts",
        startLine: 2,
        endLine: 3,
        snippetHash: "sha256:b",
      },
      narration: "2",
    },
  ],
};

describe("walk state", () => {
  test("starts at the first step", () => {
    const state = startWalk(tour);
    expect(state.stepIndex).toBe(0);
    expect(currentStep(state).title).toBe("one");
    expect(hasPrevious(state)).toBe(false);
    expect(hasNext(state)).toBe(true);
    expect(progressLabel(state)).toBe("1/2");
  });

  test("advances and retreats within bounds", () => {
    let state = startWalk(tour);
    state = nextStep(state);
    expect(currentStep(state).title).toBe("two");
    expect(hasNext(state)).toBe(false);
    state = nextStep(state); // clamped at the end
    expect(state.stepIndex).toBe(1);
    state = previousStep(state);
    expect(state.stepIndex).toBe(0);
    state = previousStep(state); // clamped at the start
    expect(state.stepIndex).toBe(0);
  });
});
