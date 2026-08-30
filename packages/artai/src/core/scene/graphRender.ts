/**
 * scene/graphRender.ts — deterministic Canvas-2D renderer for CompositionGraph.
 *
 * The LLM-authored graph (scene/graph.ts) describes layers of gradient washes,
 * organic blobs, tapered strokes, vignette and grain. This module turns that
 * graph into pixels. The SAME functions are also embedded by graphToScript()
 * into a standalone, copyable script, so the studio preview and the exported
 * code always execute identical drawing logic (single source of truth via
 * Function.prototype.toString — the package builds with minify:false).
 *
 * Design space is 1200×2000 (the graph coordinates live there); the renderer
 * scales to the actual canvas size. Every random call is seeded, so a graph +
 * seed reproduces byte-identical output.
 */

import type { CompositionGraph } from "./graph.js";

export interface GraphRenderOptions {
  /** output canvas width in px (default 1200) */
  width?: number;
  /** output canvas height in px (default 2000) */
  height?: number;
  /** deterministic seed (default 1) */
  seed?: number;
  /** design-space size the graph coordinates refer to (default 1200×2000) */
  designWidth?: number;
  designHeight?: number;
}

export interface GraphRenderResult {
  dataUrl: string;
  width: number;
  height: number;
  renderer: "graph-canvas";
  warnings: string[];
}

export const DESIGN_W = 1200;
export const DESIGN_H = 2000;

/* --------------------------- deterministic PRNG -------------------------- */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------- color utils ----------------------------- */

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return "rgba(30,28,24," + alpha + ")";
  let h: string = m[1]!;
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  const n = parseInt(h, 16);
  return (
    "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) +
    "," + alpha + ")"
  );
}

/* ------------------------------ shape painters --------------------------- */

/**
 * Catmull-Rom resample of an authored polyline. The LLM writes 4-10 coarse
 * control points; this turns them into smooth, natural curves. Returns a
 * flat [x0,y0,x1,y1,…] sample list (stepsPerSeg samples per control segment).
 * `closed` wraps the neighbors so closed silhouettes join seamlessly.
 */
export function sampleCatmullRom(
  X: number[],
  Y: number[],
  closed: boolean,
  stepsPerSeg: number,
): number[] {
  const n = X.length;
  if (n < 3) return X.flatMap((x, i) => [x, Y[i]!]);
  const P = (i: number): [number, number] => {
    const j = closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));
    return [X[j]!, Y[j]!];
  };
  const out: number[] = [];
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const [x0, y0] = P(i - 1);
    const [x1, y1] = P(i);
    const [x2, y2] = P(i + 1);
    const [x3, y3] = P(i + 2);
    for (let s = 0; s < stepsPerSeg; s++) {
      const t = s / stepsPerSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push(
        0.5 * (2 * x1 + (-x0 + x2) * t + (2 * x0 - 5 * x1 + 4 * x2 - x3) * t2 + (-x0 + 3 * x1 - 3 * x2 + x3) * t3),
        0.5 * (2 * y1 + (-y0 + y2) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (-y0 + 3 * y1 - 3 * y2 + y3) * t3),
      );
    }
  }
  const [ex, ey] = P(closed ? 0 : n - 1);
  out.push(ex!, ey!);
  return out;
}

/**
 * Organic blob: radius displaced by up to 20% via the author's harmonics.
 * Harmonic magnitudes are scale-agnostic (normalized by the peak), so the
 * LLM can write [0.05,0.1,0.2] or [1,2,3] and get the same organic character.
 */
