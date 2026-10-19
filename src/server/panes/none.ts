import type { PaneLink } from "./types.ts";

/** PaneLink for when herdr is disabled: never available, does nothing. */
export function createNoPaneLink(): PaneLink {
  return {
    available: () => false,
    match: () => undefined,
    focus: async () => {},
    onChange: () => () => {},
    close: () => {},
  };
}
