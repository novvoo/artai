import { describe, expect, it } from "vitest";
import {
  ACCENT_HUES,
  PAPER_TONES,
  parseRecipe,
} from "../../src/core/types/index.js";
import { pickRecipe } from "../../src/core/recipe/variation.js";

const draft = {
  mode: "generate",
  thesis: "the last train home",
  metaphor: { subject: "an empty platform edge", relation: "a line that leaves" },
  mood: "night",
  lang: "en",
};

describe("recipe schema", () => {
  it("accepts a valid variation output and round-trips through JSON", () => {
    const recipe = pickRecipe(draft, { seed: 42 });
    const roundTrip = parseRecipe(JSON.parse(JSON.stringify(recipe)));
    expect(roundTrip).toEqual(recipe);
  });

  it("strips unknown keys (forward-compat policy)", () => {
    const recipe = pickRecipe(draft, { seed: 1 });
    const dirty = { ...JSON.parse(JSON.stringify(recipe)), futureField: true };
    const parsed = parseRecipe(dirty);
    expect("futureField" in parsed).toBe(false);
  });

  it("rejects out-of-contract negative space", () => {
    const r = pickRecipe(draft, { seed: 2 });
    expect(() =>
      parseRecipe({ ...r, attention: { ...r.attention, negativeSpace: 0.05 } }),
    ).toThrow();
  });

  it("paper tone keys resolve to hex", () => {
    for (const key of Object.keys(PAPER_TONES)) expect(PAPER_TONES[key]).toMatch(/^#/);
    for (const key of Object.keys(ACCENT_HUES)) expect(ACCENT_HUES[key]).toMatch(/^#[0-9A-F]{6}$/i);
  });
});
