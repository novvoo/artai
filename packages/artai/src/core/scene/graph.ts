/**
 * scene/graph.ts — Visual Composition Graph: the rich intermediate layer
 * between "design intent text" and "pixel commands".
 *
 * The LLM composes this graph by reading the full-spec prompt and expanding
 * each concept into a visual layer with precise geometry, color, and effect.
 * A deterministic renderer then draws the graph onto Canvas-2D, producing
 * output far richer than mechanical fillRect calls.
 *
 * Flow: full-spec prompt ──(LLM)──► SceneGraph ──(renderer)──► pixels
 */

import { z } from "zod";

/* ============================ layer schemas ============================== */

const GradientFillSchema = z.object({
  type: z.literal("gradient_fill"),
  x: z.number(), y: z.number(), w: z.number(), h: z.number(),
  colorTop: z.string(),
  colorBottom: z.string(),
  alpha: z.number().min(0).max(1).default(0.9),
});

const BlobSchema = z.object({
  type: z.literal("organic_blob"),
  cx: z.number(), cy: z.number(),
  rBase: z.number(),
  /** 3+ noise harmonics create organic edge displacement */
  harmonics: z.array(z.number()).min(1).max(4),
  fill: z.string(),
  alpha: z.number().min(0.02).max(1),
});

const StrokePathSchema = z.object({
  type: z.literal("stroke_path"),
  points: z.array(z.array(z.number())).min(3),
  color: z.string(),
  lineWidth: z.number().min(0.3),
  dashPattern: z.array(z.number()).optional(),
  pressureTaper: z.boolean().default(true),
});

/** body primitive for man-made objects — cups, books, doors, windows */
const EllipseSchema = z.object({
  type: z.literal("ellipse"),
  cx: z.number(), cy: z.number(),
  rx: z.number().min(1), ry: z.number().min(1),
  /** rotation in radians, clockwise */
  rot: z.number().optional(),
  fill: z.string(),
  alpha: z.number().min(0.02).max(1),
});

/** flat plates: posters, book covers, tables, panels */
const RoundRectSchema = z.object({
  type: z.literal("round_rect"),
  x: z.number(), y: z.number(), w: z.number().min(1), h: z.number().min(1),
  /** corner radius (defaults to w*0.06) */
  r: z.number().min(0).optional(),
  rot: z.number().optional(),
  fill: z.string(),
  alpha: z.number().min(0.02).max(1),
});

const VignetteLayer = z.object({
  type: z.literal("vignette"),
  intensity: z.number().min(0).max(0.5),
  falloff: z.enum(["soft", "medium", "sharp"]).default("soft"),
});

const GrainPassSchema = z.object({
  type: z.literal("grain"),
  density: z.number().min(100).max(20000),
  twoTone: z.boolean().default(true),
});

const ShapeNode = z.discriminatedUnion("type", [
  GradientFillSchema,
  BlobSchema,
  StrokePathSchema,
  EllipseSchema,
  RoundRectSchema,
  VignetteLayer,
  GrainPassSchema,
]);

const LayerZod = z.object({
  id: z.string().min(1).max(60),
  label: z.string().max(80),
  depth: z.number().min(0).max(10),       // lower = farther back
  shapes: z.array(ShapeNode).min(1).max(12),
});

export const CompositionGraphSchema = z.object({
  lightDeg: z.number().min(0).max(360),
  layers: z.array(LayerZod).min(2).max(15),
  paletteLocked: z.array(z.string()).min(3).max(6),
});

export type CompositionGraph = z.infer<typeof CompositionGraphSchema>;
export type GraphLayer = z.infer<typeof LayerZod>;
export type GraphShape = z.infer<typeof ShapeNode>;

/* ============================ LLM prompt template ======================== */

