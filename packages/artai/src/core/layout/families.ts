/**
 * families.ts — layout families as coordinate functions.
 * Each family maps (canvas, cluster box) → concrete geometry: cluster box,
 * optional second panel, type anchor line, mark anchor points.
 * type-led and diagonal-notes use bespoke anchors per the grammar table.
 */
import type { Box } from "./measure.js";
import type { LayoutFamily, MarkKind, PositionName } from "../types/recipe.js";
import { Rng } from "../util/rand.js";

export interface Placement {
  cluster: Box;
  extraPanels: Box[];
  inkBoxes: Box[];
  typeAnchor: { x: number; y: number; angle: number };
  markAnchors: Array<{ x: number; y: number }>;
  /** irregular-cutout blob vertices in canvas px */
  polyPoints?: Array<{ x: number; y: number }>;
}

const POSITION_ANCHOR: Record<PositionName, [number, number]> = {
  "center-high": [0.5, 0.32],
  "center-low": [0.5, 0.68],
  "left-middle": [0.28, 0.5],
  "right-middle": [0.72, 0.5],
  "lower-left-third": [0.24, 0.74],
  "upper-right-third": [0.76, 0.26],
  "offset-center": [0.42, 0.46],
};

function anchorBox(
  position: PositionName,
  areaFraction: number,
  W: number,
  H: number,
): Box {
  const [ax, ay] = POSITION_ANCHOR[position]!;
  // preserve canvas aspect ratio exactly: w/h = W/H ⇒ area = k²·W·H
  const k = Math.sqrt(Math.max(0.001, areaFraction));
  const w = W * k;
  const h = H * k;
  // professional breathing margins: content never hugs the sheet edge
  const MX = W * 0.07;
  const MY = H * 0.055;
  const x = Math.min(Math.max(ax * W - w / 2, MX), Math.max(MX, W - MX - w));
  const y = Math.min(Math.max(ay * H - h / 2, MY), Math.max(MY, H - MY - h));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** deterministic jitter for torn/organic edges */
function jitterPoly(box: Box, rng: Rng, points = 12): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < points; i++) {
    const t = (i / points) * Math.PI * 2;
    const rx = (box.w / 2) * (1 + rng.gaussian(0, 0.06));
    const ry = (box.h / 2) * (1 + rng.gaussian(0, 0.06));
    out.push({
      x: Math.round(box.x + box.w / 2 + Math.cos(t) * rx),
      y: Math.round(box.y + box.h / 2 + Math.sin(t) * ry),
    });
  }
  return out;
}

const DEFAULT_MARKS_FOR_FAMILY: Partial<Record<LayoutFamily, readonly MarkKind[]>> = {
  "dot-orbit": ["dot-group", "dashed-line"],
  "diagonal-notes": ["tiny-arrow", "annotation-line"],
  "edge-counterweight": ["registration-mark", "dashed-line"],
};

export function place(
  family: LayoutFamily,
  position: PositionName,
  clusterScale: number,
  width: number,
  height: number,
  seed: number,
): Placement {
  const rng = new Rng(`${seed}:layout:${family}`);
  const cluster = anchorBox(position, clusterScale, width, height);
  const placement: Placement = {
    cluster,
    extraPanels: [],
    inkBoxes: [],
    typeAnchor: { x: cluster.x, y: cluster.y + cluster.h + Math.round(height * 0.03), angle: 0 },
    markAnchors: [],
  };
  placement.inkBoxes.push(cluster);

  switch (family) {
    case "dual-panel": {
      const gap = Math.round(width * 0.02);
      const halfW = Math.round((cluster.w - gap) / 2);
      const left = { ...cluster, w: halfW };
      const right: Box = {
        x: cluster.x + halfW + gap,
        y: cluster.y,
        w: halfW,
        h: cluster.h,
      };
      placement.extraPanels = [left, right];
      break;
    }
    case "irregular-cutout":
      placement.polyPoints = jitterPoly(cluster, rng);
      break;
    case "type-led": {
      // typography is the focal element: a wide shallow band, still responsive
      // to the recipe's cluster scale (solver budgets apply to it like others)
      const k = Math.sqrt(Math.max(0.05, clusterScale) / 0.15);
      placement.cluster = {
        x: Math.round(width * 0.14 * (2 - k)),
        y: Math.round(height * (0.42 - 0.02 * k)),
        w: Math.round(width * 0.72 * k),
        h: Math.round(height * 0.09 * k),
      };
      placement.typeAnchor = {
        x: placement.cluster.x,
        y: placement.cluster.y + placement.cluster.h,
        angle: 0,
      };
      placement.inkBoxes = [placement.cluster];
      break;
    }
    case "dot-orbit": {
      for (let k = 0; k < 7; k++) {
        const t = (k / 7) * Math.PI * 2 + rng.range(-0.2, 0.2);
        placement.markAnchors.push({
          x: Math.round(cluster.x + cluster.w / 2 + Math.cos(t) * cluster.w * 0.75),
          y: Math.round(cluster.y + cluster.h / 2 + Math.sin(t) * cluster.h * 0.55),
        });
      }
      break;
    }
    case "diagonal-notes": {
      const p1 = {
        x: Math.round(width * rng.range(0.2, 0.3)),
        y: Math.round(height * rng.range(0.25, 0.35)),
      };
      const p2 = {
        x: Math.round(width * rng.range(0.6, 0.75)),
        y: Math.round(height * rng.range(0.55, 0.7)),
      };
      placement.markAnchors.push(p1, p2);
      break;
    }
    case "edge-counterweight":
      placement.markAnchors.push({
        x: Math.round(width * 0.82),
        y: Math.round(height * 0.92),
      });
      break;
    default:
      break;
  }

  if (!placement.markAnchors.length) {
    // subtle counter-mark keeps composition breathable when marks exist
    if (rng.float() < 0.4 && DEFAULT_MARKS_FOR_FAMILY[family]) {
      placement.markAnchors.push({
        x: Math.round(width * rng.range(0.15, 0.85)),
        y: Math.round(height * 0.9),
      });
    }
  }
  return placement;
}
