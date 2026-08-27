/**
 * prompt/compile.ts v2 — SceneIR → FOUR-PARAGRAPH image-model prompt.
 *
 * Principles vs v1:
 *  - speak everything the pipeline MEASURED (margins, light direction, cast
 *    shadow, depth mass occlusion) instead of adjectives;
 *  - give the model artifact guards (no stray glyphs/watermarks/signatures);
 *  - stay exactly four paragraphs (skill contract, tested).
 */
import type { Recipe } from "../types/recipe.js";
import { PAPER_TONES } from "../types/recipe.js";
import type { Plan } from "../layout/solver.js";
import type { SceneIR } from "../scene/compile.js";
import { MOTIF_STAGING, type MotifId } from "../recipe/motifs.js";

const MARITIME_TOKENS = ["sea", "ocean", "tide", "wave", "shore", "maritime", "sail", "ship", "harbor", "lighthouse"];
const BASE_AVOIDS_STRUCTURE = [
  "full-bleed scene", "commercial headline hierarchy", "product ad", "logo",
  "CTA", "glossy mockup", "clean UI white", "cinematic lighting",
  "hard shadow", "3D render", "neon",
];
const BASE_AVOIDS_CONTENT = [
  "watermarks", "signatures", "stray glyphs or fake letters outside the quoted phrase",
];

/** Motif staging copy — how each vignette is verbally grounded. */

function humanize(key: string): string {
  return String(key).replace(/-/g, " ");
}