/** Shape vocabulary shared by both reply formats (single object / JSONL). */
const SHAPES_VOCAB = `Each shape is one of:
- {"type":"gradient_fill","x":n,"y":n,"w":n,"h":n,"colorTop":"#hex","colorBottom":"#hex","alpha":n}
- {"type":"organic_blob","cx":n,"cy":n,"rBase":n,"harmonics":[n,n,n],"fill":"#hex","alpha":n}
- {"type":"ellipse","cx":n,"cy":n,"rx":n,"ry":n,"rot"?:n,"fill":"#hex","alpha":n}  \u2014 cups, bowls, moons, any round body
- {"type":"round_rect","x":n,"y":n,"w":n,"h":n,"r"?:n,"rot"?:n,"fill":"#hex","alpha":n}  \u2014 books, doors, tables, panels
- {"type":"stroke_path","points":[[x,y],[x,y],\u2026],"color":"#hex","lineWidth":n,"dashPattern"?:[n,n],"pressureTaper":boolean}
- {"type":"vignette","intensity":n}
- {"type":"grain","density":n}`;

const AUTHORING_PROCESS = `AUTHORING PROCESS \u2014 think like an illustrator before writing JSON:
1. DEPTH = VIEWER DISTANCE: depth is paint order AND occlusion \u2014 where two elements overlap, the one NEARER the viewer gets the HIGHER depth. A platform edge / table front / window frame occludes whatever lies beyond it (rails, floor, skyline); the focal subject occludes its backdrop. Getting this backwards puts far-away rails IN FRONT of near objects
2. PLACE: the focal object sits on a rule-of-thirds intersection, roughly 45\u201365% down the canvas \u2014 never dead center, never clipped by margins
3. LIGHT: lightDeg is the light angle. Shading blobs and shadow masses go on the OPPOSITE side of the focal object; rim highlights on the lit side
4. VALUES: block 3\u20134 big value masses first (paper, one mid wash, one dark accent) \u2014 one dominant, one secondary, small accents; generous empty paper is GOOD
5. BUILD the focal object: ellipse / round_rect body fills first, then a CLOSED stroke_path silhouette (8\u201312 points tracing the true outline, first point repeated last \u2014 closed contours get a soft body fill), then 2\u20133 interior structure strokes and 2\u20133 organic_blob shading patches (alpha 0.15\u20130.35) for volume
6. DETAIL: small accents (stains, ticks, speckles) scattered unevenly near the focal element
7. FINISH: grain + vignette layers`;

const LAYER_RULES = `Rules:
\u2022 Create 10\u201313 layers organized by depth (0=background, 10=finisher) \u2014 graphs with fewer than 10 layers are AUTO-REJECTED and retried
\u2022 3\u20135 shapes per layer (focal layer 6\u201310) \u2014 total shape count below 2.5\u00d7 the layer count is AUTO-REJECTED
\u2022 Layer 0 must be a gradient_fill covering the full canvas (paper tone)
\u2022 Add organic_blob layers for atmospheric/color masses behind the focal element
\u2022 organic_blob harmonics control edge irregularity: 0.04\u20130.12 = gentle wash,
  0.15\u20130.3 = torn paper / stain edges
\u2022 Long stroke_path lines (edges of tables, horizons, rails) look hand-drawn
  with pressureTaper=true; use dashPattern only for fine ticks
\u2022 End with grain + vignette for printed-media character
\u2022 Use ONLY colors from the provided palette (plus tints/shades)
\u2022 Coordinates in a 1200\u00d72000 space`;

/** few-shot anchor: models imitate structure far better than they follow
 * adjectives — a complete exemplar (structure, depth order, density, value
 * range) removes most of the guessing that caused first-draft retries */
