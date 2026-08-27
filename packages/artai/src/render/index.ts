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

/**
 * Graph-pipeline poster: LLM CompositionGraph → pixels, then the SAME
 * typography/chips/marks overlay the IR paths apply (paintOverlay stamps
 * the 中文标题, captions, microtext and postpress chrome). Without this
 * pass the exported poster silently loses every piece of text.
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

  drawGraphToCtx(ctx, graph, {
    width, height, seed: opts.seed,
    designWidth: ir.canvas.width, designHeight: ir.canvas.height,
  });
  // identical overlay pass the IR rasterizers run — text lands exactly once,
  // on top, with the same deterministic rng stream
  const rng = new Rng(`${opts.seed}:graph-overlay`);
  paintOverlay(ctx, ir as unknown as Record<string, unknown>, rng, opts.detail ?? 2);

  return { dataUrl: canvas.toDataURL("image/png"), width, height, renderer: "graph-canvas", warnings: [] };
}
