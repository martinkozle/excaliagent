// How the board's own top-right buttons (+ Lane, Tidy all, Sessions, ...) are
// laid out at a given canvas width. Excalidraw puts its toolbar in the middle
// and its Library button at the right end; our buttons sit in between, so they
// must shrink before they collide with either.

/**
 * - "labels": icon and label, in the top bar.
 * - "icons": icon only (the label is the tooltip and aria-label), in the top bar.
 * - "column": icon only, in a column at the right edge below the top bar,
 *   like Excalidraw's own mobile tools (no room left in the top bar).
 */
export type TopBarLayout = "labels" | "icons" | "column";

/** Width one labelled button needs at most (icon, label, padding, gap), in CSS px. */
const LABELLED = 120;
/** Width one icon-only button needs (Excalidraw's 2.25rem button plus a gap). */
const ICON = 44;
/**
 * Everything else in the top row: the main-menu button, Excalidraw's toolbar
 * (it slides left of centre when the right side needs the room), the labelled
 * Library button, and the gaps and edge padding between them.
 */
const REST = 800;

/**
 * The layout for `buttons` of our buttons on a canvas `width` px wide.
 * `mobile` is Excalidraw's own phone layout (its top row is all toolbar).
 */
export function topBarLayout(width: number, mobile: boolean, buttons: number): TopBarLayout {
  if (mobile) return "column";
  if (width >= REST + LABELLED * buttons) return "labels";
  if (width >= REST + ICON * buttons) return "icons";
  return "column";
}