const DENSITY_EXAMPLE = `REFERENCE SKELETON (structure to imitate — ${"{}"} marks where your content goes; do NOT copy this cup): a compliant graph has exactly this SHAPE:
{"lightDeg":315}
paper(0): 1 full-canvas gradient_fill  \u2192 depth 0
3\u00d7 atmosphere(1-3): gradient_fill wash + organic_blob mass + long stroke_path, 3 shapes each  \u2192 depth 1..3
2\u00d7 ground/props(4-5): round_rect plate + shading blobs, 3-4 shapes each  \u2192 depth 4..5
focal(6-8): ellipse/round_rect body + closed silhouette (8-12 pts, first point repeated last) + 2 interior strokes + 2 shading blobs \u2192 depth 6..8
details(8-9): 2-3 small accent layers, 2-3 shapes each
finisher(10): one layer with ONLY grain + vignette
One well-filled midground layer (5 shapes):
{"id":"desk-plate","label":"desk surface","depth":4,"shapes":[
{"type":"round_rect","x":140,"y":1180,"w":900,"h":420,"r":26,"fill":"#8a6f4d","alpha":0.5},
{"type":"gradient_fill","x":160,"y":1200,"w":860,"h":380,"colorTop":"#a5865f","colorBottom":"#8a6f4d","alpha":0.35},
{"type":"stroke_path","points":[[150,1190],[1040,1190]],"color":"#26241f","lineWidth":2,"pressureTaper":true},
{"type":"organic_blob","cx":300,"cy":1350,"rBase":90,"harmonics":[0.06,0.1],"fill":"#26241f","alpha":0.18},
{"type":"organic_blob","cx":820,"cy":1300,"rBase":60,"harmonics":[0.05,0.09],"fill":"#f2ead8","alpha":0.3}]}`;

export const GRAPH_SYSTEM_PROMPT = `You are a professional print illustrator who converts design descriptions into layered visual compositions.

Output STRICT JSON only \u2014 schema:
{"lightDeg":number,"layers":[{"id":string,"label":string,"depth":number,"shapes":[...]}],"paletteLocked":[string,...]}

${SHAPES_VOCAB}

${AUTHORING_PROCESS}

${LAYER_RULES}

${DENSITY_EXAMPLE}`;

/**
 * JSONL variant of the same contract: one compact JSON object per line.
 * Every line parses independently, so a token-ceiling cut costs at most
 * the final line instead of corrupting the whole object — the escape
 * hatch when the single-object format keeps truncating.
 */
export const GRAPH_JSONL_SYSTEM_PROMPT = `You are a professional print illustrator who converts design descriptions into layered visual compositions.

Output STRICT JSON LINES \u2014 one COMPACT JSON object per line. NO markdown fences, NO prose, NO trailing commas:
{"lightDeg":number}
{"id":string,"label":string,"depth":number,"shapes":[...]}

The first line declares the lighting angle; EVERY following line is ONE complete layer. Write 10\u201313 layer lines total, each carrying 3\u20135 shapes (focal 6\u201310).

${SHAPES_VOCAB}

${AUTHORING_PROCESS}

${LAYER_RULES}

${DENSITY_EXAMPLE}`;

export function buildGraphUserPrompt(
  fullSpec: string,
  paletteHexes: string[],
): string {
  return [
    "=== DESIGN BRIEF ===",
    fullSpec,
    "",
    "=== PALETTE (use only these plus tints/shades) ===",
    paletteHexes.join(", "),
    "",
    "Compose a layered visual composition graph with 10\u201313 layers.",
    "Order them background \u2192 midground \u2192 focal detail.",
    "Each midground/background layer carries 3\u20135 shapes; the focal layer 6\u201310.",
    "Use organic_blob for atmospheric masses, gradient_fill for paper/washes,",
    "stroke_path for contours \u2014 closed silhouettes (first point repeated",
    "last) get a soft body fill; interior strokes add structure.",
  ].join("\n");
}

/** Same brief as buildGraphUserPrompt plus an explicit reminder of the
 * per-line reply format — models otherwise drift back to one big object. */
export function buildGraphJsonlUserPrompt(
  fullSpec: string,
  paletteHexes: string[],
): string {
  return buildGraphUserPrompt(fullSpec, paletteHexes) +
    "\n\nREPLY FORMAT REMINDER: JSON Lines \u2014 first {\"lightDeg\":N}, then ONE line per layer.";
}

/* ============================ sanitization =============================== */

export function sanitizeCompositionGraph(raw: unknown): CompositionGraph {
  return CompositionGraphSchema.parse(raw);
}

/* ------------------------ layer-order normalization ----------------------- */

const isFinisherLayer = (l: any): boolean =>
  Array.isArray(l.shapes) &&
  (l.shapes as Array<Record<string, unknown>>).some(
    (s) => s?.type === "grain" || s?.type === "vignette");

