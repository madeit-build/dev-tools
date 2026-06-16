import type { Tour } from "@made-i-t/hdtw-protocol";

/** Tracks whether the active walk is an unsaved (ephemeral "Ask") walk and, if so, the tour to save. */
export interface SaveState {
  setUnsaved(tour: Tour): void;
  setSaved(): void;
  /** The tour awaiting save, or undefined when the active walk is already saved. */
  unsavedTour(): Tour | undefined;
}

export function createSaveState(): SaveState {
  let pending: Tour | undefined;
  return {
    setUnsaved(tour) {
      pending = tour;
    },
    setSaved() {
      pending = undefined;
    },
    unsavedTour() {
      return pending;
    },
  };
}
