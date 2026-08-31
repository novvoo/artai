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
  /** share of the shape's deposit that SURVIVES to the final frame
   * (0 = painted then completely buried, 1 = fully visible). Populated only
   * for detail shapes; washes legitimately get occluded and are exempt. */
  retained?: number;
}

export interface GraphAudit {
  reports: DepositionReport[];
  /** shapes whose deposit fell below INVISIBLE_THRESHOLD */
  invisible: DepositionReport[];
  /** detail shapes whose deposit was later painted over — authored detail
   * that is invisible in the FINAL composition (the occlusion blind spot) */
  buried: DepositionReport[];
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

/** detail shapes whose burial is a defect (washes legitimately get occluded:
 * they are atmosphere, not detail). Small solids + strokes count as detail. */
function isDetailShape(s: Record<string, unknown>): boolean {
  const a = Number(s.alpha ?? 1);
  if (s.type === "stroke_path" && !s.dashPattern) return true;
  if (s.type === "round_rect" || s.type === "ellipse")
    return a >= 0.35 && Number(s.w ?? (2 * Number(s.rx))) < 0.25 * 1200;
  if (s.type === "organic_blob")
    return a >= 0.35 && Number(s.rBase) < 150;
  return false;
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
  // cropped before/post snapshots per detail shape — the burial check needs
  // the shape's own contribution vs the FINAL frame over the same pixels
  const pending: Array<{ report: DepositionReport; shape: Record<string, unknown>;
    before: Uint8ClampedArray; post: Uint8ClampedArray;
    x0: number; y0: number; x1: number; y1: number }> = [];

  const layers = [...(graph.layers ?? [])].sort(
    (a, b) => Number(a.depth ?? 0) - Number(b.depth ?? 0));

  for (const layer of layers) {
    const shapes = layer.shapes ?? [];
    for (let i = 0; i < shapes.length; i++) {
      const s = shapes[i]! as Record<string, unknown>;
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
      const report: DepositionReport = {
        layerId: layer.id ?? "?",
        shapeIndex: i,
        type: s.type as string,
        deposited: n > 0 ? Math.round((sum / n) * 100) / 100 : 0,
        bbox,
      };
      reports.push(report);
      if (isDetailShape(s)) {
        const crop = (src: Uint8ClampedArray): Uint8ClampedArray => {
          const out = new Uint8ClampedArray((y1 - y0) * (x1 - x0) * 4);
          for (let y = y0; y < y1; y++)
            out.set(src.subarray((y * AUDIT_W + x0) * 4, (y * AUDIT_W + x1) * 4),
              ((y - y0) * (x1 - x0)) * 4);
          return out;
        };
        pending.push({ report, shape: s, before: crop(before), post: crop(after),
          x0, y0, x1, y1 });
      }
    }
  }

  // retention: how much of each detail shape's contribution survives to the
  // FINAL frame — mean|final − before| / mean|post − before| over its bbox
  const finalFrame = snap();
  const buried: DepositionReport[] = [];
  for (const p of pending) {
    if (p.report.deposited < 3) continue; // nothing meaningful to bury
    let fSum = 0, n = 0;
    for (let y = p.y0; y < p.y1; y++) {
      for (let x = p.x0; x < p.x1; x++) {
        const k = (y * AUDIT_W + x) * 4;
        fSum += (Math.abs(finalFrame[k]! - p.before[k]!) +
                 Math.abs(finalFrame[k + 1]! - p.before[k + 1]!) +
                 Math.abs(finalFrame[k + 2]! - p.before[k + 2]!)) / 3;
        n++;
      }
    }
    const retainedFinal = n > 0 ? fSum / n : 0;
    const retained = Math.round(
      Math.min(1, retainedFinal / Math.max(0.01, p.report.deposited)) * 100) / 100;
    p.report.retained = retained;
    if (retained < 0.25) buried.push(p.report);
  }

  const invisible = reports.filter((r) => r.deposited < INVISIBLE_THRESHOLD);
  return { reports, invisible, buried };
}

/** complaints phrased for the compose/patch loop — feed into polish() */
export function depositionComplaints(audit: GraphAudit): string[] {
  const invisible = audit.invisible.map((r) =>
    `shape #${r.shapeIndex} (${r.type}) in layer "${r.layerId}" deposited NO visible pixels ` +
    `(mean Δ${r.deposited}) — it is dead weight: give it contrast (alpha ≥ 0.15, ink ≥ 12% from paper), ` +
    `a real geometry (≥2 points, on-canvas), or delete it`);
  const buried = audit.buried.map((r) =>
    `shape #${r.shapeIndex} (${r.type}) in layer "${r.layerId}" is painted and then completely COVERED by later layers (only ${Math.round((r.retained ?? 0) * 100)}% survives) — the detail is invisible in the final composition: raise its depth above the occluder, move it to free space, or delete it`);
  return [...invisible, ...buried];
}