const isPaperLayer = (l: any): boolean =>
  Array.isArray(l.shapes) &&
  (l.shapes as Array<Record<string, unknown>>).some(
    (s) => s?.type === "gradient_fill" &&
      Number(s?.x ?? 0) <= 1 && Number(s?.y ?? 0) <= 1 &&
      Number(s?.w ?? 0) >= 1100 && Number(s?.h ?? 0) >= 1900);

/** structural subject test — a layer carrying solid body primitives
 * (ellipse / round_rect / closed silhouette). Depth-independent: the
 * normalizeLayerOrder renumbering must not change what "the subject" is. */
const hasSolidBodyLayer = (l: any): boolean =>
  Array.isArray(l.shapes) &&
  (l.shapes as Array<any>).some((s) => s?.type === "ellipse" || s?.type === "round_rect" ||
    (s?.type === "stroke_path" && Array.isArray(s.points) && s.points.length >= 4 &&
     Math.hypot(
       s.points[0]![0]! - s.points[s.points.length - 1]![0]!,
       s.points[0]![1]! - s.points[s.points.length - 1]![1]!,
     ) < 40));

/**
 * Deterministic layer-order repair. The model writes depth values, and a
 * stale/wrong depth makes the paper repaint OVER everything (or the focal
 * sink beneath washes). Instead of trusting the authored numbers: order
 * paper first → content by their authored depth (stable) → finishers last,
 * then re-issue depths evenly across 0..10. Fixes any ordering defect
 * without an LLM round-trip — applied to fresh graphs AND cache hits.
 */
export function normalizeLayerOrder<
  L extends Record<string, unknown>,
>(layers: L[]): L[] {
  if (!Array.isArray(layers) || layers.length < 2) return layers;
  const content = layers.filter((l) => !isFinisherLayer(l));
  const finishers = layers.filter(isFinisherLayer);
  // mixed layers: a "paper" layer that also carries artwork would repaint
  // its blobs OVER everything once forced to depth 0 — split it, keeping
  // only the full-canvas gradient at the bottom and re-homing the rest
  const paper: L[] = [];
  const rest: L[] = [];
  for (const l of content.filter(isPaperLayer)) {
    const paperShapes = (l.shapes as any[]).filter(
      (s) => s?.type === "gradient_fill" &&
        Number(s?.x ?? 0) <= 1 && Number(s?.y ?? 0) <= 1 &&
        Number(s?.w ?? 0) >= 1100 && Number(s?.h ?? 0) >= 1900);
    const extra = (l.shapes as any[]).filter((s) => !paperShapes.includes(s));
    paper.push({ ...l, shapes: paperShapes } as L);
    if (extra.length)
      rest.push({ ...l, id: `${l.id ?? "layer"}-art`, depth: 1, shapes: extra } as L);
  }
  rest.push(...content.filter((l) => !isPaperLayer(l)));
  rest.sort((a, b) => Number(a.depth ?? 0) - Number(b.depth ?? 0)); // stable
  const ordered = [...paper, ...rest, ...finishers];
  const n = ordered.length;
  return ordered.map((l, i) => ({
    ...l,
    depth: n <= 1 ? 0 : Math.min(10, Math.round((i * 10) / (n - 1))),
  }));
}

/* ------------------------ art-direction linting --------------------------- */

interface CritiqueShape {
  type?: string;
  cx?: number; cy?: number; x?: number; y?: number; w?: number; h?: number;
  rBase?: number; rx?: number; ry?: number; fill?: string; alpha?: number;
  points?: number[][];
  shapes?: CritiqueShape[];
}
interface CritiqueLayer {
  id?: string; label?: string; depth?: number; shapes?: CritiqueShape[];
}

/**
 * Deterministic "art director": the LLM authors graphs blind and obeys the
 * letter of the schema while producing dead compositions. This inspects the
 * finished graph for the failure modes that matter visually and returns a
 * short list of concrete complaints — fed back into the compose retry as
 * actionable criticism instead of a bare "reply again".
 */
