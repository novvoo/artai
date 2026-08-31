/**
 * verify.ts — the authored⇒deposited invariant, measured on real pixels.
 *
 * Every bug of the class "the model authored a shape and the canvas shows
 * nothing" (2-point strokes dropped by a painter guard, grain density on the
 * wrong scale, near-invisible alpha washes, geometry off-canvas) slipped
 * past the JSON-level art director because the graph is *structurally* fine.
 * The only reliable check is empirical: paint each shape on a small canvas
 * and measure how much it actually changed the pixels inside its bbox.
 *
 * `verifyGraphDeposition` renders the graph shape-by-shape at a reduced
 * size (cheap: ~300×500) and reports per-shape mean |Δchannel| inside the
 * shape's bbox between the frame before and after it painted. Deterministic
 * for a given graph+seed. Browser-only (needs Canvas2D); the pure bbox math
 * is factored out for Node tests.
 */
import type { CompositionGraph, GraphShape } from "../core/scene/graph.js";
import { drawGraphToCtx } from "../core/scene/graphRender.js";

export interface DepositionReport {
  layerId: string;
  shapeIndex: number;
  type: string;
  /** mean |Δ| per color channel inside the shape bbox (0–255 scale) */
  deposited: number;
  /** bbox in design space (1200×2000), null when the shape has no geometry */
  bbox: [number, number, number, number] | null;
}

export interface GraphAudit {
  reports: DepositionReport[];
  /** shapes whose deposit fell below INVISIBLE_THRESHOLD */
  invisible: DepositionReport[];
}

const AUDIT_W = 300;
const AUDIT_H = 500;
/** mean channel delta below this reads as "nothing visible" (0–255) */
export const INVISIBLE_THRESHOLD = 1.0;

/** design-space bbox of a shape, or null when it carries no geometry */
export function shapeBBox(s: GraphShape | Record<string, unknown>):
  [number, number, number, number] | null {
  const n = (v: unknown): number => Number(v);
  switch (s?.type) {
    case "gradient_fill":
    case "round_rect":
      return [n(s.x) || 0, n(s.y) || 0,
        (n(s.x) || 0) + (n(s.w) || 0), (n(s.y) || 0) + (n(s.h) || 0)];
    case "ellipse":
      return [n(s.cx) - n(s.rx), n(s.cy) - n(s.ry),
        n(s.cx) + n(s.rx), n(s.cy) + n(s.ry)];
    case "organic_blob": {
      const r = n(s.rBase) * 1.35; // harmonics displace up to ±~28%
      return [n(s.cx) - r, n(s.cy) - r, n(s.cx) + r, n(s.cy) + r];
    }
    case "stroke_path": {
      const pts = Array.isArray(s.points) ? s.points : [];
      const xs = pts.map((p) => n(p?.[0])).filter(Number.isFinite);
      const ys = pts.map((p) => n(p?.[1])).filter(Number.isFinite);
      if (!xs.length) return null;
      const pad = Math.max(2, (n(s.lineWidth) || 2) * 2);
      return [Math.min(...xs) - pad, Math.min(...ys) - pad,
              Math.max(...xs) + pad, Math.max(...ys) + pad];
    }
    default:
      return null; // grain/vignette are full-canvas by definition
  }
}

export function verifyGraphDeposition(
  graph: CompositionGraph,
  seed = 1,
): GraphAudit {
  const canvas = document.createElement("canvas");
  canvas.width = AUDIT_W;
  canvas.height = AUDIT_H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas2D unavailable for render audit");

  const sx = AUDIT_W / 1200;
  const sy = AUDIT_H / 2000;
  const snap = (): Uint8ClampedArray =>
    ctx.getImageData(0, 0, AUDIT_W, AUDIT_H).data;

  const reports: DepositionReport[] = [];
  const layers = [...(graph.layers ?? [])].sort(
    (a, b) => Number(a.depth ?? 0) - Number(b.depth ?? 0));

  for (const layer of layers) {
    const shapes = layer.shapes ?? [];
    for (let i = 0; i < shapes.length; i++) {
      const s = shapes[i]!;
      const bbox = shapeBBox(s);
      if (!bbox) continue; // grain/vignette: full-canvas, always deposits
      const before = snap();
      drawGraphToCtx(ctx,
        { lightDeg: graph.lightDeg, layers: [{ ...layer, shapes: [s] }],
          paletteLocked: graph.paletteLocked } as CompositionGraph,
        { width: AUDIT_W, height: AUDIT_H, seed });
      const after = snap();

      // bbox in audit space, clamped to the canvas
      const x0 = Math.max(0, Math.floor(bbox[0] * sx));
      const y0 = Math.max(0, Math.floor(bbox[1] * sy));
      const x1 = Math.min(AUDIT_W, Math.ceil(bbox[2] * sx));
      const y1 = Math.min(AUDIT_H, Math.ceil(bbox[3] * sy));
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const k = (y * AUDIT_W + x) * 4;
          sum += (Math.abs(after[k]! - before[k]!) +
                  Math.abs(after[k + 1]! - before[k + 1]!) +
                  Math.abs(after[k + 2]! - before[k + 2]!)) / 3;
          n++;
        }
      }
      reports.push({
        layerId: layer.id ?? "?",
        shapeIndex: i,
        type: s.type,
        deposited: n > 0 ? Math.round((sum / n) * 100) / 100 : 0,
        bbox,
      });
    }
  }

  const invisible = reports.filter((r) => r.deposited < INVISIBLE_THRESHOLD);
  return { reports, invisible };
}

/** complaints phrased for the compose/patch loop — feed into polish() */
export function depositionComplaints(audit: GraphAudit): string[] {
  return audit.invisible.map((r) =>
    `shape #${r.shapeIndex} (${r.type}) in layer "${r.layerId}" deposited NO visible pixels ` +
    `(mean Δ${r.deposited}) — it is dead weight: give it contrast (alpha ≥ 0.15, ink ≥ 12% from paper), ` +
    `a real geometry (≥2 points, on-canvas), or delete it`,
  );
}