export function traceBlobPath(
  ctx: CanvasRenderingContext2D,
  s: any,
  rnd: () => number,
  sx: number,
  sy: number,
): void {
  const cx = Number(s.cx ?? 0);
  const cy = Number(s.cy ?? 0);
  const rBase = Math.max(2, Number(s.rBase ?? 40));
  const hArr = Array.isArray(s.harmonics) && s.harmonics.length
    ? s.harmonics.map(Number)
    : [0.05, 0.09, 0.13];
  const peak = Math.max.apply(null, hArr.map(Math.abs)) || 1;
  const scale = 0.28 / peak;
  const phases: number[] = [];
  for (let k = 0; k < hArr.length; k++) phases.push(rnd() * Math.PI * 2);

  const N = 60;
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const th = (i / N) * Math.PI * 2;
    let disp = 0;
    for (let k = 0; k < hArr.length; k++) {
      disp += hArr[k]! * scale * Math.sin((k + 1) * th + phases[k]!);
    }
    const r = rBase * (1 + disp);
    const x = cx + r * Math.cos(th);
    const y = cy + r * Math.sin(th) * 0.94;
    if (i === 0) ctx.moveTo(x * sx, y * sy);
    else ctx.lineTo(x * sx, y * sy);
  }
  ctx.closePath();
}

