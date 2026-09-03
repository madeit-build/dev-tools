import type { Tour, TourStep } from "@made-i-t/hdtw-protocol";

export interface WalkState {
  tour: Tour;
  stepIndex: number;
}

export function startWalk(tour: Tour): WalkState {
  return { tour, stepIndex: 0 };
}

export function currentStep(state: WalkState): TourStep {
  return state.tour.steps[state.stepIndex];
}

export function hasNext(state: WalkState): boolean {
  return state.stepIndex < state.tour.steps.length - 1;
}

export function hasPrevious(state: WalkState): boolean {
  return state.stepIndex > 0;
}

export function nextStep(state: WalkState): WalkState {
  return hasNext(state) ? { ...state, stepIndex: state.stepIndex + 1 } : state;
}

export function previousStep(state: WalkState): WalkState {
  return hasPrevious(state)
    ? { ...state, stepIndex: state.stepIndex - 1 }
    : state;
}

export function progressLabel(state: WalkState): string {
  return `${state.stepIndex + 1}/${state.tour.steps.length}`;
}
