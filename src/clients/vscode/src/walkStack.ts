import type { Tour } from "@made-i-t/hdtw-protocol";
import {
  hasNext,
  hasPrevious,
  nextStep,
  previousStep,
  startWalk,
  type WalkState,
} from "./walkState.js";

/** A non-empty stack of walks; the top is the active one. Following a related tour pushes; reaching a sub-tour's boundary pops. */
export type WalkStack = WalkState[];

export function activeWalk(stack: WalkStack): WalkState {
  return stack[stack.length - 1];
}

export function pushWalk(stack: WalkStack, tour: Tour): WalkStack {
  return [...stack, startWalk(tour)];
}

export function advance(stack: WalkStack): WalkStack {
  const active = activeWalk(stack);
  if (hasNext(active)) {
    return [...stack.slice(0, -1), nextStep(active)];
  }
  if (stack.length > 1) {
    return stack.slice(0, -1);
  }
  return stack;
}

export function retreat(stack: WalkStack): WalkStack {
  const active = activeWalk(stack);
  if (hasPrevious(active)) {
    return [...stack.slice(0, -1), previousStep(active)];
  }
  if (stack.length > 1) {
    return stack.slice(0, -1);
  }
  return stack;
}

export function breadcrumbLabel(stack: WalkStack): string {
  return stack.map((walk) => walk.tour.title).join(" › ");
}
