import type { LayoutFamily, PositionName } from "./recipe.js";

/**
 * Grammar mapping: which cluster positions are allowed per layout family
 * ("randomness must change visual grammar, not only position").
 * type-led and diagonal-notes get bespoke anchors in layout/families.ts,
 * so they map to their natural default here.
 */
export const POSITION_ALLOWED_BY_FAMILY: Record<LayoutFamily, readonly PositionName[]> = {
  "center-fragment": ["center-high", "offset-center", "center-low"],
  "lower-left-float": ["lower-left-third", "left-middle"],
  "upper-right-block": ["upper-right-third", "right-middle"],
  "dual-panel": ["center-low", "offset-center", "left-middle"],
  "irregular-cutout": ["lower-left-third", "center-high", "upper-right-third"],
  "type-led": ["center-high"],
  "dot-orbit": ["offset-center", "center-high", "left-middle"],
  "single-specimen": ["center-low", "lower-left-third", "upper-right-third"],
  "diagonal-notes": ["offset-center"],
  "edge-counterweight": ["left-middle", "right-middle", "lower-left-third"],
};
