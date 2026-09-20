import { describe, expect, test } from "vitest";
import type { Tour } from "@made-i-t/hdtw-protocol";
import { startWalk } from "./walkState.js";
import {
  activeWalk,
  advance,
  breadcrumbLabel,
  pushWalk,
  retreat,
} from "./walkStack.js";

function tour(id: string, steps: number): Tour {
  return {
    schemaVersion: 1,
    id,
    title: id.toUpperCase(),
    summary: "",
    steps: Array.from({ length: steps }, (_unused, index) => ({
      title: `${id}-${index}`,
      narration: "n",
      anchor: {
        file: "a.ts",
        startLine: 1,
        endLine: 1,
        snippetHash: "sha256:aa",
      },
    })),
  };
}

describe("walkStack", () => {
  test("activeWalk is the top of stack", () => {
    const stack = [startWalk(tour("root", 3))];
    expect(activeWalk(stack).tour.id).toBe("root");
  });

  test("advance moves within the active walk", () => {
    let stack = [startWalk(tour("root", 3))];
    stack = advance(stack);
    expect(activeWalk(stack).stepIndex).toBe(1);
  });

  test("advance past a sub-tour's last step pops to the parent at its branch step", () => {
    let stack = [{ tour: tour("root", 3), stepIndex: 2 }];
    stack = pushWalk(stack, tour("sub", 2));
    stack = advance(stack); // sub 0 -> 1
    expect(activeWalk(stack).stepIndex).toBe(1);
    stack = advance(stack); // sub last -> pop to root
    expect(activeWalk(stack).tour.id).toBe("root");
    expect(activeWalk(stack).stepIndex).toBe(2);
  });

  test("retreat before a sub-tour's first step pops to the parent", () => {
    let stack = [{ tour: tour("root", 3), stepIndex: 1 }];
    stack = pushWalk(stack, tour("sub", 2));
    stack = retreat(stack); // sub at 0 -> pop to root
    expect(activeWalk(stack).tour.id).toBe("root");
    expect(activeWalk(stack).stepIndex).toBe(1);
  });

  test("advance at the root's last step is a no-op", () => {
    const stack = [{ tour: tour("root", 2), stepIndex: 1 }];
    expect(advance(stack)).toBe(stack);
  });

  test("breadcrumbLabel joins tour titles with the separator", () => {
    let stack = [startWalk(tour("root", 2))];
    stack = pushWalk(stack, tour("sub", 2));
    expect(breadcrumbLabel(stack)).toBe("ROOT › SUB");
  });
});
