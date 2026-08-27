/**
 * Pure color math — deterministic, dependency-free, Node-safe.
 * Powers the collage coloring model: panels carry LIGHT tints of the accent,
 * motifs carry the saturated ink, shadows/highlights derive from both.
 */
const PAPER_RGB: [number, number, number] = [245, 240, 230]; // --paper
export const DEFAULT_PAPER_HEX = "#f5f0e6";
const INK_RGB: [number, number, number] = [28, 27, 24]; // near-black

export function hexToRgb(hex: string | undefined | null): [number, number, number] {
  const h = (hex ?? DEFAULT_PAPER_HEX).replace("#", "");
  const v =
    h.length === 3
      ? h.split("").map((c) => parseInt(c + c, 16))
      : [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return [v[0]!, v[1]!, v[2]!];
}

function clamp(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

export function rgbToHex(rgb: [number, number, number]): string {
  return (
    "#" +
    rgb
      .map((c) => clamp(c).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

/** linear blend a→b, t∈[0,1] */
export function mix(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex([
    A[0] + (B[0] - A[0]) * t,
    A[1] + (B[1] - A[1]) * t,
    A[2] + (B[2] - A[2]) * t,
  ]);
}

/** toward paper: high t ⇒ airy pastel wash (panel bases).
 * `base` lets callers match the actual paper tone of the poster. */
export function tint(hex: string, t = 0.62, base = rgbToHex(PAPER_RGB)): string {
  return mix(hex, base, t);
}
/** toward ink: depth for shadow plates */
export function shade(hex: string, t = 0.42): string {
  return mix(hex, rgbToHex(INK_RGB), t);
}

/**
 * Collage role palette for one accent:
 *  wash  — light panel underlayer (never confusable with the accent itself)
 *  body  — the saturated ink that carries identity
 *  deep  — shaded plate for form/volume inside the motif
 */
export function collagePalette(accent: string): {
  wash: string;
  body: string;
  deep: string;
} {
  return {
    wash: tint(accent, 0.74),
    body: accent,
    deep: shade(accent, 0.38),
  };
}

/** relative luminance (WCAG) */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Darken `fg` in steps until it reads on `bg` at the requested WCAG ratio
 * (4.5 = AA body text). Never crosses below ~8% black so whisper modes stay
 * recoverable by callers who intentionally want low contrast.
 */
export function readableOn(
  fg: string | undefined | null,
  bg: string | undefined | null,
  minRatio = 4.5,
): string {
  fg = fg ?? DEFAULT_PAPER_HEX;
  bg = bg ?? DEFAULT_PAPER_HEX;
  let cur = fg;
  for (let t = 0; t <= 0.85; t += 0.15) {
    cur = t === 0 ? fg : mix(fg, "#000000", t);
    if (contrastRatio(cur, bg) >= minRatio) return cur;
  }
  return "#14130f";
}
