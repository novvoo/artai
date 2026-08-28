/**
 * render/index.ts — public rasterizer entry. `renderPoster` is the single
 * fold: SceneIR → pixels.
 *
 * FAILURE POLICY (no silent degradation):
 *   - backend "p5.brush": WebGL2 required; any failure throws.
 *   - backend "canvas":   deterministic software path, always available.
 *   - backend "auto":     tries p5.brush, but a brush failure THROWS — auto
 *                         only means "prefer brush", never "quietly swap".
 */
export { rasterizeCanvas } from "./raster-canvas.js";
export { brushAvailable, rasterizeBrush } from "./raster-p5.js";
import { rasterizeCanvas } from "./raster-canvas.js";
import { brushAvailable, rasterizeBrush } from "./raster-p5.js";
import { drawGraphToCtx } from "../core/scene/graphRender.js";
import { Rng } from "../core/util/rand.js";
import { paintOverlay } from "./overlay.js";
import type { SceneIR } from "../core/scene/compile.js";

export type SceneIRAny = SceneIR;

export interface RasterResult {
  canvas: HTMLCanvasElement | null;
  dataUrl: string | null;
  renderer: "p5.brush" | "canvas-fallback";
  warnings: string[];
}

export interface RenderOptions {
  readonly seed: number;
  readonly host?: HTMLElement;
  /** "auto" prefers p5.brush and HARD-FAILS if the environment can't */
  readonly backend?: "auto" | "p5.brush" | "canvas";
  readonly detail?: number;
}

export class RenderCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderCapabilityError";
  }
}

export async function renderPoster(
  ir: SceneIR,
  opts: RenderOptions,
): Promise<RasterResult> {
  const backend = opts.backend ?? "auto";

  if ((backend === "auto" || backend === "p5.brush")) {
    if (!brushAvailable())
      throw new RenderCapabilityError(
        "WebGL2 unavailable — pick backend 'canvas' explicitly to use the software path",
      );
    const out = await rasterizeBrush(ir, opts);
    return out;
  }

  if (backend === "canvas") return rasterizeCanvas(ir, opts);

  throw new RenderCapabilityError(`unknown backend "${String(backend)}"`);
}

/* ---------------- overlay subject-avoidance ----------------------------- */

interface OverlayBox { x0: number; y0: number; x1: number; y1: number; }

const boxArea = (b: OverlayBox): number =>
  Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const boxOverlap = (a: OverlayBox, b: OverlayBox): number =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
  Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/** union bbox of the subject = shapes of layers that carry solid body
 * primitives (same structural rule as critiqueGraph). Washes/gradients in
 * those layers are excluded — only the subject geometry itself counts. */
function graphSubjectBox(
  graph: { layers?: Array<Record<string, unknown>> },
): OverlayBox | null {
  const layers = graph.layers ?? [];
  const isFinisher = (l: any) =>
    (l.shapes ?? []).some((s: any) => s?.type === "grain" || s?.type === "vignette");
  const hasSolidBody = (l: any) =>
    (l.shapes ?? []).some((s: any) => s?.type === "ellipse" || s?.type === "round_rect" ||
      (s?.type === "stroke_path" && Array.isArray(s.points) && s.points.length >= 4 &&
       Math.hypot(
         s.points[0]![0]! - s.points[s.points.length - 1]![0]!,
         s.points[0]![1]! - s.points[s.points.length - 1]![1]!,
       ) < 40));
  const subjectLayers = layers.filter((l: any) => !isFinisher(l) && hasSolidBody(l));
  if (!subjectLayers.length) return null;

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (a: number, b: number, c: number, d: number): void => {
    x0 = Math.min(x0, a); y0 = Math.min(y0, b);
    x1 = Math.max(x1, c); y1 = Math.max(y1, d);
  };
  for (const l of subjectLayers) {
    for (const s of (l.shapes ?? []) as Array<any>) {
      // body primitives define the subject; small shading blobs attached to
      // the same layer count too; washes/gradients and long lines do not
      if (s?.type === "ellipse")
        add(s.cx - s.rx, s.cy - s.ry, s.cx + s.rx, s.cy + s.ry);
      else if (s?.type === "round_rect")
        add(s.x, s.y, s.x + (s.w ?? 0), s.y + (s.h ?? 0));
      else if (s?.type === "organic_blob" && Number(s.rBase ?? 0) <= 160)
        add(s.cx - s.rBase, s.cy - s.rBase, s.cx + s.rBase, s.cy + s.rBase);
    }
  }
  if (x0 === Infinity) return null;
  return { x0, y0, x1, y1 };
}

/** estimated ink box of a text/microtext op (baseline-left anchor, CJK-aware) */
function overlayTextBox(
  op: Record<string, unknown>, W: number, _H: number,
): OverlayBox | null {
  const at = op.at as [number, number] | undefined;
  if (!at || !Array.isArray(op.at)) return null;
  const size = Number(op.sizePx ?? 24);
  const str = String(op.str ?? "");
  if (op.op === "microtext") {
    const w = Math.min(str.length * size * 0.7, W * 0.6);
    return String(op.align) === "right"
      ? { x0: at[0]! - w, y0: at[1]! - size, x1: at[0]!, y1: at[1]! + 3 }
      : { x0: at[0]!, y0: at[1]! - size, x1: at[0]! + w, y1: at[1]! + 3 };
  }
  // headline modes render at 1.7×
  const fs = String(op.mode) === "headline-object" ? size * 1.7 : size;
  let w = 0;
  for (const ch of str) w += ch.charCodeAt(0) > 0x2e80 ? fs : fs * 0.56;
  return { x0: at[0]!, y0: at[1]! - fs, x1: at[0]! + w, y1: at[1]! + fs * 0.25 };
}

