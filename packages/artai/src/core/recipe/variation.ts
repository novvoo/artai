/**
 * Variation engine — pure function of (IntentDraft, seed).
 * Picks one value per axis, deterministically from the seeded stream.
 * Selection weights encode the skill's anti-default bias (eval #1):
 * center-fragment is deliberately under-weighted.
 */
import {
  ACCENT_HUES,
  PAPER_TONES,
  TEXTURE_MODES,
  RecipeSchemaVersion,
  type FocalForm,
  type IntentDraft,
  type Recipe,
} from "../types/index.js";
import { POSITION_ALLOWED_BY_FAMILY } from "../types/family-positions.js";
import { Rng } from "../util/rand.js";
import { LAYOUT_FAMILIES } from "../types/recipe.js";

const LAYOUT_WEIGHTS: Record<string, number> = {
  "center-fragment": 0.6,
  "lower-left-float": 1.0,
  "upper-right-block": 1.0,
  "dual-panel": 1.1,
  "irregular-cutout": 1.2,
  "type-led": 1.2,
  "dot-orbit": 0.9,
  "single-specimen": 1.3,
  "diagonal-notes": 1.1,
  "edge-counterweight": 1.2,
};

const FOCAL_WEIGHTS: Record<string, number> = {
  "faded-photo": 0.8,
  "photo-crop": 1.0,
  "torn-clipping": 1.2,
  "flat-silhouette": 1.0,
  "color-block": 1.3,
  "printed-illustration": 1.1,
  specimen: 1.2,
  "translucent-overlay": 1.0,
  "texture-window": 1.0,
  "fragmented-type": 0.9,
};

/** Focal forms that plausibly pair with a photo edit target (High preservation
 * prefers crop/fragment over redraw). */
export const PHOTO_FORMS: readonly FocalForm[] = [
  "photo-crop",
  "faded-photo",
  "torn-clipping",
];

const CARRIER_WEIGHTS: Record<string, number> = {
  subject: 24,
  cutout: 16,
  block: 28,
  "photo-region": 12,
  "bold-type": 12,
  dot: 5,
  hairline: 3,
};

export const ALL_FAMILIES = LAYOUT_FAMILIES;

/** Ink density inside the cluster box per focal form (solver input). */
export const INK_DENSITY: Record<string, number> = {
  "faded-photo": 0.85,
  "photo-crop": 0.9,
  "torn-clipping": 0.8,
  "flat-silhouette": 0.95,
  "color-block": 0.98,
  "printed-illustration": 0.7,
  specimen: 0.55,
  "translucent-overlay": 0.4,
  "texture-window": 0.6,
  "fragmented-type": 0.35,
};

export const ACCENT_AREA_FACTOR: Record<string, number> = {
  subject: 0.3,
  cutout: 0.4,
  block: 0.55,
  "photo-region": 0.35,
  "bold-type": 0.2,
  dot: 0.02,
  hairline: 0.005,
};

export interface RecipeOptions {
  readonly seed: number;
  /** content fingerprint — injects the THEME itself into the roll so
   * different texts produce different compositions under one base seed */
  readonly contentKey?: string | undefined;
  readonly intentSource?: string;
  readonly model?: string;
  /** compute-density knob (1–6); defaults to 2 when omitted */
  readonly detail?: number | undefined;
  /** user-locked accent hex (studio 配色 preset) — bypasses the mood roll
   * without disturbing the deterministic rng stream */
  readonly accent?: string | undefined;
  /** user-locked paper tone hex (studio 配色 preset) */
  readonly paperTone?: string | undefined;
}

/** Mood-constrained hue pools: the emotional temperature steers chromatics
 * instead of a uniform roll — this is the LLM's mood finally reaching pixels. */
const MOOD_HUE_WEIGHTS: Record<string, Record<string, number>> = {
  quiet: { cobalt: 3, cyan: 2.5, ultramarine: 2 },
  summer: { lemon: 3, pear: 2.5, cyan: 1.5, tomato: 1 },
  solitude: { ultramarine: 3, violet: 2, "light-gray": 0 }, // gray key exists only in tones
  childhood: { tomato: 2.5, orange: 2.5, lemon: 2 },
  seaside: { cyan: 3, cobalt: 2, pear: 1 },
  afternoon: { orange: 3, lemon: 2, tomato: 1.5 },
  night: { ultramarine: 3, violet: 2.5, magenta: 1.5 },
  memory: { violet: 2, orange: 2, khaki: 0 },
  surreal: { magenta: 3, violet: 2, tomato: 1.5 },
};

function moodHueWeights(mood: string): Record<string, number> {
  return MOOD_HUE_WEIGHTS[mood] ?? { cobalt: 1, violet: 1, tomato: 1 };
}

