/**
 * imagePalette.ts — extract the design palette from a REAL image's pixels.
 *
 * The "原始图片" input mode: instead of (theme + 配色 preset), the user
 * supplies an original image and its own pixel statistics drive the poster —
 * the dominant saturated cluster becomes the locked accent, the brightest
 * low-chroma cluster becomes the paper tone. Pure math over an RGBA buffer,
 * fully deterministic (no rng), Node-safe (no DOM — decode belongs to the
 * caller, e.g. a temp canvas in the browser).
 *
 * This is the demo's lesson in miniature: realism comes from real data, so
 * the palette is MEASURED from the image, not invented from a mood roll.
 */
import { rgbToHex } from "../util/color.js";

export interface ImagePaletteStats {
  /** mean relative luminance 0–1 */
  meanLum: number;
  /** p90 − p10 luminance spread 0–1 (0 = flat, 1 = full contrast) */
  contrast: number;
  /** share of samples that are chromatic (sat ≥ 0.22) */
  chromaShare: number;
}

export interface ImagePalette {
  /** dominant saturated ink hex — lock as Recipe.color.hue */
  accent: string;
  /** companion cluster hex (second distinct hue); falls back to accent when
   * the image is effectively monochrome — display/companion use only */
  accent2: string;
  /** brightest low-chroma cluster mean hex — lock as canvas.paperTone */
  paper: string;
  stats: ImagePaletteStats;
}

const HUE_BINS = 24; // 15° per bin
const MIN_SAT = 0.22;
const SAMPLE_TARGET = 100_000;

interface Bin {
  w: number;
  r: number;
  g: number;
  b: number;
}

export function paletteFromPixels(
  px: ArrayLike<number>,
  width: number,
  height: number,
): ImagePalette {
  const n = width * height;
  const step = Math.max(1, Math.ceil(Math.sqrt(n / SAMPLE_TARGET)));
  const bins: Bin[] = Array.from({ length: HUE_BINS }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  let paperR = 0, paperG = 0, paperB = 0, paperN = 0;
  let lumSum = 0, chromaN = 0, sampleN = 0;
  const lums: number[] = [];

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const r = px[i]!;
      const g = px[i + 1]!;
      const b = px[i + 2]!;
      sampleN++;
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      lumSum += lum;
      lums.push(lum);
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const l = (mx + mn) / 510;
      const sat = mx === mn ? 0 : (mx - mn) / (255 * (1 - Math.abs(2 * l - 1)));

      if (sat >= MIN_SAT && l > 0.12 && l < 0.94) {
        // chromatic — vote for its hue bin, weight favors vivid mids
        let h = 0;
        if (mx !== r) h = mx === g ? 2 + (b - r) / (mx - mn) : 4 + (r - g) / (mx - mn);
        else h = (g - b) / (mx - mn);
        const hue = (h * 60 + 360) % 360;
        const bin = bins[Math.min(HUE_BINS - 1, Math.floor(hue / (360 / HUE_BINS)))]!;
        const w = sat * sat * (1 - Math.abs(l - 0.5) * 1.2);
        if (w > 0) {
          bin.w += w; bin.r += r * w; bin.g += g * w; bin.b += b * w;
        }
        chromaN++;
      } else if (l > 0.72 && sat < 0.2) {
        // bright neutral — paper candidate
        paperR += r; paperG += g; paperB += b; paperN++;
      }
    }
  }

  // accent = top bin; accent2 = best distinct bin ≥ 75° away with ≥15% mass
  let top = -1, second = -1, topW = 0;
  for (let k = 0; k < HUE_BINS; k++) {
    const w = bins[k]!.w;
    if (w > topW) { topW = w; top = k; }
  }
  if (top < 0 || topW <= 0) {
    // effectively achromatic image — ink falls back to a near-black plate
    return {
      accent: "#2A2723",
      accent2: "#2A2723",
      paper: paperN > 0 ? rgbToHex([paperR / paperN, paperG / paperN, paperB / paperN]) : "#F5F0E6",
      stats: finishStats(lums, lumSum, chromaN, sampleN),
    };
  }
  let secondW = topW * 0.15;
  for (let k = 0; k < HUE_BINS; k++) {
    if (k === top) continue;
    const dist = Math.min(Math.abs(k - top), HUE_BINS - Math.abs(k - top));
    const w = bins[k]!.w;
    if (dist >= 5 && w > secondW) { secondW = w; second = k; }
  }
  const meanOf = (k: number): string => {
    const bn = bins[k]!;
    return rgbToHex([bn.r / bn.w, bn.g / bn.w, bn.b / bn.w]);
  };
  // paper fallback: not enough bright-neutral pixels → use the lightest
  // sampled quartile mean so dark photos still yield a printable stock tone
  let paper = "#F5F0E6";
  if (paperN >= sampleN * 0.01) {
    paper = rgbToHex([paperR / paperN, paperG / paperN, paperB / paperN]);
  } else {
    lums.sort((a, b) => b - a);
    const cut = lums[Math.max(0, Math.floor(lums.length * 0.25))] ?? 1;
    let r2 = 0, g2 = 0, b2 = 0, c2 = 0;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const i = (y * width + x) * 4;
        const r = px[i]!, g = px[i + 1]!, b = px[i + 2]!;
        if ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 >= cut) {
          r2 += r; g2 += g; b2 += b; c2++;
        }
      }
    }
    if (c2 > 0) paper = rgbToHex([r2 / c2, g2 / c2, b2 / c2]);
  }
  return {
    accent: meanOf(top),
    accent2: second >= 0 ? meanOf(second) : meanOf(top),
    paper,
    stats: finishStats(lums, lumSum, chromaN, sampleN),
  };
}

function finishStats(
  lums: number[], lumSum: number, chromaN: number, sampleN: number,
): ImagePaletteStats {
  lums.sort((a, b) => a - b);
  const p10 = lums[Math.floor(lums.length * 0.1)] ?? 0;
  const p90 = lums[Math.floor(lums.length * 0.9)] ?? 0;
  return {
    meanLum: sampleN > 0 ? round4(lumSum / sampleN) : 0,
    contrast: round4(Math.max(0, p90 - p10)),
    chromaShare: sampleN > 0 ? round4(chromaN / sampleN) : 0,
  };
}

const round4 = (v: number): number => Math.round(v * 10_000) / 10_000;