/**
 * Move text/microtext ops that would sit on top of the graph's subject to
 * the quietest corner band (alignment-preserving, minimal displacement).
 * Deterministic; a no-op when nothing overlaps or there is no subject.
 */
export function overlayAvoidSubject(
  graph: { layers?: Array<Record<string, unknown>> },
  ir: Record<string, unknown>,
): Record<string, unknown> {
  const subject = graphSubjectBox(graph);
  if (!subject) return ir;
  const W = Number((ir.canvas as Record<string, unknown>)?.width ?? 1200);
  const H = Number((ir.canvas as Record<string, unknown>)?.height ?? 2000);
  // shrink the subject slightly — grazing an edge is fine, covering is not
  const subj: OverlayBox = {
    x0: subject.x0 + (subject.x1 - subject.x0) * 0.08,
    y0: subject.y0 + (subject.y1 - subject.y0) * 0.08,
    x1: subject.x1 - (subject.x1 - subject.x0) * 0.08,
    y1: subject.y1 - (subject.y1 - subject.y0) * 0.08,
  };

  const ops = (ir.ops ?? []) as Array<Record<string, unknown>>;
  let moved = 0;
  const margin = Math.round(W * 0.05);
  const adjusted = ops.map((op) => {
    if (op.op !== "text" && op.op !== "microtext") return op;
    const box = overlayTextBox(op, W, H);
    if (!box) return op;
    if (boxOverlap(box, subj) <= 0.2 * boxArea(box)) return op;

    const w = box.x1 - box.x0;
    const h = box.y1 - box.y0;
    const xs = op.op === "microtext" && String(op.align) === "right"
      ? [box.x1 - w, W - margin - w]      // keep the right-aligned edge
      : [margin, W - margin - w];
    const ys = [Math.round(H * 0.04), Math.round(H - h - H * 0.04)];
    let best: { x: number; y: number; score: number } | null = null;
    for (const x of xs) {
      if (x < 4 || x + w > W - 4) continue;
      for (const y of ys) {
        if (y < 4 || y + h > H - 4) continue;
        const cand: OverlayBox = { x0: x, y0: y, x1: x + w, y1: y + h };
        const score = boxOverlap(cand, subj) * 1000 +
          (Math.abs(cand.x0 - box.x0) + Math.abs(cand.y0 - box.y0));
        if (!best || score < best.score) best = { x, y, score };
      }
    }
    if (!best) return op;
    moved++;
    const at = op.at as [number, number];
    return { ...op, at: [
      Math.round(at[0]! + (best.x - box.x0)),
      Math.round(at[1]! + (best.y - box.y0)),
    ] };
  });
  return moved ? { ...ir, ops: adjusted } : ir;
}

/**
 * Graph-pipeline painting into a caller-provided 2D context: LLM graph
 * pixels + the SAME typography/chips/marks overlay the IR paths apply
 * (paintOverlay stamps the 中文标题, captions, microtext and postpress
 * chrome), with text ops shifted out of the subject's way. Used for BOTH
 * the final poster export and the live preview so the reveal's last frame
 * and the exported PNG are pixel-identical.
 */
export function paintGraphOntoCanvas(
  ctx: CanvasRenderingContext2D,
  graph: import("../core/scene/graph.js").CompositionGraph,
  ir: SceneIR | null,
  opts: { width: number; height: number; seed: number; detail?: number },
): void {
  drawGraphToCtx(ctx, graph, {
    width: opts.width,
    height: opts.height,
    seed: opts.seed,
    ...(ir ? { designWidth: ir.canvas.width, designHeight: ir.canvas.height } : {}),
  });
  if (ir) {
    // identical overlay pass the IR rasterizers run — text lands exactly
    // once, on top, with the same deterministic rng stream; text ops are
    // nudged out of the subject's bbox so chrome never buries the artwork
    const rng = new Rng(`${opts.seed}:graph-overlay`);
    paintOverlay(ctx, overlayAvoidSubject(graph, ir as unknown as Record<string, unknown>), rng, opts.detail ?? 2);
  }
}

/**
 * Graph-pipeline poster: full render to a fresh canvas + PNG data URL.
 */
export function renderGraphPoster(
  graph: import("../core/scene/graph.js").CompositionGraph,
  ir: SceneIR,
  opts: RenderOptions & { width?: number; height?: number },
): { dataUrl: string; width: number; height: number; renderer: "graph-canvas"; warnings: string[] } {
  const width = Math.round(opts.width ?? ir.canvas.width);
  const height = Math.round(opts.height ?? ir.canvas.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas2D unavailable in this environment");

  paintGraphOntoCanvas(ctx, graph, ir, {
    width, height, seed: opts.seed,
    ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
  });

  return { dataUrl: canvas.toDataURL("image/png"), width, height, renderer: "graph-canvas", warnings: [] };
}
