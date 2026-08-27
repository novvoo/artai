/**
 * raster-canvas.ts — deterministic Canvas2D fallback rasterizer.
 * Interprets the SAME SceneIR the p5.brush path consumes, so Studio always
 * produces an image even where WebGL2 is unavailable; used by automated
 * snapshots as the pixel-diff reference because it is 100% reproducible.
 */
import { paintChip, paintFrame, paintOverlay } from "./overlay.js";
import { mix } from "../core/util/color.js";
import { paintStrokeset2D } from "./motif-art.js";
import { Rng } from "../core/util/rand.js";
import type { RasterResult, SceneIRAny } from "./index.js";

export function rasterizeCanvas(
  ir: SceneIRAny,
  opts: { seed: number; width?: number; detail?: number },
): RasterResult {
  const W = Math.round(opts.width ?? ir.canvas.width);
  const H = Math.round((W * ir.canvas.height) / ir.canvas.width);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas2D unavailable in this environment");

  const rng = new Rng(`${opts.seed}:raster`);
  ctx.lineCap = "round";

  /** ink pass — rerun wholesale for the correction iteration */
  const inkPass = (): void => {
    for (const op of ir.ops) {
      switch (op.op) {
        case "paper":
          paper(ctx, op, ir, rng);
          break;
        case "fill":
          fill(ctx, op, ir, rng);
          break;
        case "hatch":
          hatch(ctx, op, ir, rng);
          break;
        default:
          break; // text/mark/photoFragment/postpress stay in overlay pass
      }
    }
  };

  // PASS 1: blocking + local color (paper/fill/hatch only)
  inkPass();

  // CORRECTION pass — the human "step back and squint": measure the rendered
  // value range; if flat (<52 luminance spread), run ONE deterministic
  // deepening re-ink before any crisp chrome lands.
  if (shouldDeepen(ctx)) {
    ctx.save();
    ctx.globalAlpha = 0.55;
    inkPass();
    ctx.restore();
  }

  // PASS 2: shared crisp chrome (guides re-draw is intentionally sub-visible,
  // chips/motif overlay/text/marks/postpress land exactly once, on top)
  paintOverlay(ctx, ir as unknown as Record<string, unknown>, rng, opts.detail ?? 2);

  return {
    canvas,
    dataUrl: canvas.toDataURL("image/png"),
    renderer: "canvas-fallback",
    warnings: [],
  };
}

/* ------------------------------ ops -------------------------------------- */

type Op = Record<string, unknown>;

function boxOf(op: Op): [number, number, number, number] {
  return (op.box as [number, number, number, number]) ?? [0, 0, 0, 0];
}

function polyOf(ir: SceneIRAny, ref: unknown): Array<{ x: number; y: number }> | null {
  if (typeof ref !== "string") return null;
  const pts = (ir.defs ?? {})[ref];
  return Array.isArray(pts) ? (pts as Array<{ x: number; y: number }>) : null;
}

function pathPoly(
  ctx: CanvasRenderingContext2D,
  pts: Array<{ x: number; y: number }>,
  jitter: number,
  rng: Rng,
): void {
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = p.x + rng.gaussian(0, jitter);
    const y = p.y + rng.gaussian(0, jitter);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
}

function scalePts(pts: Array<{ x: number; y: number }>, ir: SceneIRAny, W: number, H: number) {
  // defs were authored at compile resolution; rescale to target raster size
  const sx = W / ir.canvas.width;
  const sy = H / ir.canvas.height;
  return pts.map((p) => ({ x: p.x * sx, y: p.y * sy }));
}

