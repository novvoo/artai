/**
 * photoTone.ts — deterministic print-degradation transforms for REAL photo
 * pixels. This is the写实 half of the renderer: p5.brush only speaks natural
 * media (watercolor, hatch, flow fields); photographic realism enters the
 * poster through the photoFragment op as actual pixels, then these per-pixel
 * transforms (the photo_pixel demo's ops, print grammar) make the photo
 * belong to the printed sheet without erasing its realism:
 *
 *   tone-match      always — contrast S-curve + highlight roll into paper
 *   halftone        block-averaged raster cells (demo's pixelate = print dot)
 *   xerox           soft-thresholded, desaturated copy-machine look
 *   misregistration R/B channel offset (demo's channelshift = 套印不准)
 *   grain           shadow-weighted seedable noise (film/risograph)
 *
 * Pure math over an RGBA buffer; the same function serves both rasterizers
 * and runs identically for a given (seed, buffer).
 */
import type { Rng } from "../core/util/rand.js";
import { hexToRgb } from "../core/util/color.js";

export type PhotoDegrade =
  | "halftone"
  | "xerox"
  | "misregistration"
  | "grain"
  | "plain";

/** map a Recipe texture mode onto the photo degradation op */
export function treatmentToDegrade(t: string | undefined | null): PhotoDegrade {
  switch (t) {
    case "halftone-degradation":
    case "letterpress-bleed":
      return "halftone";
    case "xerox-softness":
      return "xerox";
    case "misregistration":
      return "misregistration";
    case "risograph-grain":
    case "film-grain":
    case "scan-noise":
    case "paper-mottling":
      return "grain";
    default:
      return "plain";
  }
}

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/** printed-sheet tone match: gentle S-curve, highlights roll into the paper
 * tone, shadows lift off pure black — the photo reads as INK ON THIS SHEET */
function toneMatch(
  d: Uint8ClampedArray, W: number, H: number, paperHex: string,
): void {
  const [pr, pg, pb] = hexToRgb(paperHex);
  for (let i = 0; i < W * H * 4; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = d[i + c]!;
      // contrast S-curve around mid gray
      let out = (v - 128) * 1.12 + 128;
      // highlight roll toward paper tone
      const t = Math.max(0, Math.min(1, (out / 255 - 0.88) / 0.12));
      out = out + ((c === 0 ? pr : c === 1 ? pg : pb) - out) * (t * t * (3 - 2 * t));
      // shadow lift away from pure black
      if (out < 10) out = 10 + (out - 10) * 0.6;
      d[i + c] = clamp255(out);
    }
  }
}

/** halftone: block-averaged raster cells — the demo's pixelate as print dots */
function halftone(d: Uint8ClampedArray, W: number, H: number): void {
  const cell = Math.max(3, Math.round(Math.min(W, H) / 64));
  for (let by = 0; by < H; by += cell) {
    for (let bx = 0; bx < W; bx += cell) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = by; y < Math.min(by + cell, H); y++) {
        for (let x = bx; x < Math.min(bx + cell, W); x++) {
          const i = (y * W + x) * 4;
          r += d[i]!; g += d[i + 1]!; b += d[i + 2]!; n++;
        }
      }
      r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
      for (let y = by; y < Math.min(by + cell, H); y++) {
        for (let x = bx; x < Math.min(bx + cell, W); x++) {
          const i = (y * W + x) * 4;
          d[i] = r; d[i + 1] = g; d[i + 2] = b;
        }
      }
    }
  }
}

/** xerox: desaturate + soft threshold — copy-machine blacks and blown paper */
function xerox(
  d: Uint8ClampedArray, W: number, H: number, rng: Rng,
): void {
  const jitter = (): number => (rng.float() - 0.5) * 0.08;
  for (let i = 0; i < W * H * 4; i += 4) {
    const lum =
      (0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!) / 255;
    const s = Math.max(0, Math.min(1, (lum - 0.42 + jitter()) * 4));
    const v = Math.round(s * 255);
    d[i] = v; d[i + 1] = v; d[i + 2] = v;
  }
}

/** misregistration: R sampled right, B sampled left — off-register print */
function misregistration(d: Uint8ClampedArray, W: number, H: number): void {
  const shift = Math.max(2, Math.round(W / 160));
  const src = d.slice();
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = (row + x) * 4;
      const rx = Math.min(W - 1, x + shift);
      const bx = Math.max(0, x - shift);
      d[i] = src[(row + rx) * 4]!;      // R from the right sample
      d[i + 2] = src[(row + bx) * 4 + 2]!; // B from the left sample
    }
  }
}

/** film/riso grain: shadow-weighted seeded noise, hue-safe (equal RGB offset) */
function grain(
  d: Uint8ClampedArray, W: number, H: number, rng: Rng,
): void {
  for (let i = 0; i < W * H * 4; i += 4) {
    const lum = (0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!) / 255;
    const toneW = Math.pow(1 - lum, 1.2) * 0.85 + 0.15;
    const n = (rng.float() * 2 - 1) * 14 * toneW;
    d[i] = clamp255(d[i]! + n);
    d[i + 1] = clamp255(d[i + 1]! + n);
    d[i + 2] = clamp255(d[i + 2]! + n);
  }
}

export function degradePhotoPixels(
  d: Uint8ClampedArray,
  W: number,
  H: number,
  mode: PhotoDegrade,
  rng: Rng,
  paperHex = "#F5F0E6",
): void {
  toneMatch(d, W, H, paperHex);
  if (mode === "halftone") halftone(d, W, H);
  else if (mode === "xerox") xerox(d, W, H, rng);
  else if (mode === "misregistration") misregistration(d, W, H);
  else if (mode === "grain") grain(d, W, H, rng);
}