export function critiqueGraph(
  graph: { lightDeg?: number | undefined; layers?: CritiqueLayer[] },
): string[] {
  const issues: string[] = [];
  const layers = Array.isArray(graph.layers) ? graph.layers : [];
  if (!layers.length) return ["graph has no layers at all"];

  const depthOf = (l: CritiqueLayer): number => Number(l.depth ?? 0);
  const contentLayers = layers.filter((l) => !isFinisherLayer(l));
  const finishers = layers.filter(isFinisherLayer);
  const bodyLayers = contentLayers.filter(hasSolidBodyLayer);

  // the hero subject = the TOPMOST body-carrying layer; when nothing has a
  // solid body, the topmost content layer is treated as the (broken) focal
  const hero = bodyLayers.length
    ? bodyLayers.reduce((a, b) => (depthOf(b) >= depthOf(a) ? b : a))
    : contentLayers.length
      ? contentLayers.reduce((a, b) => (depthOf(b) >= depthOf(a) ? b : a))
      : null;
  const heroShapes = (hero?.shapes ?? []) as Array<any>;

  const centerX = (s: any): number => {
    if (typeof s?.cx === "number") return s.cx;
    if (typeof s?.x === "number" && typeof s?.w === "number") return s.x + s.w / 2;
    return NaN;
  };
  const centerY = (s: any): number => {
    if (typeof s?.cy === "number") return s.cy;
    if (typeof s?.y === "number" && typeof s?.h === "number") return s.y + s.h / 2;
    return NaN;
  };
  const fxs = heroShapes.map(centerX).filter(Number.isFinite);
  const fys = heroShapes.map(centerY).filter(Number.isFinite);

  // 1. the poster needs a subject built from solid geometry
  if (!bodyLayers.length)
    issues.push(
      "no focal subject with a solid body \u2014 add an ellipse/round_rect body or a closed silhouette stroke_path so the poster has a subject",
    );
  else if (heroShapes.length < 4)
    issues.push(
      `focal layer "${hero!.id ?? "?"}" has only ${heroShapes.length} shape(s) \u2014 add interior strokes and shading blobs for volume`,
    );

  // 2. layer-order audit \u2014 depth IS the paint order: backgrounds must not
  //    repaint over the subject, finishers must not be buried
  const paperLayer = layers.find((l) =>
    (l.shapes ?? []).some((s: any) => s?.type === "gradient_fill" &&
      Number(s?.x ?? 0) <= 1 && Number(s?.y ?? 0) <= 1 &&
      Number(s?.w ?? 0) >= 1100 && Number(s?.h ?? 0) >= 1900));
  if (paperLayer) {
    const others = layers.filter((l) => l !== paperLayer).map(depthOf);
    if (others.length && depthOf(paperLayer) > Math.min(...others))
      issues.push(
        `paper base "${paperLayer.id ?? "?"}" (depth ${depthOf(paperLayer)}) is not the bottom layer \u2014 set it to depth 0 so the paper sits under everything`,
      );
  }

  if (bodyLayers.length) {
    const bodyTop = Math.max(...bodyLayers.map(depthOf));
    // content geometry painting over the subject body
    const over = contentLayers.find((l) => {
      if (bodyLayers.includes(l)) return false;
      const d = depthOf(l);
      return d > bodyTop;
    });
    if (over)
      issues.push(
        `layer "${over.id ?? over.label ?? "?"}" (depth ${depthOf(over)}) paints OVER the focal subject \u2014 content must sit below depth ${bodyTop}; move atmospheric/structure layers behind`,
      );
    // large covering washes above the subject body (\u226525% of the canvas)
    const covering = contentLayers.find((l) => {
      if (bodyLayers.includes(l)) return false;
      if (depthOf(l) <= bodyTop) return false;
      return (l.shapes ?? []).some((s: any) => s?.type === "gradient_fill" &&
        Number(s?.w ?? 0) * Number(s?.h ?? 0) >= 0.25 * 1200 * 2000);
    });
    if (covering)
      issues.push(
        `large wash "${covering.id ?? "?"}" (depth ${depthOf(covering)}) paints over the subject layers below \u2014 covering washes belong behind the subject`,
      );
  }

  // 3. grain/vignette finishers belong on top of everything
  if (!finishers.length)
    issues.push(
      "no grain/vignette finisher layer \u2014 the printed-media pass is missing; add one above all content",
    );
  else if (finishers.some((l) => depthOf(l) < Math.max(...contentLayers.map(depthOf))))
    issues.push(
      `grain/vignette layer (depth ${Math.min(...finishers.map(depthOf))}) is buried under content \u2014 finishers must be the topmost layers`,
    );

  // 4. layer count: the brief asks for 10\u201313 \u2014 models park at the old
  //    "at least 8" floor and produce sketch-like compositions
  if (layers.length < 10)
    issues.push(
      `only ${layers.length} layers \u2014 the brief asks for 10\u201313; add atmospheric, structure and detail layers`,
    );

  // 5. density: sparse layers are why posters read as "crude" \u2014 every
  //    background/midground layer needs real geometry, not one token shape
  const shapeTotal = layers.reduce((a, l) => a + (l.shapes?.length ?? 0), 0);
  if (shapeTotal < layers.length * 2.5)
    issues.push(
      `too sparse: ${shapeTotal} shapes across ${layers.length} layers \u2014 aim for 3\u20135 shapes per layer (focal 6\u201310); add washes, structure strokes, shading blobs and accent details`,
    );

  // 6. light direction vs shading masses (lightDeg must actually matter)
  if (fxs.length && fys.length) {
    const rad = ((typeof graph.lightDeg === "number" ? graph.lightDeg : 145) * Math.PI) / 180;
    const lx = Math.cos(rad);
    const ly = Math.sin(rad);
    const shadeLayers = layers.filter((l) =>
      /shade|shadow|deep|dark/i.test(`${l.id ?? ""} ${l.label ?? ""}`));
    for (const l of shadeLayers) {
      for (const s of l.shapes ?? []) {
        const sx = centerX(s);
        const sy = centerY(s);
        if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
        const dot = (sx - fxs.reduce((a, b) => a + b, 0) / fxs.length) * lx +
                    (sy - fys.reduce((a, b) => a + b, 0) / fys.length) * ly;
        if (dot > 60) {
          issues.push(
            `shading mass "${l.id ?? l.label ?? "?"}" sits on the LIGHT side (lightDeg=${graph.lightDeg}) \u2014 move it opposite the light`,
          );
          break;
        }
      }
      if (issues.length >= 4) break;
    }
  }

  // 7. value range: everything at similar alpha reads flat
  const alphas = layers.flatMap((l) => (l.shapes ?? []))
    .map((s: any) => Number(s?.alpha))
    .filter((a) => Number.isFinite(a) && a < 0.98); // ignore the paper base
  if (alphas.length >= 4) {
    const spread = Math.max(...alphas) - Math.min(...alphas);
    if (spread < 0.3)
      issues.push(
        `alpha range too flat (spread ${spread.toFixed(2)}) \u2014 poster will look washed out; deepen the darks to \u2265 0.5`,
      );
  }

  // 8. dead-center focal = static composition
  if (fxs.length && fys.length) {
    const cx = fxs.reduce((a, b) => a + b, 0) / fxs.length;
    const cy = fys.reduce((a, b) => a + b, 0) / fys.length;
    if (Math.abs(cx - 600) < 90 && Math.abs(cy - 1000) < 160)
      issues.push(
        "focal mass is dead center \u2014 shift to a rule-of-thirds intersection",
      );
  }

  return issues.slice(0, 4);
}