export function drawBlob(
  ctx: CanvasRenderingContext2D,
  s: any,
  rnd: () => number,
  sx: number,
  sy: number,
): void {
  const cx = sx * (Number(s.cx ?? 0));
  const cy = sy * (Number(s.cy ?? 0));
  traceBlobPath(ctx, s, rnd, sx, sy);
  const alpha = clamp(Number(s.alpha ?? 0.5), 0.02, 1);
  const rBase = Math.max(2, Number(s.rBase ?? 40)) * Math.max(sx, sy);
  // watercolor wash instead of a flat sticker: denser core, feathered rim,
  // plus a darker inner pool so masses read as pigment, not clip-art circles
  const g = ctx.createRadialGradient(cx, cy, rBase * 0.1, cx, cy, rBase * 1.05);
  g.addColorStop(0, hexToRgba(s.fill ?? "#4a463f", alpha));
  g.addColorStop(0.62, hexToRgba(s.fill ?? "#4a463f", alpha * 0.82));
  g.addColorStop(1, hexToRgba(s.fill ?? "#4a463f", alpha * 0.4));
  ctx.fillStyle = g;
  ctx.fill();
  if (alpha > 0.25) {
    traceBlobPath(ctx, s, rnd, sx, sy);
    ctx.globalAlpha = 0.35 * alpha;
    const core = ctx.createRadialGradient(cx - rBase * 0.15, cy - rBase * 0.1, 0, cx, cy, rBase * 0.55);
    core.addColorStop(0, hexToRgba(s.fill ?? "#4a463f", 1));
    core.addColorStop(1, hexToRgba(s.fill ?? "#4a463f", 0));
    ctx.fillStyle = core;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

export function drawGradientFill(
  ctx: CanvasRenderingContext2D,
  s: any,
  W: number,
  H: number,
  sx: number,
  sy: number,
): void {
  const x = sx * (Number(s.x) || 0);
  const y = sy * (Number(s.y) || 0);
  const w = sx * (Number(s.w) || 1200);
  const h = sy * (Number(s.h) || 2000);
  // GLAZE semantics: a non-paper gradient rect is a transparent wash — a
  // missing alpha defaults to 0.3 (never 0.9), and stale cached graphs that
  // authored a near-opaque veil clamp to 0.45. Stacking must never bury the
  // layers beneath; only the full-canvas paper may paint at alpha 1.
  const fullCanvas = x <= 0 && y <= 0 && w >= W && h >= H;
  let alpha = clamp(Number(s.alpha ?? 0.3), 0, 1);
  if (!fullCanvas && alpha > 0.45) alpha = 0.45;
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, hexToRgba(s.colorTop ?? "#f2ead8", alpha));
  g.addColorStop(1, hexToRgba(s.colorBottom ?? "#d9c9a8", alpha));
  ctx.fillStyle = g;
  // paint ONLY the authored rectangle — the full-canvas fillRect this used
  // to do drowned every poster in one flat haze regardless of coordinates
  if (fullCanvas) {
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillRect(x, y, w, h);
  }
}

export function drawStrokePath(
  ctx: CanvasRenderingContext2D,
  s: any,
  rnd: () => number,
  sx: number,
  sy: number,
): void {
  const pts = Array.isArray(s.points) ? s.points : [];
  if (pts.length < 3) return;
  const baseW = Math.max(0.3, Number(s.lineWidth ?? 2) || 2);
  const taper = s.pressureTaper !== false;
  const dash = Array.isArray(s.dashPattern) && s.dashPattern.length
    ? s.dashPattern.map(Number)
    : null;

  const X: number[] = [];
  const Y: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    X.push(Number(pts[i]?.[0] ?? 0) * sx);
    Y.push(Number(pts[i]?.[1] ?? 0) * sy);
  }
  const n = X.length;
  const total0 = Math.hypot(X[n - 1]! - X[0]!, Y[n - 1]! - Y[0]!);
  // authored first point repeated at the end ⇒ a closed silhouette contour;
  // the smooth body fill keeps such shapes from reading as wireframes
  const closed = total0 < Math.max(6, baseW * 2.5);
  const S = sampleCatmullRom(X, Y, closed, 14);
  const m = S.length / 2;
  if (m < 2) return;

  const cum = new Array<number>(m);
  cum[0] = 0;
  let total = 0;
  for (let i = 0; i < m - 1; i++) {
    total += Math.hypot(S[(i + 1) * 2]! - S[i * 2]!, S[(i + 1) * 2 + 1]! - S[i * 2 + 1]!);
    cum[i + 1] = total;
  }
  if (total < 1) return;

  // seeded hand-drawn wobble per sample vertex
  const jitAmp = baseW * (taper ? 0.22 : 0.08);
  const jx = new Array<number>(m);
  const jy = new Array<number>(m);
  for (let i = 0; i < m; i++) {
    jx[i] = (rnd() - 0.5) * 2 * jitAmp;
    jy[i] = (rnd() - 0.5) * 2 * jitAmp;
  }
  const baseAlpha = clamp(Number(s.alpha ?? 0.92), 0.05, 1);

  ctx.save();
  ctx.strokeStyle = String(s.color ?? "#26241f");

  if (closed) {
    ctx.beginPath();
    ctx.moveTo(S[0]!, S[1]!);
    for (let i = 1; i < m; i++) ctx.lineTo(S[i * 2]!, S[i * 2 + 1]!);
    ctx.closePath();
    ctx.globalAlpha = baseAlpha * 0.13;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
  }

  if (dash) {
    ctx.globalAlpha = baseAlpha;
    ctx.lineWidth = baseW;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(S[0]! + jx[0]!, S[1]! + jy[0]!);
    for (let i = 1; i < m; i++) ctx.lineTo(S[i * 2]! + jx[i]!, S[i * 2 + 1]! + jy[i]!);
    ctx.stroke();
    ctx.restore();
    return;
  }

  // one segment-sampled pass with pressure-shaped width plus two offset
  // ghosts — reads as dry ink/charcoal rather than a plotter line
  const pass = (ox: number, oy: number, wMul: number, aMul: number): void => {
    ctx.globalAlpha = baseAlpha * aMul;
    for (let i = 0; i < m - 1; i++) {
      const t = (cum[i]! + cum[i + 1]!) / 2 / total;
      const shape = taper ? 0.45 + 0.55 * Math.sin(Math.PI * t) : 1;
      const wob = taper ? 0.88 + rnd() * 0.24 : 1;
      ctx.lineWidth = Math.max(0.4, baseW * wMul * shape * wob);
      ctx.beginPath();
      ctx.moveTo(S[i * 2]! + jx[i]! + ox, S[i * 2 + 1]! + jy[i]! + oy);
      ctx.lineTo(S[(i + 1) * 2]! + jx[i + 1]! + ox, S[(i + 1) * 2 + 1]! + jy[i + 1]! + oy);
      ctx.stroke();
    }
  };
  pass(0, 0, 0.85, 1);
  if (taper) {
    pass(baseW * 0.32, -baseW * 0.18, 0.42, 0.34);
    pass(-baseW * 0.3, baseW * 0.2, 0.3, 0.26);
  }
  ctx.restore();
}