function ratioLabel(recipe: Recipe): string {
  const [w, h] = recipe.canvas.ratio;
  const g = gcd(w, h);
  return `${Math.round(w / g)}:${Math.round(h / g)}`;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Describe the shared light direction in compass-of-frame wording. */
export function lightPhrase(lightDeg?: number): string {
  const deg = ((lightDeg ?? 145) % 360 + 360) % 360;
  const sectors = [
    "from the upper left", "from the upper center", "from the upper right",
    "from the middle right", "from the lower right", "from the lower center",
    "from the lower left", "from the middle left",
  ];
  const idx = Math.round(((deg + 22.5) % 360) / 45) % 8;
  return sectors[idx]!;
}

function shadowSideFor(lightDeg: number): string {
  // shadow lands on the side OPPOSITE where the light enters
  const opp = ((lightDeg ?? 145) + 180) % 360;
  if (opp < 45 || opp >= 315) return "toward the right edge";
  if (opp < 135) return "toward the bottom of the sheet";
  if (opp < 225) return "toward the left edge";
  return "toward the top of the sheet";
}

/** Edge vocabulary clause derived from the treatment/material pipeline. */
function edgeClause(treatment: string): string {
  switch (treatment) {
    case "letterpress-bleed": return "crisp cut-paper edges with ink pressed slightly past their rims";
    case "xerox-softness": return "soft xerox-fuzzed edges with tonal jitter";
    case "risograph-grain": return "grainy risograph tooth eating into every rim";
    case "halftone-degradation": return "coarse halftone dots degrading the silhouette";
    case "film-grain": return "fine film grain scattered over the pigment";
    case "misregistration": return "channels printed slightly off-register";
    default: return "hand-torn organic deckled edges";
  }
}

/** Depth-mass clause sourced from the emitted backdrop op. */
function backdropClause(ir?: SceneIR): string {
  const bd = ir?.ops.find((o) => o.op === "backdrop") as
    | { kind?: string; color?: string; alpha?: number }
    | undefined;
  if (!bd) return "";
  const noun =
    bd.kind === "disc" ? "one large soft-edged circular mass"
    : bd.kind === "slab" ? "one tilted rectangular plate"
    : "one generous arc wedge";
  return (
    ` Behind the event, ${noun} of a muted companion tone ` +
    `(≈${bd.color}) peeks out, partially occluded by the subject itself ` +
    `so the sheet gains foreground/middle-ground separation.`
  );
}

export interface CompileExtras {
  /** archival microtext strip actually placed by the renderer */
  readonly microtext?: string;
  readonly lightDeg?: number;
}

export function compilePrompt(recipe: Recipe, plan: Plan, ir?: SceneIR): string {
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  const toneHex = PAPER_TONES[recipe.canvas.paperTone] ?? "#f5f0e6";
  const motifOp = ir?.ops.find((o) => o.op === "motif") as
    | { edge?: string } | undefined;

  // ---------- paragraph 1 ----------
  const p1 =
    `${ratioLabel(recipe)} tall poster scanned flat: full-frame aged paper in ` +
    `${humanize(recipe.canvas.paperTone)} (${toneHex}) with visible fibers, sparse dust ` +
    `and corner aging spots, no border, no mockup. Keep ${pct(plan.measured.negativeSpace)} ` +
    `of the sheet untouched; set one ${pct(plan.measured.clusterShare)} visual cluster at ` +
    `${humanize(recipe.attention.position)}, with a quiet inner margin of at least ` +
    `${Math.round(plan.width * 0.06)}px equivalents on every side.`;

  // ---------- paragraph 2 ----------

  // paragraph 3 assembly happens after P2 build below
  const hasPhrase = Boolean(recipe.type.text);
  const genuinelyTextless = !hasPhrase || recipe.type.mode === "almost-textless";
  const textPart = recipe.type.text
    ? `Set ONLY the phrase "${recipe.type.text}" in a typewriter face, letterspaced sparse ` +
      `placement${genuinelyTextless ? " as a whisper caption" : ""} — render these characters cleanly; ` +
      `no other readable text anywhere. `
    : `Keep the sheet almost textless: at most a letter-spaced archival strip like "NO.42 · QUIET". `;
  const photoPart = recipe.photo
    ? `Use the supplied photograph as an ${recipe.photo.role} at ${recipe.photo.preservation} preservation; keep ${recipe.photo.invariants.join(", ")} recognizable; only scale, palette and surroundings may change. `
    : "";
  const motifIdRaw = (ir?.ops.find((o) => o.op === "motif") as { id?: string } | undefined)?.id ?? "";
  const staging =
    MOTIF_STAGING[motifIdRaw as keyof typeof MOTIF_STAGING] ??
    "one small focused visual event per the theme";
  const edgeWording = (() => {
    const mOp = ir?.ops.find((o) => o.op === "motif") as { edge?: string } | undefined;
    return mOp?.edge ?? recipe.focal.treatment;
  })();
  const shadowPhrase = shadowSideFor(irLight(ir) ?? 145);
  const p2 =
    photoPart +
    `Translate "${recipe.metaphor.relation}" into one small visual event: ` +
    `${staging}, embodying ${recipe.metaphor.subject}. Drawn with ` +
    `${edgeClause(edgeWording)}. One soft contact shadow falls ${shadowPhrase}, ` +
    `light entering ${lightPhrase(irLight(ir))}. Do not expand it into a full scene.` +
    backdropClause(ir);

  const huePart =
    `Color discipline: ${recipe.color.name} (${recipe.color.hue}) is the sole saturated ink, ` +
    `carried by the ${humanize(recipe.color.carrier)} itself inside the event ` +
    `(about ${pct(recipe.color.canvasShare)} of the whole sheet); surrounding panels only whisper it at wash strength; ` +
    `barely-there wash. Apply ${humanize(recipe.focal.treatment)} without dulling that ink.`;
  const p3 = textPart + huePart;

  // ---------- paragraph 4 ----------
  const themeIsMaritime = MARITIME_TOKENS.some((t) =>
    `${recipe.metaphor.subject} ${recipe.metaphor.relation}`.toLowerCase().includes(t),
  );
  const avoids = [...BASE_AVOIDS_STRUCTURE];
  if (!themeIsMaritime) avoids.unshift("unrequested maritime symbols or generic pictograms");
  avoids.push(...BASE_AVOIDS_CONTENT);
  const p4 =
    `Finish as an authentic scan: orthographic view, matte absorbent stock, diffuse ` +
    `overcast light ${lightPhrase(irLight(ir))}, low-to-medium contrast, ` +
    `${humanize(recipe.mood)} mood. Avoid: ${avoids.join(", ")}.`;

  return [p1, p2, p3, p4].join("\n\n");
}

export function paragraphCount(prompt: string): number {
  return prompt.split(/\n\n+/).length;
}

function irLight(ir?: SceneIR): number | undefined {
  const m = ir?.ops.find((o) => o.op === "motif") as { lightDeg?: number } | undefined;
  return m?.lightDeg;
}
function lightDegFromIr(ir?: SceneIR): number {
  return irLight(ir) ?? 145;
}