/* ------------------------ partial-graph scanning -------------------------- */

export interface PartialGraph {
  lightDeg: number | null;
  layers: Array<Record<string, unknown>>;
}

/** strip leading/trailing markdown code fences (json, jsonlines, js, …) */
export function stripFence(t: string): string {
  return t.replace(/^\s*```[a-z]*\s*/i, "").replace(/```\s*$/, "");
}

/**
 * Per-line (JSONL) graph parser — each layer on its own line tolerates
 * numbering, prose noise and dangling commas; a token-ceiling cut only
 * loses the truncated line instead of the whole reply.
 */
export function parseGraphJsonl(text: string): {
  lightDeg?: number | undefined; layers: Array<Record<string, unknown>>;
  removes: string[]; badLines: number;
} {
  const cleaned = stripFence(text.trim());
  let lightDeg: number | undefined;
  const layers: Array<Record<string, unknown>> = [];
  const removes: string[] = [];
  let badLines = 0;
  for (const raw of cleaned.split(/\r?\n/)) {
    const line = raw.trim();
    const from = line.indexOf("{");
    if (from === -1) continue;               // blank / prose noise
    const to = line.lastIndexOf("}");
    if (to <= from) continue;                // half-open object — dropped
    try {
      const o = JSON.parse(line.slice(from, to + 1).replace(/,\s*$/, "")) as
        Record<string, unknown> & { lightDeg?: number; layers?: unknown[] };
      if (typeof o.lightDeg === "number") lightDeg = o.lightDeg;
      if (typeof o.remove === "string") {    // patch mode: delete a layer by id
        removes.push(o.remove);
        continue;
      }
      if (Array.isArray(o.layers)) {         // legacy single-object line
        layers.push(...(o.layers as Array<Record<string, unknown>>));
        continue;
      }
      if (Array.isArray(o.shapes)) layers.push(o);
    } catch { badLines++; }
  }
  // a header line cut off before its closing brace still carries the angle
  if (lightDeg === undefined) {
    const m2 = /"lightDeg"\s*:\s*(-?[0-9]+(?:\.[0-9]+)?)/.exec(cleaned);
    if (m2) lightDeg = Number(m2[1]);
  }
  return { lightDeg, layers, removes, badLines };
}

