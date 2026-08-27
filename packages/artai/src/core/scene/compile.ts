/**
 * scene/compile.ts — Recipe × Plan → SceneIR (serializable, versioned).
 * The IR is the fold target of both backends; ops are ordered draw intents.
 */
import type { Recipe } from "../types/recipe.js";
import { PAPER_TONES } from "../types/recipe.js";
import type { Plan } from "../layout/solver.js";
import { MOTIF_STAGING } from "../recipe/motifs.js";
import { mix, shade, tint, DEFAULT_PAPER_HEX } from "../util/color.js";
import { Rng } from "../util/rand.js";

type JobEdge = "cut" | "wet" | "dry" | "emboss";
import { ACCENT_HUES } from "../types/recipe.js";
import { companionHue } from "../recipe/variation.js";

/** safe placement zones for enrichment chips — per-cluster-position opposites */
/** print-grid: every emitted coordinate snaps to this pitch (§ professional
 * grid discipline) — 12 device px at the default canvas width. */
const GRID = 12;
const snap = (v: number): number => Math.round(v / GRID) * GRID;
const snapRect = (b: { x: number; y: number; w: number; h: number }): [number, number, number, number] =>
  [snap(b.x), snap(b.y), snap(b.w), snap(b.h)];
/** edge vocabulary chosen by focal material */
const EDGE_BY_FORM: Record<string, JobEdge> = {
  "color-block": "cut",
  "torn-clipping": "emboss",
  "flat-silhouette": "dry",
  specimen: "dry",
};
/** type scale tokens relative to canvas width (display : caption ≈ 4.6×) */
const TYPE_SCALE = {
  "headline-object": 0.072,
  "floating-letters": 0.036,
  "edge-pressed-phrase": 0.036,
  "diagonal-scattered": 0.032,
  "ghost-text": 0.042,
  "text-in-block": 0.03,
  "archive-microtext": 0.014,
  "almost-textless": 0.02,
} as const;

const CHIP_ZONES: Record<string, Array<{ x: number; y: number }>> = {
  "center-high": [{ x: 0.82, y: 0.9 }, { x: 0.14, y: 0.92 }, { x: 0.8, y: 0.08 }],
  "center-low": [{ x: 0.12, y: 0.1 }, { x: 0.85, y: 0.08 }, { x: 0.16, y: 0.88 }],
  "left-middle": [{ x: 0.84, y: 0.12 }, { x: 0.86, y: 0.88 }, { x: 0.1, y: 0.5 }],
  "right-middle": [{ x: 0.12, y: 0.86 }, { x: 0.1, y: 0.12 }, { x: 0.88, y: 0.5 }],
  "lower-left-third": [{ x: 0.85, y: 0.09 }, { x: 0.8, y: 0.9 }, { x: 0.1, y: 0.45 }],
  "upper-right-third": [{ x: 0.1, y: 0.9 }, { x: 0.16, y: 0.1 }, { x: 0.88, y: 0.55 }],
  "offset-center": [{ x: 0.15, y: 0.9 }, { x: 0.85, y: 0.07 }, { x: 0.9, y: 0.6 }],
};

export const IR_VERSION = 1;

export type { CustomMotifSpec } from "./custom.js";

export interface SceneOp {
  readonly op: string;
  readonly [k: string]: unknown;
}

export interface SceneIR {
  readonly irVersion: typeof IR_VERSION;
  readonly canvas: { width: number; height: number };
  readonly defs: Record<string, Array<{ x: number; y: number }>>;
  readonly ops: SceneOp[];
}

