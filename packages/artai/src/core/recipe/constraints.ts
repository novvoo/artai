/**
 * Batch constraints — the skill's variation discipline as executable rules:
 * ≥3 distinct layout families for batches of 4+; no adjacent layout+focal
 * repeats; adjacent outputs differ on ≥2 of the three grammar axes when they
 * share family or focal form; ≤40% of a batch may carry hue via dot/hairline.
 */
import type { Recipe } from "../types/index.js";

export interface BatchViolation {
  readonly code: string;
  readonly index: number;
  readonly message: string;
}

export function checkBatch(recipes: readonly Recipe[]): BatchViolation[] {
  const out: BatchViolation[] = [];

  if (recipes.length >= 4) {
    const families = new Set(recipes.map((r) => r.layout.family));
    if (families.size < 3) {
      out.push({
        code: "BATCH_TOO_FEW_FAMILIES",
        index: -1,
        message: `batch of ${recipes.length} uses ${families.size} layout families (need ≥3)`,
      });
    }
  }

  for (let i = 1; i < recipes.length; i++) {
    const prev = recipes[i - 1]!;
    const curr = recipes[i]!;
    if (prev.layout.family === curr.layout.family && prev.focal.form === curr.focal.form) {
      out.push({
        code: "BATCH_REPEAT_ADJACENT",
        index: i,
        message: `item ${i} repeats layout+focal pair of item ${i - 1}`,
      });
      continue;
    }
    if (prev.layout.family === curr.layout.family || prev.focal.form === curr.focal.form) {
      const changedAxes =
        (prev.attention.position !== curr.attention.position ? 1 : 0) +
        (prev.type.mode !== curr.type.mode ? 1 : 0);
      if (changedAxes < 2) {
        out.push({
          code: "BATCH_WEAK_VARIETY",
          index: i,
          message: `items ${i - 1}->${i} share ${prev.focal.form === curr.focal.form ? "focal" : "family"} and vary ${changedAxes}/2 remaining axes`,
        });
      }
    }
  }

  const dotCount = recipes.filter(
    (r) => r.color.carrier === "dot" || r.color.carrier === "hairline",
  ).length;
  if (recipes.length >= 3 && dotCount / recipes.length > 0.4) {
    out.push({
      code: "BATCH_DOT_ONLY_HUE",
      index: -1,
      message: `${dotCount}/${recipes.length} items carry hue only via dot/hairline (cap 40%)`,
    });
  }
  return out;
}

/** Re-sample violating items until the batch passes or maxTries is exhausted. */
export function repairBatch(
  recipes: Recipe[],
  regenerate: (index: number, attemptSeed: number) => Recipe,
): { recipes: Recipe[]; violations: BatchViolation[] } {
  let violations = checkBatch(recipes);
  let tries = 0;
  while (violations.length > 0 && tries < 12) {
    tries++;
    for (const v of violations) {
      if (v.index >= 0) recipes[v.index] = regenerate(v.index, tries * 1000 + v.index);
    }
    if (violations.some((v) => v.index < 0) && recipes.length > 0) {
      // whole-batch issue: resample tail items hardest
      for (let k = 0; k < Math.max(1, Math.floor(recipes.length / 3)); k++) {
        const idx = recipes.length - 1 - k;
        if (idx >= 0) recipes[idx] = regenerate(idx, tries * 10_000 + idx);
      }
    }
    violations = checkBatch(recipes);
  }
  return { recipes, violations };
}
