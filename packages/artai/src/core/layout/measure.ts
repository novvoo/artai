/**
 * measure.ts — geometric share computation for Plan/gate.
 * Accent model follows the style system's dual contract: main chroma occupies
 * 15–35% of the visual cluster, OR 0.8–2.5% of the canvas — an op passes if
 * either reading holds. Estimates are PRE-RENDER proxies; the pixel gate
 * supersedes them once a render exists.
 */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** share of the cluster's area expected to carry the accent hue, per carrier */
const ACCENT_WITHIN_CLUSTER: Record<string, number> = {
  subject: 0.3,
  cutout: 0.36,
  block: 0.38,
  "photo-region": 0.32,
  "bold-type": 0.22,
  dot: 0.02,
  hairline: 0.006,
};

/** Fraction of canvas area covered by boxes (grid-sampled union approximation). */
export function coveredArea(boxes: readonly Box[], width: number, height: number): number {
  if (boxes.length === 0) return 0;
  const step = Math.max(2, Math.floor(Math.min(width, height) / 200));
  let hit = 0;
  let total = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      total++;
      for (const b of boxes) {
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
          hit++;
          break;
        }
      }
    }
  }
  return total === 0 ? 0 : hit / total;
}

export interface MeasuredPlan {
  negativeSpace: number;
  clusterShare: number;
  /** estimated accent share of the FULL canvas */
  accentShareEstimate: number;
}

export function measure(
  inkBoxes: readonly Box[],
  clusterBoxes: readonly Box[],
  carrier: string,
  width: number,
  height: number,
): MeasuredPlan {
  const total = width * height;
  const inkArea = inkBoxes.reduce((s, b) => s + b.w * b.h, 0);
  const clusterArea = clusterBoxes.reduce((s, b) => s + b.w * b.h, 0);
  const clusterShare = clusterArea / total;
  const within = ACCENT_WITHIN_CLUSTER[carrier] ?? 0.1;
  return {
    negativeSpace: round4(1 - inkArea / total),
    clusterShare: round4(clusterShare),
    accentShareEstimate: round4(Math.min(0.06, within * clusterShare)),
  };
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;