export function pickRecipe(draft: IntentDraft, opts: RecipeOptions): Recipe {
  // contentKey folds THE WORDS of the theme into the roll namespace: change
  // the words ⇒ change the composition grammar (not just the motif art)
  const contentTag =
    opts.contentKey ??
    `${draft.metaphor.subject}|${draft.metaphor.relation}|${draft.mood}`;
  const rng = new Rng(`${opts.seed}:recipe:${contentTag}`);
  const family = rng.weighted<Recipe["layout"]["family"]>(LAYOUT_WEIGHTS);
  const focalForm =
    draft.mode === "photo-input"
      ? rng.pick(PHOTO_FORMS)
      : rng.weighted<FocalForm>(FOCAL_WEIGHTS);
  const textureMode = rng.weighted(
    TEXTURE_MODES.reduce<Record<string, number>>((acc, m) => ({ ...acc, [m]: 1 }), {}),
  );
  const typeMode =
    draft.mode === "photo-input"
      ? (rng.pick([
          "archive-microtext",
          "almost-textless",
          "edge-pressed-phrase",
        ] as const) as Recipe["type"]["mode"])
      : weightedTypeMode(rng);
  const position = rng.pick(POSITION_ALLOWED_BY_FAMILY[family]!);
  // mood-steered chroma (the intent draft drives the palette family)
  const hueName = rng.weighted(moodHueWeights(draft.mood));
  const toneKeys = Object.keys(PAPER_TONES);
  const rolledTone = rng.pick(toneKeys);

  return {
    schemaVersion: RecipeSchemaVersion,
    seed: opts.seed,
    mode: draft.mode,
    canvas: {
      ratio: [3, 5],
      width: 1200,
      paperTone: opts.paperTone ?? rolledTone,
    },
    attention: {
      negativeSpace: round3(rng.range(0.42, 0.62)),
      // density-aware: light forms need larger raw geometry to deposit the
      // same visual ink weight (solver measures ink, not the bounding box)
      clusterScale: round3(
        Math.min(0.44, Math.max(0.12, rng.range(0.18, 0.32) / (INK_DENSITY[focalForm] ?? 0.7))),
      ),
      position,
    },
    metaphor: { subject: draft.metaphor.subject, relation: draft.metaphor.relation },
    layout: { family },
    focal: { form: focalForm, treatment: textureMode as Recipe["focal"]["treatment"] },
    type: { mode: typeMode, text: draft.shortText ?? undefined, family: "typewriter" },
    color: {
      name: hueName,
      hue: opts.accent ?? ACCENT_HUES[hueName]!,
      carrier: rng.weighted(CARRIER_WEIGHTS),
      canvasShare: round4(rng.range(0.009, 0.022)),
    },
    texture: {
      mode: textureMode as Recipe["texture"]["mode"],
      misregistration:
        textureMode === ("misregistration" as const) ? round2(rng.range(0.2, 0.6)) : undefined,
    },
    marks: pickMarks(rng),
    detail: opts.detail ?? 2,
    mood: draft.mood, // the model's emotional temperature reaches pixels verbatim
    ...(draft.mode === "photo-input"
      ? ({
          photo: {
            role: "edit-target" as const,
            preservation: "high" as const,
            invariants: ["subject recognizable", "defining proportions"],
          },
        } satisfies Pick<Recipe, "photo">)
      : {}),
    provenance: { intentSource: opts.intentSource ?? "heuristic", model: opts.model },
  };
}

function weightedTypeMode(rng: Rng): Recipe["type"]["mode"] {
  return rng.weighted({
    "floating-letters": 8,
    "edge-pressed-phrase": 18,
    "archive-microtext": 14,
    "diagonal-scattered": 8,
    "ghost-text": 12,
    "headline-object": 10,
    "text-in-block": 8,
    "almost-textless": 22,
  }) as Recipe["type"]["mode"];
}

/** Companion hue for two-ink motifs: a different voice from the same mood pool. */
export function companionHue(mood: string, currentName: string): string {
  const pool = Object.keys(MOOD_HUE_WEIGHTS[mood] ?? { cobalt: 1, violet: 1, tomato: 1 })
    .filter((h) => h !== currentName);
  if (!pool.length) return currentName;
  return new Rng(`${mood}:${currentName}:pair`).pick(pool);
}

function pickMarks(rng: Rng): Recipe["marks"] {
  if (rng.float() < 0.25) return [];
  const pool = [
    "dot-group",
    "annotation-line",
    "tiny-arrow",
    "dashed-line",
    "transparent-rect",
    "registration-mark",
    "hand-curve",
  ] as const;
  const count = rng.int(1, 3);
  const out: Recipe["marks"] = [];
  while (out.length < count) {
    const m = rng.pick(pool);
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const round4 = (v: number) => Math.round(v * 10000) / 10000;
const round2 = (v: number) => Math.round(v * 100) / 100;
