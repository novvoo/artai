import { describe, expect, it } from "vitest";
import {
  drawGraphToCtx,
  graphToScript,
  hexToRgba,
  mulberry32,
} from "../../src/core/scene/graphRender.js";
import { sanitizeCompositionGraph, critiqueGraph } from "../../src/core/scene/graph.js";
import { overlayAvoidSubject } from "../../src/render/index.js";

/** minimal ctx double: absorbs every call, records fill/stroke ops */
function makeCtxStub() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const grad = { addColorStop: () => {} };
  const ctx: Record<string, unknown> = {
    calls,
    lineCap: "",
    lineJoin: "",
    globalAlpha: 1,
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 1,
    beginPath: () => calls.push({ fn: "beginPath", args: [] }),
    closePath: () => calls.push({ fn: "closePath", args: [] }),
    moveTo: (...a: unknown[]) => calls.push({ fn: "moveTo", args: a }),
    lineTo: (...a: unknown[]) => calls.push({ fn: "lineTo", args: a }),
    rect: (...a: unknown[]) => calls.push({ fn: "rect", args: a }),
    fillRect: (...a: unknown[]) => calls.push({ fn: "fillRect", args: a }),
    clip: () => calls.push({ fn: "clip", args: [] }),
    save: () => calls.push({ fn: "save", args: [] }),
    restore: () => calls.push({ fn: "restore", args: [] }),
    fill: () => calls.push({ fn: "fill", args: [] }),
    stroke: () => calls.push({ fn: "stroke", args: [] }),
    setLineDash: (...a: unknown[]) => calls.push({ fn: "setLineDash", args: a }),
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    translate: (...a: unknown[]) => calls.push({ fn: "translate", args: a }),
    rotate: (...a: unknown[]) => calls.push({ fn: "rotate", args: a }),
    ellipse: (...a: unknown[]) => calls.push({ fn: "ellipse", args: a }),
    arcTo: (...a: unknown[]) => calls.push({ fn: "arcTo", args: a }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const sampleGraph = sanitizeCompositionGraph({
  lightDeg: 145,
  paletteLocked: ["#d8412f", "#26241f", "#e9e0cc"],
  layers: [
    { id: "paper", label: "paper", depth: 0, shapes: [
      { type: "gradient_fill", x: 0, y: 0, w: 1200, h: 2000,
        colorTop: "#fbf6ea", colorBottom: "#e9e0cc", alpha: 1 },
    ]},
    { id: "wash", label: "wash", depth: 1, shapes: [
      { type: "organic_blob", cx: 600, cy: 700, rBase: 380,
        harmonics: [0.05, 0.09, 0.14], fill: "#d8412f", alpha: 0.14 },
    ]},
    { id: "focal", label: "focal", depth: 8, shapes: [
      { type: "stroke_path", points: [[200, 900], [500, 760], [800, 900]],
        color: "#26241f", lineWidth: 14 },
    ]},
    { id: "print", label: "print", depth: 10, shapes: [
      { type: "vignette", intensity: 0.16 },
      { type: "grain", density: 400, twoTone: true },
    ]},
  ],
});

describe("graphRender", () => {
  it("draws layers in depth order and clips to the canvas", () => {
    const { ctx, calls } = makeCtxStub();
    drawGraphToCtx(ctx, sampleGraph, { width: 600, height: 1000, seed: 3 });
    expect(calls.some((c) => c.fn === "clip")).toBe(true);
    // depth sort: paper (0) first, print (10) last
    const firstFill = calls.findIndex((c) => c.fn === "fillRect");
    expect(firstFill).toBeGreaterThan(-1);
    // gradient fill paints the full canvas rect first (0,0 → W,H)
    const rectCall = calls.find((c) => c.fn === "fillRect")!;
    expect(rectCall.args).toEqual([0, 0, 600, 1000]);
    // grain painted tiny 1px marks inside the clipped pass
    const grainRects = calls.filter((c) => c.fn === "fillRect" && c.args[2] === 1);
    expect(grainRects.length).toBeGreaterThan(0);
    // final op is the outer restore (clip guard released last)
    expect(calls[calls.length - 1].fn).toBe("restore");
  });

  it("blob path never exceeds canvas bounds (clip protects overflow)", () => {
    const { ctx, calls } = makeCtxStub();
    const huge = sanitizeCompositionGraph({
      lightDeg: 0,
      paletteLocked: ["#a11", "#b22", "#c33"],
      layers: [
        { id: "a", label: "a", depth: 0, shapes: [
          { type: "organic_blob", cx: -5000, cy: -5000, rBase: 9000,
            harmonics: [3, 3, 3, 3], fill: "#a11", alpha: 0.9 },
        ]},
        { id: "b", label: "b", depth: 1, shapes: [
          { type: "vignette", intensity: 0.1 },
        ]},
      ],
    });
    drawGraphToCtx(ctx, huge, { width: 200, height: 300, seed: 1 });
    // all moveTo/lineTo coordinates land within [−rBase*1.8, ...] but clip() was
    // called before any shape drew — overflow can never reach the canvas.
    expect(calls.some((c) => c.fn === "clip")).toBe(true);
  });

  it("harmonics normalization is scale-agnostic", () => {
    const { ctx: c1, calls: k1 } = makeCtxStub();
    const { ctx: c2, calls: k2 } = makeCtxStub();
    const base = { cx: 300, cy: 300, rBase: 100, fill: "#333", alpha: 0.5 };
    const small = sanitizeCompositionGraph({
      lightDeg: 0, paletteLocked: ["#111", "#222", "#333"],
      layers: [
        { id: "a", label: "a", depth: 0, shapes: [
          { ...base, type: "organic_blob", harmonics: [0.05, 0.1, 0.2] },
        ]},
        { id: "b", label: "b", depth: 1, shapes: [
          { type: "vignette", intensity: 0.1 },
        ]},
      ],
    });
    const big = sanitizeCompositionGraph({
      lightDeg: 0, paletteLocked: ["#111", "#222", "#333"],
      layers: [
        { id: "a", label: "a", depth: 0, shapes: [
          { ...base, type: "organic_blob", harmonics: [1, 2, 4] },
        ]},
        { id: "b", label: "b", depth: 1, shapes: [
          { type: "vignette", intensity: 0.1 },
        ]},
      ],
    });
    drawGraphToCtx(c1, small, { width: 600, height: 600, seed: 9 });
    drawGraphToCtx(c2, big, { width: 600, height: 600, seed: 9 });
    // identical phase rng stream + normalized amplitudes ⇒ identical vertices
    expect(k1.filter((c) => c.fn === "moveTo" || c.fn === "lineTo"))
      .toEqual(k2.filter((c) => c.fn === "moveTo" || c.fn === "lineTo"));
  });

  it("graphToScript embeds the graph and runs standalone (exec-able)", () => {
    const script = graphToScript(sampleGraph, { width: 300, height: 500, seed: 7 });
    expect(script).toContain('"layers"');
    expect(script).toContain("drawGraphToCtx(ctx, GRAPH");
    expect(script).toContain("function drawGraphToCtx");
    expect(script).toContain("function mulberry32");
    // deterministic: same input ⇒ byte-identical script
    expect(graphToScript(sampleGraph, { width: 300, height: 500, seed: 7 }))
      .toBe(script);
  });

  it("hexToRgba parses 3/6-digit hex and falls back safely", () => {
    expect(hexToRgba("#d8412f", 0.5)).toBe("rgba(216,65,47,0.5)");
    expect(hexToRgba("abc", 1)).toBe("rgba(170,187,204,1)");
    expect(hexToRgba("not-a-color", 0.3)).toBe("rgba(30,28,24,0.3)");
  });

  it("mulberry32 is a deterministic PRNG", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seq1 = [a(), a(), a()];
    const seq2 = [b(), b(), b()];
    expect(seq1).toEqual(seq2);
    expect(seq1[0]).toBeGreaterThanOrEqual(0);
    expect(seq1[0]).toBeLessThan(1);
  });

  it("gradient_fill paints ONLY its authored rectangle, not the canvas", () => {
    // regression: this used to fillRect(0,0,W,H) and drown every poster
    const { ctx, calls } = makeCtxStub();
    const g = sanitizeCompositionGraph({
      lightDeg: 145,
      paletteLocked: ["#d8412f", "#26241f", "#e9e0cc"],
      layers: [
        { id: "wash", label: "wash", depth: 1, shapes: [
          { type: "gradient_fill", x: 100, y: 200, w: 500, h: 700,
            colorTop: "#cbc0dd", colorBottom: "#ddd4e8", alpha: 0.22 },
        ]},
        { id: "plate", label: "plate", depth: 9, shapes: [
          { type: "round_rect", x: 60, y: 1800, w: 200, h: 60, fill: "#26241f", alpha: 0.4 },
        ]},
      ],
    });
    drawGraphToCtx(ctx, g, { width: 1200, height: 2000, seed: 3 });
    const rects = calls.filter((c) => c.fn === "fillRect").map((c) => c.args);
    expect(rects).toContainEqual([100, 200, 500, 700]);
    expect(rects).not.toContainEqual([0, 0, 1200, 2000]);
  });

  it("dispatches ellipse and round_rect shapes", () => {
    const { ctx, calls } = makeCtxStub();
    const g = sanitizeCompositionGraph({
      lightDeg: 200,
      paletteLocked: ["#d8412f", "#26241f", "#e9e0cc"],
      layers: [
        { id: "cup", label: "cup body", depth: 8, shapes: [
          { type: "ellipse", cx: 470, cy: 1000, rx: 90, ry: 110, fill: "#cbc0dd", alpha: 0.6 },
          { type: "round_rect", x: 300, y: 1400, w: 340, h: 220, r: 18, fill: "#26241f", alpha: 0.5 },
        ]},
        { id: "finish", label: "finish", depth: 9, shapes: [
          { type: "vignette", intensity: 0.1 },
        ]},
      ],
    });
    drawGraphToCtx(ctx, g, { width: 1200, height: 2000, seed: 5 });
    expect(calls.some((c) => c.fn === "ellipse")).toBe(true);
    expect(calls.filter((c) => c.fn === "arcTo").length).toBeGreaterThanOrEqual(4);
    // exported script carries the new painters and stays deterministic
    const script = graphToScript(g, { width: 600, height: 1000, seed: 2 });
    expect(script).toContain("function drawEllipse");
    expect(script).toContain("function drawRoundRect");
  });

  it("closed stroke_path silhouettes get a soft body fill", () => {
    const { ctx, calls } = makeCtxStub();
    const g = sanitizeCompositionGraph({
      lightDeg: 315,
      paletteLocked: ["#d8412f", "#26241f", "#e9e0cc"],
      layers: [
        { id: "focal", label: "focal", depth: 8, shapes: [
          { type: "stroke_path", lineWidth: 4, color: "#6a4fc7",
            points: [[380, 848], [372, 958], [386, 1042], [470, 1064],
                     [554, 1042], [568, 950], [560, 850], [380, 848]] },
        ]},
        { id: "finish", label: "finish", depth: 9, shapes: [
          { type: "vignette", intensity: 0.1 },
        ]},
      ],
    });
    drawGraphToCtx(ctx, g, { width: 1200, height: 2000, seed: 1 });
    // one fill for the body + one stroke pass chain
    expect(calls.filter((c) => c.fn === "fill").length).toBeGreaterThanOrEqual(1);
    expect(calls.some((c) => c.fn === "closePath")).toBe(true);
  });
});

describe("overlayAvoidSubject — text keeps off the artwork", () => {
  const graph = {
    lightDeg: 315,
    layers: [
      { id: "paper", label: "paper", depth: 0, shapes: [
        { type: "gradient_fill", x: 0, y: 0, w: 1200, h: 2000, alpha: 1 },
      ]},
      { id: "focal", label: "cup", depth: 8, shapes: [
        { type: "ellipse", cx: 600, cy: 1000, rx: 200, ry: 240,
          fill: "#cbc0dd", alpha: 0.55 },
        { type: "organic_blob", cx: 600, cy: 1000, rBase: 90,
          harmonics: [0.1], fill: "#26241f", alpha: 0.3 },
      ]},
    ],
  };
  const ir = {
    canvas: { width: 1200, height: 2000 },
    ops: [
      { op: "text", str: "错过的夏天", at: [600, 1050], sizePx: 64,
        mode: "headline-object", color: "#26241f" },
      { op: "microtext", str: "NO.0721", align: "right", at: [1116, 1900],
        sizePx: 12, color: "#5b574e" },
    ],
  };

  it("moves a text op that lands on the subject", () => {
    const out = overlayAvoidSubject(graph, ir) as typeof ir;
    const text = out.ops[0] as any;
    // headline (5 CJK chars @ ~108px ≈ 540px wide) relocated to the bottom
    // band — its estimated ink box must clear the subject's bottom edge (1240)
    expect(text.at[0]).not.toBe(600);
    expect(text.at[1] - 108).toBeGreaterThan(1240);
  });

  it("leaves text that already sits in the clear untouched", () => {
    const out = overlayAvoidSubject(graph, ir) as typeof ir;
    const micro = out.ops[1] as any;
    expect(micro.at[0]).toBe(1116);
    expect(micro.at[1]).toBe(1900);
  });

  it("is a no-op when the graph has no subject layer", () => {
    const bare = { layers: [{ id: "paper", depth: 0, shapes: [
      { type: "gradient_fill", x: 0, y: 0, w: 1200, h: 2000, alpha: 1 },
    ]}] };
    expect(overlayAvoidSubject(bare, ir)).toBe(ir);
  });
});

describe("critiqueGraph — art-director gate", () => {
  it("flags wireframe focal, dead-center mass and light-side shadows", () => {
    const issues = critiqueGraph({
      lightDeg: 145, // light source toward upper-left
      layers: [
        { id: "paper", label: "paper", depth: 0, shapes: [
          { type: "gradient_fill", x: 0, y: 0, w: 1200, h: 2000, alpha: 1 },
        ]},
        { id: "focal", label: "focal", depth: 8, shapes: [
          { type: "stroke_path", lineWidth: 3, color: "#000",
            points: [[560, 900], [600, 1100], [660, 980]] },        // open, no body
          { type: "organic_blob", cx: 640, cy: 950, rBase: 80,
            harmonics: [0.1, 0.1], fill: "#888", alpha: 0.3 },
        ]},
        { id: "shade", label: "deep shade", depth: 5, shapes: [
          // (542,1019) = focal + light direction ⇒ shadow on the LIT side
          { type: "organic_blob", cx: 542, cy: 1019, rBase: 100,
            harmonics: [0.1, 0.1], fill: "#222", alpha: 0.3 },
        ]},
      ],
    });
    const joined = issues.join(" | ");
    expect(joined).toMatch(/wireframe-only|body/);   // no solid body
    expect(joined).toMatch(/printed-media pass is missing/); // no grain/vignette layer
    expect(joined).toMatch(/only 3 layers/);          // below the 10-layer floor
    expect(joined).toMatch(/sparse/);                 // 5 shapes across 3 layers
  });

  it("flags layer-order defects: paper above content, content over focal, buried finisher", () => {
    const issues = critiqueGraph({
      lightDeg: 145,
      layers: [
        { id: "atmo", label: "atmosphere", depth: 0, shapes: [
          { type: "organic_blob", cx: 400, cy: 600, rBase: 300,
            harmonics: [0.1, 0.1], fill: "#cbc0dd", alpha: 0.2 },
        ]},
        // paper base NOT at the bottom
        { id: "paper", label: "paper", depth: 5, shapes: [
          { type: "gradient_fill", x: 0, y: 0, w: 1200, h: 2000,
            colorTop: "#f2ead8", colorBottom: "#d9c9a8", alpha: 1 },
        ]},
        // content painting OVER the focal subject (depth 9 > focal 8)
        { id: "wash", label: "wash", depth: 9, shapes: [
          { type: "gradient_fill", x: 100, y: 400, w: 700, h: 900,
            colorTop: "#cbc0dd", colorBottom: "#ddd4e8", alpha: 0.2 },
        ]},
        { id: "focal", label: "focal", depth: 8, shapes: [
          { type: "ellipse", cx: 470, cy: 1050, rx: 95, ry: 115,
            fill: "#cbc0dd", alpha: 0.55 },
          { type: "stroke_path", lineWidth: 4, color: "#26241f",
            points: [[375, 935], [368, 1050], [384, 1150], [470, 1172],
                     [556, 1150], [572, 1050], [565, 937], [375, 935]] },
          { type: "stroke_path", lineWidth: 2, color: "#26241f",
            points: [[390, 1090], [470, 1108], [548, 1094], [390, 1090]] },
          { type: "organic_blob", cx: 520, cy: 980, rBase: 46,
            harmonics: [0.1, 0.12], fill: "#26241f", alpha: 0.3 },
        ]},
        // finisher buried under content (depth 2 < top content 9)
        { id: "grain", label: "grain", depth: 2, shapes: [
          { type: "grain", density: 4800 },
        ]},
      ],
    });
    const joined = issues.join(" | ");
    expect(joined).toMatch(/is not the bottom layer/);
    expect(joined).toMatch(/paints OVER the focal subject/);
    expect(joined).toMatch(/finishers must be the topmost|buried under content/);
  });

  it("flags a flat alpha range on its own", () => {
    const issues = critiqueGraph({
      lightDeg: 145,
      layers: [
        { id: "paper", label: "paper", depth: 0, shapes: [
          { type: "gradient_fill", x: 0, y: 0, w: 1200, h: 2000, alpha: 1 },
        ]},
        { id: "washes", label: "washes", depth: 2, shapes: [
          { type: "organic_blob", cx: 200, cy: 300, rBase: 120,
            harmonics: [0.1], fill: "#cbc0dd", alpha: 0.2 },
          { type: "organic_blob", cx: 900, cy: 500, rBase: 120,
            harmonics: [0.1], fill: "#cbc0dd", alpha: 0.25 },
          { type: "organic_blob", cx: 300, cy: 1500, rBase: 120,
            harmonics: [0.1], fill: "#cbc0dd", alpha: 0.28 },
          { type: "organic_blob", cx: 950, cy: 1600, rBase: 120,
            harmonics: [0.1], fill: "#cbc0dd", alpha: 0.22 },
        ]},
      ],
    });
    expect(issues.join(" ")).toMatch(/flat/);
  });

  /** 10+ dense layers that satisfy every art-director check */
  function gatePassingGraph() {
    const layers: any[] = [
      { id: "paper", label: "paper", depth: 0, shapes: [
        { type: "gradient_fill", x: 0, y: 0, w: 1200, h: 2000, alpha: 1 },
      ]},
    ];
    for (let i = 0; i < 7; i++) {
      layers.push({ id: `mid${i}`, label: `mid ${i}`, depth: 1 + (i % 5), shapes: [
        { type: "gradient_fill", x: 80 + i * 70, y: 260 + i * 160, w: 520, h: 300,
          colorTop: "#cbc0dd", colorBottom: "#ddd4e8", alpha: 0.1 + i * 0.02 },
        { type: "organic_blob", cx: 280 + i * 100, cy: 480 + i * 130, rBase: 120,
          harmonics: [0.06, 0.09], fill: "#cbc0dd", alpha: 0.14 + i * 0.02 },
        { type: "stroke_path", lineWidth: 1.5, color: "#26241f", pressureTaper: true,
          points: [[90 + i * 50, 420 + i * 150], [500 + i * 40, 470 + i * 150],
                   [1000 - i * 30, 430 + i * 150]] },
      ]});
    }
    layers.push(
      { id: "wash", label: "wash", depth: 4, shapes: [
        { type: "organic_blob", cx: 380, cy: 700, rBase: 300,
          harmonics: [0.05, 0.08], fill: "#cbc0dd", alpha: 0.2 },
        { type: "round_rect", x: 120, y: 1560, w: 960, h: 300, r: 20,
          fill: "#e9e0cc", alpha: 0.3 },
        { type: "stroke_path", lineWidth: 2, color: "#26241f", pressureTaper: true,
          points: [[140, 1590], [600, 1610], [1060, 1590]] },
      ]},
      { id: "focal", label: "cup body", depth: 8, shapes: [
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
      { id: "finish", label: "finish", depth: 9, shapes: [
        { type: "grain", density: 4800 },
        { type: "vignette", intensity: 0.12 },
      ]},
    );
    return { lightDeg: 315, layers, paletteLocked: ["#d8412f", "#26241f", "#e9e0cc"] };
  }

  it("passes a well-composed dense graph with zero complaints", () => {
    expect(critiqueGraph(gatePassingGraph())).toEqual([]);
  });

  it("flags a sparse graph: too few layers and too few shapes per layer", () => {
    // the earlier "good" graph — now below the density bar
    const sparse = {
      lightDeg: 315,
      layers: gatePassingGraph().layers.slice(0, 3), // paper + 2 mids
    };
    const issues = critiqueGraph(sparse);
    const joined = issues.join(" | ");
    expect(joined).toMatch(/layers/);     // 4 < 10
    expect(joined).toMatch(/sparse/);     // shapes across layers too thin
  });
});