function paper(ctx: CanvasRenderingContext2D, op: Op, _ir: SceneIRAny, rng: Rng): void {
  ctx.fillStyle = String(op.tone ?? "#f5f0e6");
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  // mottle fields — large soft blotches + small specks
  for (let i = 0; i < 140; i++) {
    const r = 12 + rng.float() * 60;
    ctx.globalAlpha = 0.015 + rng.float() * 0.03;
    ctx.fillStyle = rng.float() < 0.55 ? "#c9bfa6" : "#ffffff";
    ctx.beginPath();
    ctx.arc(rng.float() * ctx.canvas.width, rng.float() * ctx.canvas.height, r, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 90; i++) {
    ctx.globalAlpha = 0.03 + rng.float() * 0.04;
    ctx.strokeStyle = "#8f8672";
    ctx.beginPath();
    const x = rng.float() * ctx.canvas.width;
    const y = rng.float() * ctx.canvas.height;
    ctx.moveTo(x, y);
    ctx.lineTo(x + rng.gaussian(0, 8), y + rng.gaussian(14, 20));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function fill(ctx: CanvasRenderingContext2D, op: Op, ir: SceneIRAny, rng: Rng): void {
  const color = String(op.color ?? "#33312d");
  const bleed = op.bleed as [number, string] | undefined;
  const pts = polyOf(ir, op.poly);
  const [bx, by, bw, bh] = boxOf(op);

  const drawShape = (): void => {
    if (pts) pathPoly(ctx, scalePts(pts, ir, ctx.canvas.width, ctx.canvas.height), 1.1, rng), ctx.fill();
    else ctx.fillRect(bx, by, bw, bh);
  };

  // letterpress bleed: layered soft underprints offset outward
  if (bleed && bleed[0] > 0) {
    const spread = bleed[0] * 10;
    for (let layer = 3; layer >= 1; layer--) {
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = color;
      ctx.translate(rng.gaussian(0, spread / layer), rng.gaussian(0, spread / layer));
      drawShape();
      ctx.restore();
    }
  }

  // vertical tonal shift instead of one flat plate (panel reads as print)
  const [gx0, gy0, gw, gh] = boxOf(op);
  const grad = ctx.createLinearGradient(0, gy0, 0, gy0 + gh);
  grad.addColorStop(0, mix(color, "#ffffff", 0.1));
  grad.addColorStop(1, mix(color, "#000000", 0.08));
  ctx.save();
  ctx.globalAlpha = Number(op.opacity ?? 244) / 255 || 0.96;
  ctx.fillStyle = grad;
  drawShape();
  ctx.restore();

  // inner hairline frame — the panel behaves like a printed specimen card
  if (op.trim) {
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = mix(color, "#000000", 0.45);
    ctx.lineWidth = Math.max(1, Math.min(gw, gh) * 0.006);
    ctx.strokeRect(gx0 + gw * 0.055, gy0 + gh * 0.045, gw * 0.89, gh * 0.91);
    ctx.restore();
  }

  // texture character per treatment mode
  texture(ctx, op, ir, rng);
}

function texture(ctx: CanvasRenderingContext2D, op: Op, ir: SceneIRAny, rng: Rng): void {
  const t = op.texture as { mode?: string } | undefined;
  const mode = String(t?.mode ?? "");
  if (!mode || mode === "letterpress-bleed") return;
  const [bx, by, bw, bh] = boxOf(op);
  ctx.save();
  clipToOpShape(ctx, op, ir, rng);

  if (mode === "halftone-degradation") {
    ctx.globalAlpha = 0.10;
    ctx.fillStyle = "#14130f";
    for (let yy = by; yy < by + bh; yy += 4)
      for (let xx = bx + ((yy / 4) % 2) * 2; xx < bx + bw; xx += 7)
        ctx.fillRect(xx, yy, 1.6, 1.6);
  } else if (mode === "risograph-grain") {
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = "#000000";
    for (let i = 0; i < (bw * bh) / 48; i++)
      ctx.fillRect(bx + rng.float() * bw, by + rng.float() * bh, 1.4, 1.4);
  } else {
    // xerox-softness / scan-noise / mottling: tonal drift bands
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = "#ffffff";
    for (let i = 0; i < 26; i++) {
      const cy2 = by + rng.float() * bh;
      ctx.fillRect(bx - 4, cy2, bw + 8, 2 + rng.float() * 5);
    }
  }
  ctx.restore();
}

function clipToOpShape(
  ctx: CanvasRenderingContext2D,
  op: Op,
  ir: SceneIRAny,
  rng: Rng,
): void {
  const pts = polyOf(ir, op.poly);
  ctx.beginPath();
  if (pts) {
    scalePts(pts, ir, ctx.canvas.width, ctx.canvas.height).forEach((p, i) =>
      i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y),
    );
    ctx.closePath();
  } else {
    const [bx, by, bw, bh] = boxOf(op);
    ctx.rect(bx, by, bw, bh);
  }
  ctx.clip();
}

function hatch(
  ctx: CanvasRenderingContext2D,
  op: Op,
  ir: SceneIRAny,
  rng: Rng,
): void {
  const dist = Number(op.dist ?? 6);
  const angleDeg = Number(op.angle ?? 35);
  const color = String(op.color ?? "#43413c");
  const randOpt = (op.options as { rand?: number } | undefined)?.rand ?? 0;

  const pts = polyOf(ir, op.region);
  const regionBox = (op.box as [number, number, number, number] | undefined) ?? bboxOfPoly(ir, op.region);

  ctx.save();
  // clip region before scanning lines through it
  ctx.beginPath();
  if (pts) {
    scalePts(pts, ir, ctx.canvas.width, ctx.canvas.height).forEach((p, i) =>
      i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y),
    );
    ctx.closePath();
    ctx.clip();
  } else if (regionBox) {
    ctx.rect(...regionBox);
    ctx.clip();
  }

  const rad = (angleDeg * Math.PI) / 180;
  const diag = Math.hypot(ctx.canvas.width, ctx.canvas.height);
  ctx.translate(ctx.canvas.width / 2, ctx.canvas.height / 2);
  ctx.rotate(-rad);
  ctx.lineWidth = 0.9;
  ctx.strokeStyle = color;
  for (let y = -diag / 2; y < diag / 2; y += dist) {
    ctx.globalAlpha = 0.28 + rng.float() * randOpt! * 0.25;
    ctx.beginPath();
    ctx.moveTo(-diag / 2, y + rng.gaussian(0, randOpt! * dist * 0.25));
    ctx.lineTo(diag / 2, y + rng.gaussian(0, randOpt! * dist * 0.25));
    ctx.stroke();
  }
  ctx.restore();
}

function bboxOfPoly(
  ir: SceneIRAny,
  ref: unknown,
): [number, number, number, number] | undefined {
  const pts = polyOf(ir, ref);
  if (!pts || !pts.length) return undefined;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);const minY = Math.min(...ys);
  return [minX, minY, Math.max(...xs) - minX, Math.max(...ys) - minY];
}

/** squint test: measure coarse luminance spread over the whole sheet */
function shouldDeepen(ctx: CanvasRenderingContext2D): boolean {
  try {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const stepX = Math.max(4, Math.floor(W / 64));
    const stepY = Math.max(4, Math.floor(H / 96));
    const data = ctx.getImageData(0, 0, W, H).data;
    const lums: number[] = [];
    for (let y = 0; y < H; y += stepY) {
      for (let x = 0; x < W; x += stepX) {
        const i = (y * W + x) * 4;
        lums.push(0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!);
      }
    }
    lums.sort((a, b) => a - b);
    const p10 = lums[Math.floor(lums.length * 0.1)] ?? 0;
    const p90 = lums[Math.floor(lums.length * 0.9)] ?? 255;
    return p90 - p10 < 52;
  } catch {
    return false;
  }
}
