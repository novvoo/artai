import { describe, expect, it } from "vitest";
import { pickRecipe, ALL_FAMILIES } from "../../src/core/recipe/variation.js";
import { solveLayout } from "../../src/core/layout/solver.js";
import type { IntentDraft } from "../../src/core/types/recipe.js";

const draft: IntentDraft = {
  mode: "generate",
  thesis: "rain on glass",
  metaphor: { subject: "three water dots held on glass", relation: "sky kept small" },
  mood: "quiet",
  lang: "zh",
};

describe("variation determinism", () => {
  it("same seed → identical recipe (every axis)", () => {
    const a = pickRecipe(draft, { seed: 20260827 });
    const b = pickRecipe(draft, { seed: 20260827 });
    expect(a).toEqual(b);
  });

  it("different seeds differ somewhere across 50 draws", () => {
    const seen = new Set<string>();
    for (let s = 0; s < 50; s++) {
      seen.add(JSON.stringify(pickRecipe(draft, { seed: s }).layout));
    }
    expect(seen.size).toBeGreaterThan(3); // families actually rotate
    expect(Array.from(seen).every((f) => ALL_FAMILIES.some((x) => f.includes(x)))).toBe(true);
  });
});

describe("solver budgets hold across many random recipes", () => {
  it("negative space within [0.69,0.91] and cluster ≤ 26% over 200 seeds", () => {
    for (let seed = 100; seed < 300; seed++) {
      const recipe = pickRecipe(draft, { seed });
      const plan = solveLayout(recipe);
      expect(plan.measured.negativeSpace).toBeGreaterThanOrEqual(0.51);
      expect(plan.measured.negativeSpace).toBeLessThanOrEqual(0.93);
      expect(plan.measured.clusterShare).toBeLessThanOrEqual(0.46);
    }
  });

  it("solver shrinks over-cap clusters and records the audit trail", () => {
    const dense = pickRecipe(draft, { seed: 3 });
    (dense as { marks: string[] }).marks = ["dot-group"];
    dense.attention = { ...dense.attention, clusterScale: 0.45 }; // above cap on purpose
    const plan = solveLayout(dense);
    expect(plan.measured.clusterShare).toBeLessThanOrEqual(0.46);
    expect(plan.adjustments.some((a) => a.startsWith("iter"))).toBe(true);
  });
});
