import { describe, expect, it } from "vitest";
import { paletteFromPixels } from "../../src/core/recipe/imagePalette.js";
import { realize } from "../../src/core/pipeline.js";
import { paperToneHex } from "../../src/core/types/recipe.js";
import { parseRecipe } from "../../src/core/types/index.js";

/** solid-fill test image: `share` of pixels in `rgb`, rest paper-white */
function fillImage(
  w: number, h: number, rgb: [number, number, number], share: number,
): { px: Uint8ClampedArray; width: number; height: number } {
  const px = new Uint8ClampedArray(w * h * 4).fill(255);
  const inkN = Math.floor(w * h * share);
  for (let i = 0; i < inkN; i++) {
    const p = (i * 4) * 4; // spread deterministically
    px[p] = rgb[0]; px[p + 1] = rgb[1]; px[p + 2] = rgb[2]; px[p + 3] = 255;
  }
  return { px, width: w, height: h };
}

describe("paletteFromPixels", () => {
  it("extracts the dominant saturated cluster as accent", () => {
    const { px, width, height } = fillImage(200, 200, [216, 65, 47], 0.35); // tomato
    const pal = paletteFromPixels(px, width, height);
    expect(pal.accent.toUpperCase()).toBe("#D8412F");
    // white background majority → paper stays near-white
    expect(pal.stats.chromaShare).toBeGreaterThan(0.2);
    expect(pal.stats.contrast).toBeGreaterThan(0.2);
  });

  it("prefers a stronger second hue as accent2 when present", () => {
    const w = 240, h = 240;
    const px = new Uint8ClampedArray(w * h * 4).fill(255);
    const stamp = (rgb: [number, number, number], from: number, to: number): void => {
      for (let i = from; i < to; i++) {
        const p = i * 8;
        px[p] = rgb[0]; px[p + 1] = rgb[1]; px[p + 2] = rgb[2]; px[p + 3] = 255;
      }
    };
    stamp([216, 65, 47], 0, Math.floor(w * h * 0.25));   // tomato
    stamp([27, 79, 216], Math.floor(w * h * 0.25), Math.floor(w * h * 0.4)); // cobalt
    const pal = paletteFromPixels(px, w, h);
    expect(pal.accent.toUpperCase()).toBe("#D8412F");
    expect(pal.accent2.toUpperCase()).toBe("#1B4FD8");
  });

  it("is deterministic and falls back to ink/paper defaults for flat gray", () => {
    const w = 100, h = 100;
    const gray = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < gray.length; i += 4) { gray[i] = 128; gray[i + 1] = 128; gray[i + 2] = 128; gray[i + 3] = 255; }
    const a = paletteFromPixels(gray, w, h);
    const b = paletteFromPixels(gray, w, h);
    expect(a).toEqual(b);
    expect(a.accent).toBe("#2A2723"); // achromatic fallback ink
  });
});

describe("paperToneHex", () => {
  it("resolves keys, passes hex through, and falls back safely", () => {
    expect(paperToneHex("ivory")).toBe("#EFE8D8");
    expect(paperToneHex("#E4E2DC")).toBe("#E4E2DC");
    expect(paperToneHex("#abc")).toBe("#abc");
    expect(paperToneHex("not-a-color")).toBe("#F5F0E6");
  });

  it("a recipe with a literal hex paperTone still parses", () => {
    const rec = parseRecipe({
      schemaVersion: 1, seed: 7, mode: "generate",
      canvas: { ratio: [3, 5], width: 1200, paperTone: "#E7D8C0" },
      attention: { negativeSpace: 0.5, clusterScale: 0.2, position: "upper-right-third" },
      metaphor: { subject: "x", relation: "y" },
      layout: { family: "dual-panel" },
      focal: { form: "color-block", treatment: "risograph-grain" },
      type: { mode: "almost-textless", family: "typewriter" },
      color: { name: "tomato", hue: "#D8412F", carrier: "block", canvasShare: 0.015 },
      texture: { mode: "risograph-grain" },
      marks: [], detail: 2, mood: "quiet",
      provenance: { intentSource: "heuristic" },
    });
    expect(rec.canvas.paperTone).toBe("#E7D8C0");
  });
});

describe("image-palette → realize wiring", () => {
  it("locked accent + hex paperTone reach the recipe AND the scene pixels", () => {
    const draft = {
      mode: "generate" as const,
      thesis: "测试",
      metaphor: { subject: "海浪", relation: "拍岸" },
      mood: "seaside" as const,
      motifHint: "tide-mark",
      shortText: "夏天",
      lang: "zh",
    };
    const env = realize(draft, { seed: 42, accent: "#112233", paperTone: "#E7D8C0" });
    expect(env.recipe.color.hue).toBe("#112233");
    expect(env.recipe.canvas.paperTone).toBe("#E7D8C0");
    // the paper fill op carries the measured tone — before paperToneHex this
    // silently fell back to #F5F0E6 and the image mode had no visible effect
    const paperOp = env.ir.ops.find((o) => o.op === "paper") as
      | { tone?: string } | undefined;
    expect(paperOp?.tone).toBe("#E7D8C0");
  });
});
