/**
 * motifs.ts — the LLM-chosen motif palette + STRICT resolution.
 *
 * Policy shift (user directive): NO keyword table, NO fallback frame.
 * The model decides the visual event during intent parsing; the compiler
 * refuses to render an unresolved subject rather than silently drawing
 * something generic.
 */
import type { Recipe } from "../types/recipe.js";

export const MOTIF_IDS = [
  "envelope",
  "postcard-stamp",
  "rain-on-glass",
  "window-ajar",
  "door-light",
  "cup-melt",
  "branch-leaf",
  "open-book",
  "platform-rails",
  "tide-mark",
  "moth-cicada",
  "stair-gap",
  "bicycle",
  "creature",
] as const;

export type MotifId = (typeof MOTIF_IDS)[number];

export class UnknownMotifError extends Error {
  constructor(hint: string | undefined) {
    super(
      `motif "${hint ?? ""}" is not part of the palette. Valid ids: ${MOTIF_IDS.join(", ")}`,
    );
    this.name = "UnknownMotifError";
  }
}

/** Strict resolution: null/undefined hints are allowed only where the caller
 * explicitly supports type-led-only output; anything else must be in-palette. */
export function resolveMotifId(hint: string | null | undefined): MotifId | null {
  if (hint == null || hint.trim() === "") return null;
  const key = hint.trim().toLowerCase();
  if ((MOTIF_IDS as readonly string[]).includes(key)) return key as MotifId;
  // tolerate underscore variants coming from external tools
  const alt = key.replace(/_/g, "-");
  if ((MOTIF_IDS as readonly string[]).includes(alt)) return alt as MotifId;
  throw new UnknownMotifError(hint);
}

/** Staging copy lives beside the palette so painters & prompts stay aligned. */
export const MOTIF_STAGING: Record<MotifId, string> = {
  envelope: "a vintage envelope lying flat, flap open, seen straight-on like an archive scan",
  "postcard-stamp": "a postcard corner with a perforated stamp and a smudged postmark ring",
  "rain-on-glass": "raindrops clinging to a vertical glass pane, blurred frame behind them",
  "window-ajar": "a slightly-opened window shutter pair, dark night sliver visible in the gap",
  "door-light": "a door left ajar with a thin blade of daylight cutting across its seam",
  "cup-melt": "a half-melted ice cube in a shallow glass, waterline creeping up its walls",
  "branch-leaf": "a single curved twig with leaves, laid diagonally like a pressed specimen",
  "open-book": "a closed book whose ribbon bookmark spills over the cover edge",
  "platform-rails": "two rails converging until they vanish beneath a torn paper horizon",
  "tide-mark": "three receding foam lines on wet sand below a low horizon",
  "moth-cicada": "an empty cicada shell gripping a slender twig, translucent wing pads intact",
  "stair-gap": "a few ascending steps with the last tread missing, dashed ghost outline",
  bicycle: "a vintage road bicycle in full side profile, spoked wheels and a leaning frame",
  creature: "one resting animal drawn as a single continuous silhouette, its whole weight settled on the ground",
};
