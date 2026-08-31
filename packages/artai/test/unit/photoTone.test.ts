import { describe, expect, it } from "vitest";
import {
  degradePhotoPixels,
  treatmentToDegrade,
} from "../../src/render/photoTone.js";
import { Rng } from "../../src/core/util/rand.js";
import { realize } from "../../src/core/pipeline.js";
import { critiqueGraph } from "../../src/core/scene/graph.js";

/** synthetic photo: horizontal gradient + a dark block */
function gradImage(w: number, h: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dark = x > w / 2 && y > h / 2;
      d[i] = dark ? 30 : Math.round((x / w) * 255);
      d[i + 1] = dark ? 25 : Math.round((y / h) * 255);
      d[i + 2] = dark ? 20 : 128;
      d[i + 3] = 255;
    }
  }
  return d;
}

describe("treatmentToDegrade", () => {
  it("maps recipe texture modes onto photo degradation ops", () => {
    expect(treatmentToDegrade("halftone-degradation")).toBe("halftone");
    expect(treatmentToDegrade("xerox-softness")).toBe("xerox");
    expect(treatmentToDegrade("misregistration")).toBe("misregistration");
    expect(treatmentToDegrade("film-grain")).toBe("grain");
    expect(treatmentToDegrade(undefined)).toBe("plain");
  });
});

describe("degradePhotoPixels", () => {
  it("halftone produces uniform raster cells", () => {
    const W = 64, H = 64;
    const d = gradImage(W, H);
    degradePhotoPixels(d, W, H, "halftone", new Rng("t"));
    const cell = Math.max(3, Math.round(Math.min(W, H) / 64));
    expect(cell).toBeGreaterThanOrEqual(3);
    // all pixels inside one cell share the same color
    for (let y = 0; y < cell - 1; y++) {
      for (let x = 0; x < cell - 1; x++) {
        const a = (y * W + x) * 4, b = (y * W + x + 1) * 4, c = ((y + 1) * W + x) * 4;
        expect(d[a]).toBe(d[b]);
        expect(d[a]).toBe(d[c]);
      }
    }
  });

  it("xerox desaturates toward paper/ink extremes", () => {
    const W = 32, H = 32;
    const d = gradImage(W, H);
    degradePhotoPixels(d, W, H, "xerox", new Rng("t"));
    for (let i = 0; i < W * H * 4; i += 4) {
      expect(d[i]).toBe(d[i + 1]); // desaturated
      expect(d[i]).toBe(d[i + 2]);
      expect(d[i]).toBeGreaterThanOrEqual(0);
      expect(d[i]).toBeLessThanOrEqual(255);
    }
  });

  it("misregistration offsets R and B channels in opposite directions", () => {
    const W = 320, H = 32;
    const src = gradImage(W, H);
    const d = new Uint8ClampedArray(src);
    degradePhotoPixels(d, W, H, "plain", new Rng("t")); // tone-match only baseline
    const shifted = new Uint8ClampedArray(src);
    degradePhotoPixels(shifted, W, H, "misregistration", new Rng("t"));
    const shift = Math.max(2, Math.round(W / 160));
    // pick a pixel far from edges where the mapping is exact
    const x = 160, y = 16, i = (y * W + x) * 4;
    // R came from x+shift, B from x-shift of the tone-matched source
    const base = new Uint8ClampedArray(src);
    degradePhotoPixels(base, W, H, "plain", new Rng("t"));
    expect(shifted[i]).toBe(base[(y * W + x + shift) * 4]);
    expect(shifted[i + 2]).toBe(base[(y * W + x - shift) * 4 + 2]);
    void d;
  });

  it("is deterministic for a given seed", () => {
    const a = gradImage(48, 48), b = gradImage(48, 48);
    degradePhotoPixels(a, 48, 48, "grain", new Rng("seed-1"));
    degradePhotoPixels(b, 48, 48, "grain", new Rng("seed-1"));
    expect([...a]).toEqual([...b]);
    const c = gradImage(48, 48);
    degradePhotoPixels(c, 48, 48, "grain", new Rng("seed-2"));
    expect([...c]).not.toEqual([...a]);
  });
});