/**
 * Incrementally harvest what has arrived so far from a possibly-truncated
 * composition graph stream. Understands BOTH wire shapes the model may use:
 *  • nested single-object JSON  {"lightDeg":x,"layers":[{...},…]}
 *  • per-line JSONL             {"lightDeg":x}\n{layer}\n{layer}…
 * plus markdown fences / assistant-prefill debris / leading prose. Every
 * layer object is emitted the moment its closing brace lands.
 *
 * Used by Studio to redraw the canvas live while the model is still writing.
 */
export function scanPartialGraph(src: string): PartialGraph {
  // ── path A: line-delimited form ──
  const lined = parseGraphJsonl(src);

  // ── path B: nested array inside a single object ──
  const out: PartialGraph = { lightDeg: null, layers: [] };
  const m = /"lightDeg"\s*:\s*(-?[0-9]+(?:\.[0-9]+)?)/.exec(src);
  if (m) out.lightDeg = Number(m[1]);

  const li = src.indexOf('"layers"');
  if (li === -1) return { lightDeg: out.lightDeg ?? lined.lightDeg ?? null, layers: lined.layers };
  let cursor = li + '"layers"'.length;
  while (cursor < src.length && /[\s:]/.test(src[cursor]!)) cursor++;
  if (src[cursor] !== "[") {
    return { lightDeg: out.lightDeg ?? lined.lightDeg ?? null, layers: lined.layers };
  }
  cursor++;

  let inStr = false, esc = false, depth = 0, objStart = -1;
  for (let i = cursor; i < src.length; i++) {
    const ch = src[i]!;
    if (esc) { esc = false; continue; }
    if (ch === "\\") { if (inStr) esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;

    if (objStart === -1) {
      if (ch === "{") { objStart = i; depth = 1; }
      else if (ch === "]") break; // layers array closed — nothing more to harvest
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const layer = JSON.parse(src.slice(objStart, i + 1)) as Record<string, unknown>;
          if (layer && typeof layer === "object" &&
              (Array.isArray(layer.shapes) || typeof layer.depth !== "undefined")) {
            out.layers.push(layer);
          }
        } catch { /* incomplete junk — ignore */ }
        objStart = -1;
      }
    }
  }

  // whichever view of the stream has seen more complete layers wins
  return lined.layers.length > out.layers.length
    ? { lightDeg: lined.lightDeg ?? out.lightDeg ?? null, layers: lined.layers }
    : { lightDeg: out.lightDeg ?? lined.lightDeg ?? null, layers: out.layers };
}
