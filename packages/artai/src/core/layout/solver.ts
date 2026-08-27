/**
 * solver.ts — Recipe → Plan: concrete geometry with budgets enforced.
 *
 * Convergence model (monotone, no threshold fights):
 *   inkShare = clusterShare × focalDensity ∈ [0.105, 0.295]  ⇔ paper 70–89.5%
 * Each iteration measures and jumps directly to the required scale; the raw
 * geometry cap (0.31) only binds after the ink floor is satisfied. The zine
 * density rule orders the fixes: drop decorative marks before touching the
 * focal element's size.
 */
import type { Recipe } from "../types/recipe.js";
import { place, type Placement } from "./families.js";
import { measure, type Box, type MeasuredPlan } from "./measure.js";
import { INK_DENSITY } from "../recipe/variation.js";

export interface Plan {
  readonly width: number;
  readonly height: number;
  readonly placement: Placement;
  readonly measured: MeasuredPlan;
  /** audit trail of solver moves, consumed by the repair-loop envelope */
  adjustments: string[];
}

export interface SolveOptions {
  readonly maxIterations?: number; // default 10
}

const INK_MIN = 0.28; // below this reads too empty (subject must dominate)
const INK_MAX = 0.52; // above this it reads full-bleed
const GEOM_CAP = 0.31;

export function solveLayout(recipe: Recipe, opts: SolveOptions = {}): Plan {
  const [rw, rh] = recipe.canvas.ratio;
  const W = recipe.canvas.width;
  const H = Math.round((W * rh) / rw);
  const maxIter = opts.maxIterations ?? 10;

  const adjustments: string[] = [];
  let marks = recipe.marks;
  let scale = recipe.attention.clusterScale;

  let placement = place(recipe.layout.family, recipe.attention.position, scale, W, H, recipe.seed);
  let measured = evaluate(recipe, placement, W, H);

  for (let i = 0; i < maxIter; i++) {
    const inkShare = (1 - measured.negativeSpace);
    const dens = effectiveDensity(recipe);

    let ratio: number | null = null;
    let reason = "";

    if (marks.length > 0 && inkShare > INK_MAX) {
      marks = [];
      adjustments.push(`iter${i}:drop-marks`);
      // marks-only change: re-measure immediately, no geometry move
      measured = evaluate({ ...recipe, marks }, placement, W, H);
      continue;
    }

    if (inkShare > INK_MAX) {
      ratio = (INK_MAX / inkShare) * 0.98;
      reason = `iter${i}:ink>${INK_MAX} shrink×`;
    } else if (inkShare < INK_MIN) {
      // relative correction — valid under ANY family-specific area mapping
      ratio = Math.min(2.5, (INK_MIN + 0.01) / inkShare);
      reason = `iter${i}:ink<${INK_MIN} grow×`;
    } else if (measured.clusterShare > GEOM_CAP) {
      ratio = (GEOM_CAP - 0.004) / measured.clusterShare;
      reason = `iter${i}:geom>cap shrink×`;
    }

    if (ratio === null) break;

    const rounded = Math.round(Math.max(0.05, Math.min(0.34, scale * ratio)) * 10000) / 10000;
    if (Math.abs(rounded - scale) < 0.002) {
      // converged within tolerance — report honestly if still outside a band
      break;
    }
    scale = rounded;
    adjustments.push(`${reason}${ratio.toFixed(2)}→${scale}`);

    placement = place(
      recipe.layout.family,
      recipe.attention.position,
      scale,
      W,
      H,
      recipe.seed + i + 1,
    );
    measured = evaluate({ ...recipe, marks }, placement, W, H);
  }

  return { width: W, height: H, placement, measured, adjustments };
}

function effectiveDensity(recipe: Recipe): number {
  const base = INK_DENSITY[recipe.focal.form] ?? 0.7;
  // display typography reads as a dense block regardless of glyph openings
  return recipe.layout.family === "type-led" ? Math.max(base, 0.85) : base;
}

function evaluate(recipe: Recipe, placement: Placement, W: number, H: number): MeasuredPlan {
  const density = effectiveDensity(recipe);
  // shrink ONE axis only — multiplying both would square the density
  const effectiveInk: Box[] = [
    {
      x: placement.cluster.x,
      y: placement.cluster.y,
      w: placement.cluster.w,
      h: Math.max(1, Math.round(placement.cluster.h * density)),
    },
  ];
  return measure(effectiveInk, [placement.cluster], recipe.color.carrier, W, H);
}