export function compileScene(recipe: Recipe, plan: Plan): SceneIR {
  const p = plan.placement;
  const tone = PAPER_TONES[recipe.canvas.paperTone] ?? PAPER_TONES["warm-white"]!;
  const seedRng = `${recipe.seed}:scene`;

  const ops: SceneOp[] = [];
  const defs: Record<string, Array<{ x: number; y: number }>> = {};
  if (p.polyPoints) defs["cluster-poly"] = p.polyPoints;
  const snapRectOf = (b: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } =>
  ({ x: snap(b.x), y: snap(b.y), w: snap(b.w), h: snap(b.h) });
  const motifBox = p.polyPoints ? polyBBox(p.polyPoints) : rectOf(snapRectOf(p.cluster));

  // resolved motif (mandatory: think-first contract)
  const motifId = recipe.visual?.motifId;
  if (!motifId)
    throw new Error(
      "IntentIncompleteError: no motif id on Recipe \u2014 intent parsing failed or legacy input",
    );

  const accent = recipe.color.hue;
  const isCarrier =
    recipe.color.carrier === "block" ||
    recipe.color.carrier === "cutout" ||
    recipe.color.carrier === "subject" ||
    recipe.color.carrier === "photo-region";
  const panelBase = isCarrier ? tint(accent, 0.7, tone) : "#3a3831";

  /* ---- 1. paper field ---- */
  ops.push({
    op: "paper",
    tone,
    mottle: [0.6, 0.25],
    fibers: true,
  });

  /* ---- 0. underdrawing construction axes ---- */
  ops.push({
    op: "guides",
    at: [snap(plan.width / 2), snap(plan.height / 2)],
    cluster: snapRect(p.cluster),
    color: mix(tone, "#3a3831", 0.55),
  });

  /* ---- 2. backdrop halo — concentric with the focal cluster ---- */
  {
    const bg = new Rng(`${recipe.seed}:backdrop`);
    const kind = bg.weighted({ disc: 26, slab: 27, wedge: 24, none: 23 }) as string;
    if (kind !== "none") {
      const ccx = p.cluster.x + p.cluster.w / 2;
      const ccy = p.cluster.y + p.cluster.h / 2;
      const halfR = Math.min(p.cluster.w, p.cluster.h) * bg.range(0.85, 1.15);
      ops.push({
        op: "backdrop",
        kind,
        box: [snap(ccx - halfR / 2), snap(ccy - halfR / 2), snap(halfR), snap(halfR * (kind === "slab" ? 0.6 : 1))],
        color: mix(ACCENT_HUES[companionHue(recipe.mood, recipe.color.name)]!, tone, 0.58),
        alpha: 0.5,
        rotation: kind === "slab" ? Math.round(bg.range(-9, 9)) : 0,
      });
    }
  }

  /* ---- 3. focal panels, each preceded by its cast shadow ---- */
  const lightDeg = ((recipe.seed % 360) + 360) % 360;
  const shadowOp = (box: [number, number, number, number]): SceneOp => ({
    op: "panelShadow",
    box,
    dx: lightDx(lightDeg, plan.width),
    dy: lightDy(lightDeg, plan.height),
    color: mix(tone, "#1c1b18", 0.5),
    lightDeg,
  });

  if (p.polyPoints) {
    ops.push({ op: "fill", poly: "cluster-poly", style: recipe.focal.form,
      color: panelBase,
      bleed: recipe.focal.treatment === "letterpress-bleed" ? [0.25, "out"] : undefined,
      texture: { t: 0.35, b: 0.4, scatter: true } });
  } else {
    [p.cluster, ...p.extraPanels].forEach((panel, i) => {
      const box = [snap(panel.x), snap(panel.y), snap(panel.w), snap(panel.h)] as [number,number,number,number];
      const isPhoto = recipe.focal.form.includes("photo");
      if (!isPhoto) ops.push(shadowOp(box));
      ops.push(isPhoto
        ? { op: "photoFragment", box, asset: null, preserve: recipe.photo?.preservation ?? null,
            color: "#cfc4ad", index: i }
        : { op: "fill", box, color: i === 0 ? panelBase : shade(panelBase, 0.18),
            bleed: recipe.focal.treatment === "letterpress-bleed" ? [0.2, "out"] : undefined,
            texture: recipe.focal.treatment !== "letterpress-bleed" ? { mode: recipe.focal.treatment } : undefined,
            paper: tone, trim: true, index: i });
    });
  }

  /* ---- 3b. flow-field stroke set (the "living ink" underlayer,
        algorithm lifted straight from the p5.brush spiral example) ---- */
  {
    const fsr = new Rng(`${recipe.seed}:strokes`);
    const count = Math.round(fsr.range(3, 3 + (recipe.detail ?? 3)));
    const cx = snap(p.cluster.x + p.cluster.w / 2);
    const cy = snap(p.cluster.y + p.cluster.h / 2);
    const rMax = snap(Math.min(p.cluster.w, p.cluster.h) * fsr.range(0.42, 0.72));
    const palette = [
      mix(accent, tone, 0.25),
      ACCENT_HUES[companionHue(recipe.mood, recipe.color.name)]!,
      mix(accent, "#1c1b18", 0.22),
    ];
    ops.push({
      op: "strokeset",
      box: [snap(cx - rMax * 1.2), snap(cy - rMax * 1.2), snap(rMax * 2.4), snap(rMax * 2.4)],
      count,
      rMax,
      turns: fsr.int(2, 6),
      field: fsr.pick(["curved", "seabed", "waves"] as const),
      palette,
      seedStr: `${recipe.seed}:ink`,
    });
  }

  /* ---- 4. motif vignette (86% of the cluster core) ---- */
  const motifAccent = isCarrier ? accent : mix(accent, "#26241f", 0.25);
  ops.push({
    op: "motif",
    id: motifId,
    box: motifBox.map(snap),
    accent: motifAccent,
    accent2: ACCENT_HUES[companionHue(recipe.mood, recipe.color.name)]!,
    paper: tone,
    mode: "collage-fill",
    lightDeg,
    edge: EDGE_BY_FORM[recipe.focal.form] ?? "wet",
  });

  /* ---- 5. hatch pass per treatment ---- */
  if (recipe.focal.treatment === "halftone-degradation" || recipe.focal.treatment === "risograph-grain") {
    ops.push({ op: "hatch", region: p.polyPoints ? "cluster-poly" : undefined,
      box: p.polyPoints ? undefined : [p.cluster.x, p.cluster.y, p.cluster.w, p.cluster.h],
      dist: recipe.focal.treatment === "halftone-degradation" ? 5 : 7,
      angle: 35, options: { rand: 0.3, continuous: false },
      brush: "hatch_brush", color: "#43413c" });
  }

  /* ---- 6. typography: phrase or archival mood caption ---- */
  const captionText =
    recipe.type.text ||
    (recipe.mood === "summer" ? "蝉声" :
     recipe.mood === "night"  ? "夜行" :
     recipe.mood === "seaside"? "退潮" :
     recipe.mood === "memory" ? "旧时" :
     recipe.mood === "quiet"  ? "静" : humanizeMood(recipe.mood));
  const scaleTok = TYPE_SCALE[recipe.type.mode] ?? 0.03;
  const sizePx = Math.max(20, Math.round(plan.width * scaleTok));
  const tySafe = snap(Math.min(Math.max(plan.placement.typeAnchor.y,
                Math.round(plan.height*0.08)),
                Math.round(plan.height*0.86)));
  const capX = snap(Math.min(Math.max(plan.placement.cluster.x,
                plan.width * 0.07), plan.width * 0.93));
  if (sizePx >= plan.width * 0.048) {
    ops.push({ op: "captionRule", x1: capX, x2: snap(capX + Math.min(p.cluster.w * 1.15, plan.width * 0.6)),
      y: tySafe + Math.round(sizePx * 0.55), color: "#55524b" });
  }
  ops.push({ op: "text", str: captionText, at: [capX, tySafe], font: recipe.type.family,
    sizePx, mode: recipe.type.mode, ghost: recipe.type.mode === "ghost-text" ? 0.22 : 1,
    color: "#26241f", paper: tone });

  /* ---- 7. orbital chips hugging the focal rim (never confetti) ---- */
  {
    const cr = new Rng(`${recipe.seed}:chips`);
    const n = cr.int(1, 2);
    const ccx = p.cluster.x + p.cluster.w / 2;
    const ccy = p.cluster.y + p.cluster.h / 2;
    const orbR = Math.max(p.cluster.w, p.cluster.h) * 0.78;
    for (let k = 0; k < n; k++) {
      const a = cr.range(0, Math.PI * 2);
      const ax = ccx + Math.cos(a) * orbR;
      const ay = ccy + Math.sin(a) * orbR;
      ops.push({
        op: "chip",
        variant: cr.pick(["dotgrid","regis","tickrow"] as const),
        at: [
          snap(clampMargin(ax, plan.width)),
          snap(clampMargin(ay, plan.height)),
        ],
        color: k === 0 ? "#55524b" : mix(recipe.color.hue, "#55524b", 0.45),
        scale: Math.round(cr.range(0.8, 1.25) * 100) / 100,
        rotation: 0,
      });
    }
  }

  /* ---- 8. decorative marks riding the placement anchors ---- */
  let mk = 0;
  for (const kind of recipe.marks) {
    const anch = p.markAnchors[mk % Math.max(1, p.markAnchors.length)] ?? { x: snap(plan.width*0.85), y: snap(plan.height*0.9) };
    ops.push({ op: "mark", kind, at: [anch.x, anch.y], color: "#55524b", id: mk++ });
  }

  /* ---- 9. archival microtext + framing chrome ---- */
  ops.push({ op: "microtext",
    str: `NO.${((recipe.seed % 89) + 11).toString().padStart(2,"0")} · ${recipe.mood.toUpperCase().slice(0,9)}`,
    align: "right",
    at: [snap(plan.width - plan.width*0.07), snap(plan.height - plan.height*0.05)],
    sizePx: Math.max(10, Math.round(plan.width*0.011)), color: "#5b574e", paper: tone });
  if (recipe.marks.length > 0 || recipe.attention.negativeSpace < 0.62) {
    ops.push({ op: "frame", inset: 16, color: mix(tone, "#55524b", 0.35), alpha: 0.5 });
  }

  /* ---- 10. postpress defects ---- */
  ops.push({ op: "postpress", mode: recipe.focal.treatment,
    misregistrationPx: recipe.texture.misregistration != null
      ? Math.round(recipe.texture.misregistration * 6) : 0,
    grain: seedRng });

  return { irVersion: IR_VERSION, canvas: { width: plan.width, height: plan.height }, defs, ops };
}

/** light-borne shadow vectors (shared sun discipline) */
function lightDx(deg: number, W: number): number {
  return -Math.round(Math.cos((deg*Math.PI)/180) * W * 0.012);
}
function lightDy(deg: number, H: number): number {
  return Math.round(Math.abs(Math.sin((deg*Math.PI)/180)) * H * 0.006);
}
function humanizeMood(m: Recipe["mood"]): string {
  return m.charAt(0).toUpperCase() + m.slice(1);
}
/** keep orbital accents inside the inner margin band */
function clampMargin(v: number, span: number): number {
  const pad = span * 0.07;
  return Math.min(Math.max(v, pad), span - pad);
}


function rectOf(b: { x: number; y: number; w: number; h: number }): Array<number> {
  return [b.x, b.y, b.w, b.h];
}

function polyBBox(pts: Array<{ x: number; y: number }>): Array<number> {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return [minX, minY, Math.max(...xs) - minX, Math.max(...ys) - minY];
}