export function drawVignette(
  ctx: CanvasRenderingContext2D,
  s: any,
  W: number,
  H: number,
): void {
  const intensity = clamp(Number(s.intensity ?? 0.18), 0, 0.5);
  const cx = W * 0.5;
  const cy = H * 0.46;
  const maxR = Math.hypot(W, H) * 0.62;
  const g = ctx.createRadialGradient(cx, cy, maxR * 0.35, cx, cy, maxR);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(20,18,14," + intensity + ")");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

/** Soft-bodied ellipse — the workhorse primitive for round objects. Shares
 * the watercolor radial treatment with drawBlob so bodies blend, not stick. */
export function drawEllipse(
  ctx: CanvasRenderingContext2D,
  s: any,
  rnd: () => number,
  sx: number,
  sy: number,
): void {
  const cx = sx * Number(s.cx ?? 0);
  const cy = sy * Number(s.cy ?? 0);
  const rx = Math.max(1, sx * Number(s.rx ?? 10));
  const ry = Math.max(1, sy * Number(s.ry ?? rx / Math.max(sx / sy, 0.0001)));
  const alpha = clamp(Number(s.alpha ?? 0.5), 0.02, 1);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Number(s.rot) || 0);
  const rMax = Math.max(rx, ry);
  const g = ctx.createRadialGradient(0, 0, rMax * 0.1, 0, 0, rMax * 1.02);
  g.addColorStop(0, hexToRgba(s.fill ?? "#4a463f", alpha));
  g.addColorStop(0.62, hexToRgba(s.fill ?? "#4a463f", alpha * 0.85));
  g.addColorStop(1, hexToRgba(s.fill ?? "#4a463f", alpha * 0.5));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  if (alpha > 0.25) {
    // inner pool of pigment, offset slightly toward the light-ish top-left
    const core = ctx.createRadialGradient(-rx * 0.18, -ry * 0.14, 0, 0, 0, rMax * 0.55);
    core.addColorStop(0, hexToRgba(s.fill ?? "#4a463f", 1));
    core.addColorStop(1, hexToRgba(s.fill ?? "#4a463f", 0));
    ctx.globalAlpha = 0.3 * alpha;
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Rounded-rect plate: book covers, doors, tabletops, panels. */
export function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  s: any,
  W: number,
  H: number,
  sx: number,
  sy: number,
): void {
  const x = sx * (Number(s.x) || 0);
  const y = sy * (Number(s.y) || 0);
  const w = Math.max(1, sx * (Number(s.w) || 100));
  const h = Math.max(1, sy * (Number(s.h) || 100));
  const r = Math.min(clamp(Number(s.r ?? w * 0.06), 0, w / 2), h / 2);
  const alpha = clamp(Number(s.alpha ?? 0.5), 0.02, 1);
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate(Number(s.rot) || 0);
  ctx.beginPath();
  ctx.moveTo(-w / 2 + r, -h / 2);
  ctx.arcTo(w / 2, -h / 2, w / 2, h / 2, r);
  ctx.arcTo(w / 2, h / 2, -w / 2, h / 2, r);
  ctx.arcTo(-w / 2, h / 2, -w / 2, -h / 2, r);
  ctx.arcTo(-w / 2, -h / 2, w / 2, -h / 2, r);
  ctx.closePath();
  ctx.fillStyle = hexToRgba(s.fill ?? "#4a463f", alpha);
  ctx.fill();
  ctx.restore();
}

export function drawGrain(
  ctx: CanvasRenderingContext2D,
  s: any,
  W: number,
  H: number,
  rnd: () => number,
): void {
  // stale cached graphs may carry a 0–1 strength share where a speckle count
  // belongs (0.45 would paint ZERO pixels) — remap onto the count scale
  const rawD = Number(s.density ?? 2600);
  const density = clamp(rawD < 10 ? 800 + rawD * 5200 : rawD, 100, 20000);
  const count = Math.round((density * W * H) / (1200 * 2000));
  const twoTone = s.twoTone !== false;
  for (let i = 0; i < count; i++) {
    const x = (rnd() * W) | 0;
    const y = (rnd() * H) | 0;
    const dark = rnd() < 0.5;
    ctx.fillStyle = twoTone
      ? dark ? "#1c1b18" : "#fbf6ea"
      : dark ? "#26241f" : "#d9c9a8";
    ctx.globalAlpha = 0.05 + rnd() * 0.09;
    const sz = rnd() < 0.18 ? 2 : 1;
    ctx.fillRect(x, y, sz, sz);
  }
  ctx.globalAlpha = 1;
}

/* ------------------------------- main entry ------------------------------ */

export function drawGraphToCtx(
  ctx: CanvasRenderingContext2D,
  graph: CompositionGraph,
  opts?: GraphRenderOptions,
): void {
  const W = Math.round(opts?.width ?? 1200);
  const H = Math.round(opts?.height ?? 2000);
  const dw = opts?.designWidth ?? 1200;
  const dh = opts?.designHeight ?? 2000;
  const sx = W / dw;
  const sy = H / dh;
  const rnd = mulberry32((opts?.seed ?? 1) >>> 0);

  const layers = (graph.layers ?? [])
    .slice()
    .sort((a, b) => Number(a.depth ?? 0) - Number(b.depth ?? 0));

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // hard clip: no layer may paint outside the canvas
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();

  for (const layer of layers) {
    for (const shape of layer.shapes ?? []) {
      switch (shape.type) {
        case "gradient_fill":
          drawGradientFill(ctx, shape, W, H, sx, sy);
          break;
        case "organic_blob":
          drawBlob(ctx, shape, rnd, sx, sy);
          break;
        case "stroke_path":
          drawStrokePath(ctx, shape, rnd, sx, sy);
          break;
        case "ellipse":
          drawEllipse(ctx, shape, rnd, sx, sy);
          break;
        case "round_rect":
          drawRoundRect(ctx, shape, W, H, sx, sy);
          break;
        case "vignette":
          drawVignette(ctx, shape, W, H);
          break;
        case "grain":
          drawGrain(ctx, shape, W, H, rnd);
          break;
        default:
          break;
      }
    }
  }
  ctx.restore();
}

/* ------------------------------ raster entry ----------------------------- */

export async function renderGraph(
  graph: CompositionGraph,
  opts?: GraphRenderOptions,
): Promise<GraphRenderResult> {
  const width = Math.round(opts?.width ?? DESIGN_W);
  const height = Math.round(opts?.height ?? DESIGN_H);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas2D unavailable in this environment");
  drawGraphToCtx(ctx, graph, opts);
  return {
    dataUrl: canvas.toDataURL("image/png"),
    width,
    height,
    renderer: "graph-canvas",
    warnings: [],
  };
}

/* --------------------- standalone script generation ---------------------- */
/* The generated script embeds the graph JSON plus the exact same painter
 * functions (via .toString()), so the copied code is complete and runnable. */

export function graphToScript(
  graph: CompositionGraph,
  opts?: { width?: number; height?: number; seed?: number },
): string {
  const W = Math.round(opts?.width ?? DESIGN_W);
  const H = Math.round(opts?.height ?? DESIGN_H);
  const seed = Math.round(opts?.seed ?? 1);
  const graphJson = JSON.stringify(graph, null, 2);

  const fns: Function[] = [
    mulberry32, clamp, hexToRgba, sampleCatmullRom, traceBlobPath, drawBlob,
    drawGradientFill, drawStrokePath, drawEllipse, drawRoundRect,
    drawVignette, drawGrain, drawGraphToCtx,
  ];
  const body = fns.map((fn) => fn.toString()).join("\n\n");

  const lines = [
    "// artai — LLM-enhanced CompositionGraph → Canvas-2D (standalone)",
    `// ${W}×${H}px · ${graph.layers.length} layers · deterministic seed=${seed}`,
    "// The model authored GRAPH below; the painter functions render it 1:1,",
    "// same engine the studio preview runs.",
    "",
    "(function () {",
    `  var W = ${W}, H = ${H}, SEED = ${seed};`,
    "  var GRAPH = " + graphJson.replace(/\n/g, "\n  "),
    "",
    "  /* ---- deterministic painter functions ---- */",
    body.split("\n").map((l) => "  " + l).join("\n"),
    "",
    "  var c = document.createElement('canvas');",
    "  c.width = W; c.height = H;",
    "  c.style.maxWidth = '100%'; c.style.border = '1px solid #ccc';",
    "  document.body.appendChild(c);",
    "  var ctx = c.getContext('2d');",
    "  drawGraphToCtx(ctx, GRAPH, { width: W, height: H, seed: SEED });",
    "})();",
    "",
  ];
  return lines.join("\n");
}