describe("photo-input realize wiring", () => {
  it("threads photoAssetId onto the photoFragment op", () => {
    const draft = {
      mode: "photo-input" as const,
      thesis: "旧车票",
      metaphor: { subject: "车票", relation: "与夏天错过" },
      mood: "memory" as const,
      motifHint: "postcard-stamp",
      shortText: "过期",
      lang: "zh",
    };
    const env = realize(draft, { seed: 42, photoAssetId: "photo-abc123" });
    const frag = env.ir.ops.find((o) => o.op === "photoFragment") as
      | { asset?: string | null; treatment?: string } | undefined;
    expect(frag).toBeDefined();
    expect(frag!.asset).toBe("photo-abc123");
    expect(env.recipe.photo?.assetId).toBe("photo-abc123");
  });
});

describe("photo-input pipeline suppression", () => {
  const draft = {
    mode: "photo-input" as const,
    thesis: "旧车票",
    metaphor: { subject: "车票", relation: "错过" },
    mood: "memory" as const,
    motifHint: "postcard-stamp",
    shortText: "过期",
    lang: "zh",
  };

  it("skips the painted motif vignette and hatch when the photo will render", () => {
    const env = realize(draft, { seed: 42, photoAssetId: "photo-x" });
    const kinds = env.ir.ops.map((o) => o.op);
    expect(kinds).toContain("photoFragment");
    expect(kinds).not.toContain("motif");    // would paint OVER the photo
    expect(kinds).not.toContain("hatch");    // would dirty the photo
  });

  it("keeps the painted vignette as fallback when no asset is registered", () => {
    const env = realize(draft, { seed: 42 });
    const kinds = env.ir.ops.map((o) => o.op);
    expect(kinds).toContain("photoFragment"); // asset null → placeholder
    expect(kinds).toContain("motif");
  });
});

describe("critiqueGraph reserved photo box", () => {
  it("flags shapes squatting on the reserved photo rect", () => {
    const issues = critiqueGraph({
      lightDeg: 315,
      layers: [
        { id: "paper", label: "paper", depth: 0, shapes: [
          { type: "gradient_fill", x: 0, y: 0, w: 1200, h: 2000, alpha: 1 },
        ]},
        { id: "focal", label: "painted subject", depth: 8, shapes: [
          // sits right on the photo box below
          { type: "round_rect", x: 300, y: 500, w: 420, h: 640, r: 8,
            fill: "#cbc0dd", alpha: 0.55 },
          { type: "organic_blob", cx: 500, cy: 800, rBase: 90,
            harmonics: [0.1], fill: "#26241f", alpha: 0.3 },
        ]},
        { id: "finish", label: "finish", depth: 9, shapes: [
          { type: "grain", density: 4800 },
          { type: "vignette", intensity: 0.12 },
        ]},
      ],
    }, { reservedBoxes: [{ x0: 320, y0: 520, x1: 700, y1: 1120 }] });
    expect(issues.join(" | ")).toMatch(/reserved photo fragment rect/);
  });
});

describe("stroke_path 2-point line rendering", () => {
  it("a 2-point stroke (clock hand) is rendered, not silently dropped", async () => {
    const { sanitizeCompositionGraph } = await import("../../src/core/scene/graph.js");
    const g = sanitizeCompositionGraph({
      lightDeg: 315,
      layers: [
        { id: "paper", label: "paper", depth: 0, shapes: [
          { type: "gradient_fill", x: 0, y: 0, w: 1200, h: 2000,
            colorTop: "#F5F0E6", colorBottom: "#EFE6D6", alpha: 1 },
        ]},
        { id: "hand", label: "minute hand", depth: 5, shapes: [
          // exactly the case the old `length < 3` check used to drop
          { type: "stroke_path", points: [[620, 1075], [688, 1122]],
            color: "#3A3831", lineWidth: 6, pressureTaper: true },
        ]},
        { id: "finish", label: "finish", depth: 9, shapes: [
          { type: "grain", density: 4800 },
        ]},
      ],
      paletteLocked: ["#26241f", "#d8412f", "#e9e0cc"],
    });
    const hand = g.layers.find((l) => l.id === "hand")!.shapes[0] as
      { type: string; points: number[][] };
    expect(hand.type).toBe("stroke_path");
    expect(hand.points.length).toBe(2); // schema now allows 2
  });
});

