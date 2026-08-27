/**
 * Recipe domain types — single source of truth (zod schemas, TS types inferred).
 * Vocabulary mirrors gc-minimal-zine-poster's style-system / variation-engine axes.
 * Recipes are always JSON-round-trippable data; functions live in registries keyed
 * by these enum strings, never inside a Recipe.
 */
import { z } from "zod";

export const RecipeSchemaVersion = 1 as const;

// --- Axis vocabularies (from the skill's variation-engine.md) ----------------

export const LAYOUT_FAMILIES = [
  "center-fragment",
  "lower-left-float",
  "upper-right-block",
  "dual-panel",
  "irregular-cutout",
  "type-led",
  "dot-orbit",
  "single-specimen",
  "diagonal-notes",
  "edge-counterweight",
] as const;
export type LayoutFamily = (typeof LAYOUT_FAMILIES)[number];

export const FOCAL_FORMS = [
  "faded-photo",
  "photo-crop",
  "torn-clipping",
  "flat-silhouette",
  "color-block",
  "printed-illustration",
  "specimen",
  "translucent-overlay",
  "texture-window",
  "fragmented-type",
] as const;
export type FocalForm = (typeof FOCAL_FORMS)[number];

export const TEXTURE_MODES = [
  "xerox-softness",
  "risograph-grain",
  "letterpress-bleed",
  "halftone-degradation",
  "film-grain",
  "scan-noise",
  "paper-mottling",
  "misregistration",
  "motion-blur-text",
] as const;
export type TextureMode = (typeof TEXTURE_MODES)[number];

export const TYPE_MODES = [
  "floating-letters",
  "edge-pressed-phrase",
  "archive-microtext",
  "diagonal-scattered",
  "ghost-text",
  "headline-object",
  "text-in-block",
  "almost-textless",
] as const;
export type TypeMode = (typeof TYPE_MODES)[number];

export const POSITIONS = [
  "center-high",
  "center-low",
  "left-middle",
  "right-middle",
  "lower-left-third",
  "upper-right-third",
  "offset-center",
] as const;
export type PositionName = (typeof POSITIONS)[number];

export const HUE_CARRIERS = [
  "subject",
  "cutout",
  "block",
  "photo-region",
  "bold-type",
  "dot",
  "hairline",
] as const;
export type HueCarrier = (typeof HUE_CARRIERS)[number];

export const MARK_KINDS = [
  "dot-group",
  "annotation-line",
  "tiny-arrow",
  "dashed-line",
  "transparent-rect",
  "registration-mark",
  "hand-curve",
] as const;
export type MarkKind = (typeof MARK_KINDS)[number];

export const MOODS = [
  "quiet",
  "summer",
  "solitude",
  "childhood",
  "seaside",
  "afternoon",
  "night",
  "memory",
  "surreal",
] as const;
export type Mood = (typeof MOODS)[number];

export const PAPER_TONES: Record<string, string> = {
  "warm-white": "#F5F0E6",
  ivory: "#EFE8D8",
  "light-gray": "#E4E2DC",
  "aged-yellow": "#E9DFC0",
  khaki: "#D9CFAF",
  "kraft-beige": "#D6C6A8",
};
export type PaperToneKey = keyof typeof PAPER_TONES;

export const ACCENT_HUES: Record<string, string> = {
  cobalt: "#1B4FD8",
  ultramarine: "#2743C6",
  cyan: "#00A6C8",
  violet: "#6A4FC7",
  magenta: "#E23D81",
  lemon: "#F2C230",
  pear: "#9BB53C",
  orange: "#F26A21",
  tomato: "#D8412F",
};

// --- Intent drafts (produced by IntentProvider implementations) --------------

export const PhotoRoleSchema = z.enum([
  "edit-target",
  "reference-image",
  "supporting-insert",
]);
export type PhotoRole = z.infer<typeof PhotoRoleSchema>;

export const PreservationLevelSchema = z.enum(["high", "medium", "low"]);

export const IntentDraftSchema = z.object({
  mode: z.enum(["generate", "photo-input", "reference-informed"]),
  thesis: z.string().min(1),
  metaphor: z.object({
    subject: z.string().min(1),
    relation: z.string().min(1),
  }),
  mood: z.enum(MOODS),
  /** LLM-chosen visual event id (strict palette, motifs.ts) */
  motifHint: z.string().optional(),
  shortText: z.string().max(60).nullish(),
  lang: z.string().default("zh"),
});
export type IntentDraft = z.infer<typeof IntentDraftSchema>;

// --- Recipe ------------------------------------------------------------------

const ratioTuple = z.tuple([z.number().positive(), z.number().positive()]);

export const RecipeSchema = z.object({
  schemaVersion: z.literal(RecipeSchemaVersion),
  seed: z.number().int(),
  mode: IntentDraftSchema.shape.mode,
  canvas: z.object({
    ratio: ratioTuple,
    width: z.number().int().min(240).max(4096),
    paperTone: z.string(),
  }),
  attention: z.object({
    negativeSpace: z.number().min(0.35).max(0.8),
    clusterScale: z.number().min(0.08).max(0.52),
    position: z.enum(POSITIONS),
  }),
    metaphor: IntentDraftSchema.shape.metaphor,
    layout: z.object({ family: z.enum(LAYOUT_FAMILIES) }),
    focal: z.object({
    form: z.enum(FOCAL_FORMS),
    treatment: z.enum(TEXTURE_MODES),
  }),
  type: z.object({
    mode: z.enum(TYPE_MODES),
    text: z.string().optional(),
    family: z.string().default("typewriter"),
  }),
  color: z.object({
    name: z.string(),
    hue: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    carrier: z.enum(HUE_CARRIERS),
    canvasShare: z.number().min(0.004).max(0.04),
  }),
  texture: z.object({
    mode: z.enum(TEXTURE_MODES),
    misregistration: z.number().min(0).max(1).optional(),
  }),
  marks: z.array(z.enum(MARK_KINDS)).max(3),
  /** compute-density knob threaded to every texture engine (1 draft … 6 rich) */
  detail: z.number().int().min(1).max(6).default(2),
  mood: z.enum(MOODS),
  photo: z
    .object({
      role: PhotoRoleSchema,
      preservation: PreservationLevelSchema,
      invariants: z.array(z.string()),
    })
    .optional(),
  visual: z
    .object({ motifId: z.string().optional() })
    .optional(),
  provenance: z
    .object({
      intentSource: z.string().default("heuristic"),
      model: z.string().optional(),
    })
    .prefault({ intentSource: "heuristic" }),
});
export type Recipe = z.infer<typeof RecipeSchema>;

/** Strips unknown keys (forward-compat policy) and validates. */
export function parseRecipe(input: unknown): Recipe {
  return RecipeSchema.parse(input);
}

/** JSON Schema export for external editors/skills (§8 interopability). */
export function recipeJsonSchema(): unknown {
  const zAny = z as unknown as {
    toJSONSchema?: (s: z.ZodType) => unknown;
    toJsonSchema?: (s: z.ZodType) => unknown;
  };
  const fn = zAny.toJSONSchema ?? zAny.toJsonSchema;
  if (!fn) throw new Error("This zod build does not expose a JSON-Schema converter.");
  return fn(RecipeSchema);
}