describe("render deposition audit (authored⇒deposited)", () => {
  it("shapeBBox covers every geometry-carrying shape type", async () => {
    const { shapeBBox } = await import("../../src/render/verify.js");
    expect(shapeBBox({ type: "round_rect", x: 10, y: 20, w: 100, h: 60 }))
      .toEqual([10, 20, 110, 80]);
    expect(shapeBBox({ type: "ellipse", cx: 0, cy: 0, rx: 30, ry: 40 }))
      .toEqual([-30, -40, 30, 40]);
    expect(shapeBBox({ type: "organic_blob", cx: 100, cy: 100, rBase: 50 }))
      .toEqual([32.5, 32.5, 167.5, 167.5]); // 1.35× for harmonic displacement
    expect(shapeBBox({ type: "stroke_path", points: [[100, 200], [300, 400]],
      lineWidth: 4 })).toEqual([92, 192, 308, 408]); // ±8 pad
    expect(shapeBBox({ type: "grain", density: 2400 })).toBeNull(); // full-canvas
  });

  it("V12 flags ghost washes (alpha < 0.06)", async () => {
    const { critiqueGraph } = await import("../../src/core/scene/graph.js");
    const issues = critiqueGraph({
      lightDeg: 315,
      layers: [
        { id: "paper", label: "paper", depth: 0, shapes: [
          { type: "gradient_fill", x: 0, y: 0, w: 1200, h: 2000,
            colorTop: "#F5F0E6", colorBottom: "#EFE6D6", alpha: 1 },
        ]},
        { id: "focal", label: "cup", depth: 8, shapes: [
          { type: "ellipse", cx: 420, cy: 1050, rx: 95, ry: 115,
            fill: "#cbc0dd", alpha: 0.55 },
          { type: "stroke_path", lineWidth: 4, color: "#26241f",
            points: [[325, 935], [318, 1050], [334, 1150], [420, 1172],
                     [506, 1150], [522, 1050], [515, 937], [325, 935]] },
          { type: "stroke_path", lineWidth: 2, color: "#26241f",
            points: [[335, 1090], [420, 1110], [500, 1095], [335, 1090]] },
          { type: "organic_blob", cx: 470, cy: 980, rBase: 46,
            harmonics: [0.1, 0.12], fill: "#26241f", alpha: 0.3 },
        ]},
        { id: "ghost", label: "ghost plate", depth: 5, shapes: [
          { type: "round_rect", x: 200, y: 600, w: 500, h: 700, r: 8,
            fill: "#3A3831", alpha: 0.04 },
        ]},
        { id: "finish", label: "finish", depth: 9, shapes: [
          { type: "grain", density: 4800 },
          { type: "vignette", intensity: 0.12 },
        ]},
      ],
    });
    expect(issues.join(" | ")).toMatch(/too faint to register/);
  });
});

describe("V15 dark anchor + V13 tint/shade palette", () => {
  it("flags the real washed-out graph (tide mark fixture, spread 0.08)", async () => {
    const { critiqueGraph } = await import("../../src/core/scene/graph.js");
    const { readFileSync } = await import("node:fs");
    const g = JSON.parse(readFileSync(
      new URL("../../test/fixtures/tide-mark-graph.json", import.meta.url), "utf8"));
    const issues = critiqueGraph(g).join(" | ");
    expect(issues).toMatch(/no dark anchor/);
    // V13 must NOT flag #CFD79F — it is a legitimate tint of #9BB53C
    expect(issues).not.toMatch(/sits far outside paletteLocked/);
  });

  it("passes a graph whose focal carries a committed dark mass", async () => {
    const { critiqueGraph } = await import("../../src/core/scene/graph.js");
    const issues = critiqueGraph({
      lightDeg: 315,
      layers: [
        { id: "paper", label: "paper", depth: 0, shapes: [
          { type: "gradient_fill", x: 0, y: 0, w: 1200, h: 2000,
            colorTop: "#F5F0E6", colorBottom: "#EFE6D6", alpha: 1 },
        ]},
        { id: "focal", label: "cup", depth: 8, shapes: [
          { type: "ellipse", cx: 420, cy: 1050, rx: 95, ry: 115,
            fill: "#cbc0dd", alpha: 0.55 },
          { type: "stroke_path", lineWidth: 4, color: "#26241f",
            points: [[325, 935], [318, 1050], [334, 1150], [420, 1172],
                     [506, 1150], [522, 1050], [515, 937], [325, 935]] },
          { type: "stroke_path", lineWidth: 2, color: "#26241f",
            points: [[335, 1090], [420, 1110], [500, 1095], [335, 1090]] },
          { type: "organic_blob", cx: 470, cy: 980, rBase: 46,
            harmonics: [0.1, 0.12], fill: "#26241f", alpha: 0.75 },
        ]},
        { id: "finish", label: "finish", depth: 9, shapes: [
          { type: "grain", density: 4800 },
          { type: "vignette", intensity: 0.12 },
        ]},
      ],
    });
    expect(issues.join(" | ")).not.toMatch(/no dark anchor/);
  });
});
