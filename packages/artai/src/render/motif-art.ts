/**
 * motif-art.ts — the painting engine for motif vignettes.
 *
 * Design goals (per product feedback: "更复杂更真实"):
 *  - CURVED paths everywhere (bezier/quadratic), not polyline icons;
 *  - three-tone FORM on every volume: base fill + shade plate + highlight
 *    plate, plus clipped interior print-hatching for printed-media feel;
 *  - scene CONTEXT per vignette: contact/cast shadows, ground bands,
 *    ambient speckle, background panes — never an object floating alone;
 *  - TWO-HUE palettes: primary accent + companion hue from the mood pool,
 *    so posters stop reading as mono-color diagrams;
 *  - registry-per-painter: each vignette is an isolated artist function that
 *    can be re-drawn/upgraded across iterations without touching the rest.
 */
import type { Rng } from "../core/util/rand.js";
import { mix } from "../core/util/color.js";

type Ctx2D = CanvasRenderingContext2D;

/* ============================ job context =============================== */
/**
 * One vignette paints inside a JOB: a global light direction shared by every
 * shade/highlight plate (human paintings have ONE sun, not per-object suns),
 * the intended edge vocabulary for its focal form, and whether ink plates may
 * use multiply blending (real media darkens where glazes overlap).
 */
export interface Job {
  readonly lightDeg: number;
  readonly edge: "cut" | "wet" | "dry" | "emboss";
  /** compute-density knob: 1 = draft, 2 = standard, 4 = rich, up to 6 */
  readonly detail: number;
  /** free-form species hint straight from the metaphor words */
  readonly species?: string | undefined;
}
let JOB: Job = { lightDeg: 145, edge: "wet", detail: 2 };

export function beginJob(j: Partial<Job>): void {
  JOB = { lightDeg: j.lightDeg ?? 145, edge: j.edge ?? "wet", detail: j.detail ?? 2,
          species: j.species };
}
export function endJob(): void {
  JOB = { lightDeg: 145, edge: "wet", detail: 2 };
}
/** central density multiplier — every texture engine reads the same knob */
function D(): number {
  return Math.min(6, Math.max(1, JOB.detail));
}

/** shade/highlight offset vectors derived from the shared light */
function shadeVec(k: number): [number, number] {
  const rad = ((JOB.lightDeg + 180) * Math.PI) / 180; // shadow lies opposite the light
  return [Math.cos(rad) * k, -Math.sin(rad) * k];
}

function setInkBlend(ctx: Ctx2D): void {
  // real glazes darken overlaps; fallback silently where unsupported
  (ctx as unknown as { globalCompositeOperation?: string }).globalCompositeOperation =
    "multiply";
}

/* ============================ path mini-DSL ============================= */
/** Commands: ["M",x,y] ["L",x,y] ["Q",qx,qy,x,y] ["C",c1x,c1y,c2x,c2y,x,y] ["Z"] */
export type Cmd =
  | ["M", number, number]
  | ["L", number, number]
  | ["Q", number, number, number, number]
  | ["C", number, number, number, number, number, number]
  | ["Z"];

export function trace(ctx: Ctx2D, cmds: Cmd[], jit = 0, rng?: Rng): void {
  const j = (): number => (rng && jit ? rng.gaussian(0, jit) : 0);
  ctx.beginPath();
  for (const c of cmds) {
    switch (c[0]) {
      case "M":
        ctx.moveTo(c[1]! + j(), c[2]! + j());
        break;
      case "L":
        ctx.lineTo(c[1]! + j(), c[2]! + j());
        break;
      case "Q":
        ctx.quadraticCurveTo(c[1]!, c[2]!, c[3]! + j(), c[4]! + j());
        break;
      case "C":
        ctx.bezierCurveTo(c[1]!, c[2]!, c[3]!, c[4]!, c[5]! + j(), c[6]! + j());
        break;
      case "Z":
        ctx.closePath();
        break;
    }
  }
}

/* ============================ shading kit =============================== */

export interface Pal {
  paper: string;
  wash: string;
  body: string;
  deep: string;
  lift: string;
  hue2: string;
}

/** Flatten a cmd path into a dense polyline (beziers sampled). */
function sampleCmds(cmds: Cmd[], perCurve = 8): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let cur: [number, number] | null = null;
  for (const c of cmds) {
    if (c[0] === "M" || c[0] === "L") {
      cur = [c[1]!, c[2]!];
      out.push([cur[0], cur[1]]);
    } else if (c[0] === "Q") {
      const [, qx, qy, x, y] = c as ["Q", number, number, number, number];
      for (let i = 1; i <= perCurve; i++) {
        const t = i / perCurve;
        const mt = 1 - t;
        out.push([
          mt * mt * cur![0]! + 2 * mt * t * qx + t * x,
          mt * mt * cur![1]! + 2 * mt * t * qy + t * y,
        ]);
      }
      cur = [x, y];
    } else if (c[0] === "C") {
      const [, a, b, c2, d, e, f] = c as ["C", number, number, number, number, number, number];
      for (let i = 1; i <= perCurve; i++) {
        const t = i / perCurve;
        const mt = 1 - t;
        out.push([
          mt ** 3 * cur![0]! + 3 * mt * mt * t * a + 3 * mt * t * t * c2 + t ** 3 * e,
          mt ** 3 * cur![1]! + 3 * mt * mt * t * b + 3 * mt * t * t * d + t ** 3 * f,
        ]);
      }
      cur = [e, f];
    } else if (c[0] === "Z") {
      if (out.length) out.push([out[0]![0]!, out[0]![1]!]);
    }
  }
  return out;
}

function tracePoly(ctx: Ctx2D, pts: Array<[number, number]>): void {
  if (!pts.length) return;
  ctx.beginPath();
  ctx.moveTo(pts[0]![0], pts[0]![1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]![0], pts[i]![1]);
  ctx.closePath();
}

/**
 * p5.brush's core realism trick (watercolor "grow", Tyler-Hobbs style),
 * ported to Canvas2D: a silhouette is rendered as N concentric displaced
 * copies at split opacity — feathered media edges emerge statistically.
 */
function fillCmds(
  ctx: Ctx2D,
  cmds: Cmd[],
  color: string,
  alpha: number,
  opts: { jit?: number; rng?: Rng; shadeOffset?: [number, number]; shadeColor?: string;
         layers?: number; edge?: Job["edge"] } = {},
): void {
  const { jit = 0, rng, shadeOffset } = opts;
  const edge = opts.edge ?? JOB.edge;
  const P = {
    cut: { layers: 3, fuzz: 0.55 },
    wet: { layers: 10, fuzz: 1.15 },
    dry: { layers: 3, fuzz: 0.8 },
    emboss: { layers: 8, fuzz: 0.95 },
  }[edge];
  let layersN = opts.layers ?? Math.round(P.layers * (0.65 + D() * 0.5));
  // visibility floor: authored coords live in a ~100-unit box, so anything
  // under ~1 unit of displacement is invisible at final pixel scale.
  const J = Math.max(jit, 1.35) * P.fuzz;
  layersN = Math.max(2, Math.round(layersN * (edge === "wet" ? 1.15 : 0.7)));

  const pts = sampleCmds(cmds);
  // centroid → outward normal per vertex (grow = silhouette swelling)
  const cxn = pts.reduce((a, [px]) => a + px, 0) / Math.max(1, pts.length);
  const cyn = pts.reduce((a, [py]) => a + py, 0) / Math.max(1, pts.length);

  const layerPolys: Array<Array<[number, number]>> = [];
  for (let k = 0; k < layersN; k++) {
    const t = layersN > 1 ? k / (layersN - 1) : 0; // 0=crisp core … 1=far halo
    layerPolys.push(
      pts.map(([px, py]) => {
        if (!rng) return [px, py] as [number, number];
        let dx = px - cxn;
        let dy = py - cyn;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len; dy /= len;
        // outward push grows toward halo layers + perpendicular wobble noise
        const push = J * t * 1.15 * (0.7 + rng.float() * 0.6);
        return [
          px + dx * push + rng.gaussian(0, J * (0.5 + t)),
          py + dy * push + rng.gaussian(0, J * (0.5 + t)),
        ] as [number, number];
      }),
    );
  }

  // shade plate FIRST, cast opposite the shared global light
  if (shadeOffset) {
    const [sx, sy] = shadeVec(2.2);
    ctx.save();
    setInkBlend(ctx);
    ctx.globalAlpha *= 0.3;
    ctx.fillStyle = opts.shadeColor ?? "#1c1b18";
    ctx.translate(sx, sy);
    tracePoly(ctx, layerPolys[Math.floor(layersN / 2)]!);
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  if (edge !== "cut") setInkBlend(ctx); // wet media darkens where glazes overlap
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = color;
  for (const poly of layerPolys) {
    tracePoly(ctx, poly);
    ctx.fill();
  }
  ctx.restore();

  // emboss adds the mirrored highlight plate opposite the shade
  if (edge === "emboss") {
    const [hx, hy] = shadeVec(-1.6);
    ctx.save();
    ctx.globalAlpha *= 0.34;
    ctx.fillStyle = mix(color, "#ffffff", 0.55);
    ctx.translate(hx, hy);
    tracePoly(ctx, layerPolys[layersN - 2]!);
    ctx.fill();
    ctx.restore();
  }

  // re-assert the cut edge over the fuzzy halo (paper-cut over watercolor)
  ctx.save();
  ctx.globalAlpha *= alpha;
  tracePoly(ctx, layerPolys[layersN - 1]!);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

/** p5.brush stamped-dab stroke: many jittered ink dots along a polyline. */
function stampedStroke(
  ctx: Ctx2D,
  pts: Array<[number, number]>,
  color: string,
  weight: number,
  rng: Rng,
): void {
  const spacing = Math.max(0.9, weight * 1.9 / D());
  ctx.save();
  ctx.fillStyle = color;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1]!;
    const [bx2, by2] = pts[i]!;
    const len = Math.hypot(bx2 - ax, by2 - ay);
    const steps = Math.max(1, Math.ceil(len / spacing));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const taper = weight * (0.55 + 0.75 * Math.sin(t * Math.PI)); // pressure curve
      ctx.globalAlpha = 0.42 + rng.float() * 0.42;
      ctx.beginPath();
      ctx.arc(
        ax + (bx2 - ax) * t + rng.gaussian(0, weight * 0.34),
        ay + (by2 - ay) * t + rng.gaussian(0, weight * 0.34),
        Math.max(0.5, taper * 0.62 + rng.float() * weight * 0.16),
        0, Math.PI * 2,
      );
      ctx.fill();
    }
  }
  ctx.restore();
}

/** clipped interior hatching — gives flat fills their printed-media tooth */
function hatchIn(
  ctx: Ctx2D,
  cmds: Cmd[],
  color: string,
  spacing: number,
  angleDeg: number,
  rng: Rng,
  alpha = 0.16,
): void {
  ctx.save();
  trace(ctx, cmds);
  ctx.clip();
  const rad = (angleDeg * Math.PI) / 180;
  const diag = 160; // unit-box diagonal (authored space)
  ctx.translate(50, 50);
  ctx.rotate(-rad);
  ctx.strokeStyle = color;
  ctx.lineWidth = spacing * 0.34;
  const dense = spacing / D();
  ctx.globalAlpha *= Math.min(0.3, alpha * 2.1);
  for (let y = -diag / 2; y < diag / 2; y += spacing) {
    ctx.beginPath();
    ctx.moveTo(-diag / 2, y + rng.gaussian(0, spacing * 0.14));
    ctx.lineTo(diag / 2, y + rng.gaussian(0, spacing * 0.14));
    ctx.stroke();
  }
  ctx.restore();
}

function vGradient(
  ctx: Ctx2D,
  cmds: Cmd[],
  top: string,
  bottom: string,
  alpha = 1,
): void {
  const g = ctx.createLinearGradient(0, 0, 0, 100);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = g;
  trace(ctx, cmds);
  ctx.fill();
  ctx.restore();
}

/* ============================ scene context ============================== */

function contactShadow(ctx: Ctx2D, cx: number, cy: number, w: number, pal: Pal, rng: Rng): void {
  ctx.save();
  ctx.globalAlpha = 0.17 + rng.float() * 0.05;
  ctx.fillStyle = mix(pal.deep, pal.paper, 0.12);
  ctx.beginPath();
  ctx.ellipse(cx, cy, w * 0.56, w * 0.075, rng.gaussian(0, 0.04), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function ambientSpeckle(
  ctx: Ctx2D,
  pal: Pal,
  rng: Rng,
  n = 26,
): void {
  ctx.save();
  for (let i = 0; i < n; i++) {
    ctx.globalAlpha = 0.05 + rng.float() * 0.07;
    ctx.fillStyle = rng.float() < 0.5 ? pal.hue2 : pal.deep;
    ctx.fillRect(rng.float() * 100, rng.float() * 100, 0.9, 0.9);
  }
  ctx.restore();
}

/** soft backdrop pane behind the subject (grounded composition, not floats) */
function backdropPane(
  ctx: Ctx2D,
  pal: Pal,
  rng: Rng,
  style: "band" | "arch" | "corner",
): void {
  const jit = 0.35;
  switch (style) {
    case "band":
      vGradient(ctx,
        [["M", -4, 58 + rng.gaussian(0, 2)], ["L", 104, 54], ["L", 104, 104], ["L", -4, 104], ["Z"]],
        mix(pal.wash, pal.paper, 0.25),
        mix(pal.wash, pal.deep, 0.1),
        0.55);
      break;
    case "arch": {
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = mix(pal.hue2, pal.paper, 0.5);
      trace(ctx, [["M", 8, 100], ["L", 8, 44], ["Q", 50, 4, 92, 44], ["L", 92, 100], ["Z"]], jit, rng);
      ctx.fill();
      ctx.restore();
      break;
    }
    case "corner": {
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = mix(pal.hue2, pal.paper, 0.42);
      trace(ctx, [["M", 62, -2], ["L", 102, -2], ["L", 102, 38], ["Z"]], jit, rng);
      ctx.fill();
      ctx.restore();
      break;
    }
  }
}

/* ============================ painter registry =========================== */

export interface PaintCtx {
  ctx: Ctx2D;
  pal: Pal;
  rng: Rng;
  /** line width in authored (unit) space */
  lw: number;
}
type Painter = (p: PaintCtx) => void;

const lwOf = (ctx: Ctx2D): number => ctx.lineWidth;

const PAINTERS: Record<string, Painter> = {
  /* ---------------------------------------------------------- envelope */
  envelope({ ctx, pal, rng }) {
    backdropPane(ctx, pal, rng, "band");
    contactShadow(ctx, 50, 95, 78, pal, rng);

    // body with vertical tonal shift
    vGradient(ctx,
      [["M", 6, 24], ["L", 94, 22], ["L", 96, 82], ["L", 4, 84], ["Z"]],
      mix(pal.body, pal.paper, 0.34),
      pal.body,
      0.97);
    hatchIn(ctx, [["M", 6, 24], ["L", 94, 22], ["L", 96, 82], ["L", 4, 84], ["Z"]],
      pal.deep, 7, 32, rng, 0.10);

    // back-flap
    fillCmds(ctx, [["M", 6, 24], ["L", 50, 60], ["L", 94, 22], ["L", 50, 52], ["Z"]],
      pal.deep, 0.85, { jit: 0.4, rng });
    // front flap — folded paper catches light
    fillCmds(ctx, [["M", 6, 40], ["L", 50, 72], ["L", 94, 40], ["L", 94, 50], ["L", 50, 80], ["L", 6, 50], ["Z"]],
      mix(pal.body, pal.paper, 0.18), 0.95, { jit: 0.4, rng });
    // wax seal
    fillCmds(ctx, [["M", 44, 66], ["Q", 50, 58, 57, 65], ["Q", 61, 74, 50, 77], ["Q", 39, 74, 44, 66], ["Z"]],
      pal.hue2, 0.95, { jit: 0.25, rng });
    ctx.save();
    ctx.strokeStyle = mix(pal.hue2, "#ffffff", 0.3);
    ctx.lineWidth = lwOf(ctx) * 0.6;
    trace(ctx, [["Q", 47, 68, 50, 71], ["Q", 53, 68, 50, 64]].map((c) => c as unknown as Cmd));
    ctx.stroke();
    ctx.restore();

    // stray stamp corner poking out
    fillCmds(ctx, [["M", 76, 20], ["L", 90, 12], ["L", 92, 22], ["Z"]], pal.lift, 0.9, { jit: 0.3, rng });
    // perforation dots ringing the stamp
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      ctx.save(); ctx.globalAlpha = 0.7; ctx.fillStyle = pal.lift;
      ctx.beginPath(); ctx.arc(82 + Math.cos(a) * 11, 19 + Math.sin(a) * 8, 0.85, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    // faded ruled address lines
    for (let k = 0; k < 3; k++) {
      ctx.save(); ctx.globalAlpha = 0.34 - k * 0.09; ctx.strokeStyle = pal.deep;
      ctx.lineWidth = lwOf(ctx) * 0.5;
      trace(ctx, [["M", 16, 46 + k * 8], ["L", 50 - k * 7, 45 + k * 8]]);
      ctx.stroke(); ctx.restore();
    }
  },

  /* ------------------------------------------------------ rain-on-glass */
  rain_on_glass({ ctx, pal, rng }) {
    // window pane with cool sheen
    vGradient(ctx,
      [["M", 4, 4], ["L", 96, 4], ["L", 96, 96], ["L", 4, 96], ["Z"]],
      mix(pal.hue2, pal.paper, 0.35),
      mix(pal.hue2, pal.deep, 0.25),
      0.85);
    // distant blur blobs seen through the glass
    for (let k = 0; k < 4; k++) {
      ctx.save();
      ctx.globalAlpha = 0.10 + rng.float() * 0.08;
      ctx.fillStyle = pal.lift;
      ctx.beginPath();
      ctx.ellipse(14 + rng.float() * 70, 14 + rng.float() * 70, 8 + rng.float() * 12, 6 + rng.float() * 9, rng.float(), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    const drops: Array<[number, number, number]> = [
      [28, 34, 7], [55, 48, 9], [37, 70, 5.6], [72, 26, 4.6],
      [48, 86, 6.4], [79, 66, 4.2], [22, 56, 3.4],
    ];
    for (const [dx, dy, r] of drops) {
      // refraction body
      fillCmds(ctx,
        [["M", dx, dy - r * 1.4],
         ["C", dx + r * 1.2, dy - r * 1.2, dx + r * 1.15, dy + r * 0.8, dx, dy + r * 1.3],
         ["C", dx - r * 1.15, dy + r * 0.8, dx - r * 1.2, dy - r * 1.2, dx, dy - r * 1.4], ["Z"]],
        pal.body, 0.88, { jit: 0.15, rng, shadeOffset: [r * 0.12, r * 0.2], shadeColor: pal.deep });
      // specular highlight bead
      fillCmds(ctx,
        [["M", dx - r * 0.35, dy - r * 0.75],
         ["Q", dx - r * 0.05, dy - r * 1.05, dx + r * 0.3, dy - r * 0.7],
         ["Q", dx, dy - r * 0.35, dx - r * 0.35, dy - r * 0.75], ["Z"]],
        pal.lift, 0.95);
      // trailing wet streak upward
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = mix(pal.body, pal.paper, 0.4);
      ctx.lineWidth = lwOf(ctx) * 0.7;
      trace(ctx, [["M", dx, dy - r * 1.5], ["Q", dx + rng.gaussian(0, 2), dy - r * 2.6, dx + rng.gaussian(-2, 2), dy - r * 3.6]].map((c) => c as unknown as Cmd));
      ctx.stroke();
      ctx.restore();
    }
    // frame
    // condensed fog hugging the bottom edge
    vGradient(ctx,
      [["M", 4, 70], ["L", 96, 66], ["L", 96, 94], ["L", 4, 94], ["Z"]],
      mix(pal.paper, "#ffffff", 0.25), pal.hue2, 0.35);
    // contact rings where the biggest drops landed
    for (const [dx, dy, r] of [[28, 34, 7], [55, 48, 9], [47, 83, 5]] as Array<[number,number,number]>) {
      ctx.save(); ctx.globalAlpha = 0.4; ctx.strokeStyle = pal.lift;
      ctx.lineWidth = lwOf(ctx) * 0.6;
      ctx.beginPath(); ctx.ellipse(dx, dy + r * 1.5, r * 1.05, r * 0.5, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = pal.deep;
    ctx.lineWidth = lwOf(ctx) * 1.6;
    trace(ctx, [["M", 4, 4], ["L", 96, 4], ["L", 96, 96], ["L", 4, 96], ["Z"]]);
    ctx.stroke();
    ctx.restore();
  },

  /* ----------------------------------------------------------- open-book */
  open_book({ ctx, pal, rng }) {
    contactShadow(ctx, 50, 93, 74, pal, rng);
    backdropPane(ctx, pal, rng, "band");

    // cover underneath
    fillCmds(ctx, [["M", 6, 30], ["L", 50, 40], ["L", 94, 30], ["L", 94, 82], ["L", 50, 90], ["L", 6, 82], ["Z"]],
      pal.deep, 0.9, { jit: 0.3, rng });

    // left page stack (curved)
    const L: Cmd[] = [
      ["M", 50, 36], ["C", 38, 26, 20, 24, 10, 30],
      ["C", 8, 44, 8, 60, 10, 76], ["C", 22, 70, 38, 72, 50, 80], ["Z"],
    ];
    const R: Cmd[] = [
      ["M", 50, 36], ["C", 62, 26, 80, 24, 90, 30],
      ["C", 92, 44, 92, 60, 90, 76], ["C", 78, 70, 62, 72, 50, 80], ["Z"],
    ];
    fillCmds(ctx, L, mix(pal.lift, pal.paper, 0.2), 0.98, { jit: 0.25, rng });
    fillCmds(ctx, R, mix(pal.wash, pal.paper, 0.25), 0.98, { jit: 0.25, rng });
    hatchIn(ctx, R, mix(pal.deep, pal.paper, 0.4), 6, -18, rng, 0.12);

    // page-curl shadows near spine
    fillCmds(ctx, [["M", 50, 40], ["C", 42, 34, 34, 33, 28, 36], ["C", 36, 36, 44, 40, 50, 46], ["Z"]],
      mix(pal.deep, pal.paper, 0.45), 0.5);
    fillCmds(ctx, [["M", 50, 40], ["C", 58, 34, 66, 33, 72, 36], ["C", 64, 36, 56, 40, 50, 46], ["Z"]],
      mix(pal.deep, pal.paper, 0.45), 0.5);

    // text rows on right page
    for (let k = 0; k < 4; k++) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = pal.hue2;
      ctx.lineWidth = lwOf(ctx) * 0.55;
      trace(ctx, [["M", 57, 40 + k * 8], ["C", 66, 36 + k * 8, 76, 36 + k * 8, 84, 38 + k * 8]].map((c) => c as unknown as Cmd));
      ctx.stroke();
      ctx.restore();
    }
    // ribbon bookmark spilling out
    fillCmds(ctx, [["M", 66, 70], ["L", 72, 70], ["L", 73, 92], ["L", 69, 87], ["L", 66, 93], ["Z"]],
      pal.body, 0.95, { jit: 0.2, rng });
    fillCmds(ctx, [["M", 66, 70], ["L", 72, 70], ["L", 73, 92], ["L", 69, 87], ["L", 66, 93], ["Z"]],
      pal.body, 0.95, { jit: 0.2, rng });
    // page-stack edges peeking beneath
    for (let k = 0; k < 2; k++) {
      ctx.save(); ctx.globalAlpha = 0.55; ctx.strokeStyle = pal.hue2;
      ctx.lineWidth = lwOf(ctx) * 0.5;
      trace(ctx, [["M", 12 + k * 3, 74 + k * 3], ["Q", 50, 84 + k * 3, 88, 71 + k * 3]]);
      ctx.stroke(); ctx.restore();
    }
    // spine stitch marks
    for (let k = 0; k < 4; k++)
      strokePolyThin(ctx, pal.deep, 0.7, [[47, 44 + k * 8], [53, 42 + k * 8]]);
  },

  /* --------------------------------------------------------- branch-leaf */
  branch_leaf({ ctx, pal, rng }) {
    backdropPane(ctx, pal, rng, "corner");
    // main stem — expressive S-curve drawn as seeded ink dabs (p5.brush stamping)
    const stemCmds: Cmd[] = [["M", 10, 96], ["C", 34, 68, 40, 52, 58, 34], ["C", 68, 24, 80, 16, 94, 10]];
    stampedStroke(ctx, sampleCmds(stemCmds, 16), pal.deep, lwOf(ctx) * 2.4, rng);

    const leaf = (bx: number, by: number, ang: number, len: number, fillC: string, rot: number): void => {
      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate(ang + rot);
      // blade
      fillCmds(ctx,
        [["M", 0, 0], ["C", len * 0.3, -len * 0.34, len * 0.72, -len * 0.3, len, 0],
         ["C", len * 0.72, len * 0.3, len * 0.3, len * 0.34, 0, 0], ["Z"]],
        fillC, 0.93, { jit: 0.35, rng });
      // midvein
      ctx.save();
      ctx.globalAlpha = 0.65;
      ctx.strokeStyle = pal.deep;
      ctx.lineWidth = lwOf(ctx) * 0.5;
      ctx.beginPath();ctx.moveTo(len * 0.08, 0);ctx.lineTo(len * 0.9, 0);ctx.stroke();
      ctx.restore();
      ctx.restore();
    };
    const flipLeaf = (bx: number, by: number, ang: number, len: number, fillC: string, rot: number): void =>
      leaf(bx, by, ang, len, fillC, rot);

    const spots: Array<[number, number, number]> = [
      [30, 70, -0.9], [42, 58, -0.55], [54, 44, -0.25],
      [49, 52, Math.PI + 0.5], [63, 38, Math.PI + 0.35], [74, 27, Math.PI + 0.15],
    ];
    spots.forEach(([x, y, a], i) => {
      const upside = i < 3;
      leaf(x, y, a + (upside ? 0 : Math.PI), 20 - i * 1.2, i % 2 ? mix(pal.body, pal.paper, 0.12) : pal.body, rng.gaussian(0, 0.06));
    });

    // fallen leaf apart from the branch
    flipLeaf(24, 20, Math.PI / 2 + rng.gaussian(0, 0.1), 15, mix(pal.body, pal.paper, 0.3), rng.gaussian(0, 0.2));
    // bud tip
    fillCmds(ctx, [["M", 92, 6], ["Q", 98, 8, 95, 13], ["Q", 89, 12, 92, 6], ["Z"]], pal.hue2, 0.95);
  },

  /* -------------------------------------------------------------- bicycle */
  bicycle({ ctx, pal, rng }: PaintCtx): void {
    contactShadow(ctx, 50, 88, 74, pal, rng);
    // rear wheel
    const wheel = (cx: number, r: number): void => {
      ctx.save();
      ctx.lineWidth = lwOf(ctx) * 1.1;
      ctx.strokeStyle = pal.deep;
      ctx.beginPath(); ctx.arc(cx, 62, r, 0, Math.PI * 2); ctx.stroke();
      // tire inner rim
      ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.arc(cx, 62, r - 2.6, 0, Math.PI * 2); ctx.stroke();
      // spokes
      ctx.lineWidth = lwOf(ctx) * 0.45;
      ctx.globalAlpha = 0.65;
      for (let k = 0; k < 8; k++) {
        const t = (k / 8) * Math.PI * 2 + 0.22;
        ctx.beginPath();
        ctx.moveTo(cx, 62);
        ctx.lineTo(cx + Math.cos(t) * (r - 2), 62 + Math.sin(t) * (r - 2));
        ctx.stroke();
      }
      // hub
      ctx.globalAlpha = 1; ctx.fillStyle = pal.body;
      ctx.beginPath(); ctx.arc(cx, 62, 1.8, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    };
    wheel(24, 20); wheel(76, 20);

    // frame — double-triangle in the body ink, stamped strokes for weight
    stampedStroke(ctx, [[24,62],[46,36],[73,42]], pal.body, lwOf(ctx)*1.7, rng);
    stampedStroke(ctx, [[46,36],[52,63],[75,41]], mix(pal.body,pal.paper,0.15), lwOf(ctx)*1.5, rng);
    stampedStroke(ctx, [[24,62],[52,63],[75,41]], mix(pal.deep,pal.paper,0.2), lwOf(ctx)*1.2, rng);
    stampedStroke(ctx, [[47,33],[45,26]], mix(pal.body,pal.paper,0.25), lwOf(ctx)*1.1, rng); // seat tube tip

    // saddle + bars
    fillCmds(ctx, [["M",40,25],["Q",46,22,53,24],["L",51,27],["Q",44,26,40,28],["Z"]],
      pal.hue2, 0.95, { jit: 0.18, rng });
    strokePolyThin(ctx, pal.deep, 1.1, [[78,38],[82,30]]);
    strokePolyThin(ctx, pal.lift, 1.6, [[79,29],[86,29]]);

    // crank + pedal
    ellFillSimple(ctx, pal, 52, 63, 4.2, 4.2, pal.body);
    strokePolyThin(ctx, pal.deep, 0.9, [[52,63],[58,71]]);

    // motion memory: three drifting speed arcs behind
    for (let k = 0; k < 3; k++) {
      ctx.save();
      ctx.globalAlpha = 0.35 - k*0.08;
      strokeArcRight0(ctx, 10 - k*3, 52 + k*8, 9 + k*2);
      ctx.restore();
    }
    ambientSpeckle(ctx, pal, rng, 10);
  },

  /* ------------------------------------------------------------ tide-mark */
  tide_mark({ ctx, pal, rng }) {
    // sea body w/ horizontal tonal bands
    vGradient(ctx,
      [["M", 2, 44], ["L", 98, 40], ["L", 98, 96], ["L", 2, 96], ["Z"]],
      mix(pal.body, pal.paper, 0.42),
      pal.body,
      0.9);
    // foam crests (three swells, bezier)
    for (let k = 0; k < 3; k++) {
      const yy = 46 + k * 19;
      const crest: Cmd[] = [
        ["M", 4, yy],
        ["C", 26, yy - 12 - rng.float() * 4, 44, yy + 8, 62, yy - 6],
        ["C", 76, yy - 15, 88, yy - 4, 96, yy - 8],
      ];
      if (k < 2) {
        stampedStroke(ctx, sampleCmds(crest, 12),
          k === 0 ? pal.lift : mix(pal.body, pal.paper, 0.55),
          lwOf(ctx) * (2.9 - k * 0.5), rng);
      } else {
        ctx.save();
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = pal.lift;
        ctx.lineWidth = lwOf(ctx) * 1.1;
        trace(ctx, crest, 0.4, rng);
        ctx.stroke();
        ctx.restore();
      }
      // spray flecks off the crest
      for (let d = 0; d < 6; d++) {
        ctx.save();
        ctx.globalAlpha = 0.3 + rng.float() * 0.25;
        ctx.fillStyle = pal.lift;
        ctx.fillRect(10 + rng.float() * 84, yy - 16 + rng.float() * 10, 1.2, 1.2);
        ctx.restore();
      }
    }
    // receding foam sheet at shoreline bottom
    // horizon line + distant gulls
    strokePolyThin(ctx, mix(pal.lift, pal.paper, 0.2), 0.8, [[6, 26], [94, 24]]);
    for (const [gx, gy] of [[22, 18], [34, 15]] as Array<[number, number]>) {
      strokePolyThin(ctx, mix(pal.deep, pal.paper, 0.35), 0.7,
        [[gx - 4, gy + 3], [gx, gy], [gx + 4, gy + 3]]);
    }

    fillCmds(ctx, [["M", 2, 88], ["C", 30, 82, 68, 92, 98, 86], ["L", 98, 98], ["L", 2, 98], ["Z"]],
      mix(pal.lift, pal.paper, 0.4), 0.85, { jit: 0.3, rng });
    hatchIn(ctx, [["M", 2, 62], ["L", 98, 58], ["L", 98, 96], ["L", 2, 96], ["Z"]],
      mix(pal.deep, pal.paper, 0.3), 9, 4, rng, 0.1);
  },

  /* ------------------------------------------------------------ door-light */
  door_light({ ctx, pal, rng }) {
    // wall wash
    fillCmds(ctx, [["M", 0, 0], ["L", 100, 0], ["L", 100, 100], ["L", 0, 100], ["Z"]],
      mix(pal.hue2, pal.paper, 0.55), 0.8);
    hatchIn(ctx, [["M", 0, 0], ["L", 100, 0], ["L", 100, 100], ["L", 0, 100], ["Z"]],
      mix(pal.deep, pal.paper, 0.5), 11, 27, rng, 0.09);

    // light shaft spilling through gap onto floor (drawn beneath door slab)
    fillCmds(ctx, [["M", 56, 8], ["L", 64, 8], ["L", 92, 96], ["L", 62, 96], ["Z"]],
      mix(pal.body, pal.paper, 0.4), 0.5, { jit: 0.3, rng });

    // door slab, slightly ajar: split panels for perspective
    fillCmds(ctx, [["M", 18, 4], ["L", 54, 8], ["L", 54, 96], ["L", 18, 96], ["Z"]],
      mix(pal.body, pal.paper, 0.24), 0.97, { jit: 0.3, rng });
    hatchIn(ctx, [["M", 18, 4], ["L", 54, 8], ["L", 54, 96], ["L", 18, 96], ["Z"]],
      pal.deep, 10, -8, rng, 0.10);
    fillCmds(ctx, [["M", 58, 9], ["L", 82, 5], ["L", 82, 96], ["L", 58, 96], ["Z"]],
      mix(pal.body, pal.paper, 0.42), 0.95, { jit: 0.3, rng }); // swung panel

    // knob
    ellK(ctx, 63, 54, 2.6, pal.deep);
    // hinge hints
    for (const hy of [20, 52]) {
      fillCmds(ctx, [["M", 55, hy], ["L", 58, hy + 0.6], ["L", 58, hy + 4], ["L", 55, hy + 3.4], ["Z"]],
        pal.deep, 0.8);
    }
    // hinge hints
    for (const hy of [20, 52]) {
      fillCmds(ctx, [["M", 55, hy], ["L", 58, hy + 0.6], ["L", 58, hy + 4], ["L", 55, hy + 3.4], ["Z"]],
        pal.deep, 0.8);
    }
    // floorboards radiating from the threshold
    for (let k = -2; k <= 2; k++) {
      ctx.save(); ctx.globalAlpha = 0.28;
      ctx.strokeStyle = mix(pal.deep, pal.paper, 0.35);
      ctx.lineWidth = lwOf(ctx) * 0.55;
      trace(ctx, [["M", 36 + k * 8, 86], ["L", 36 + k * 18, 99]]);
      ctx.stroke(); ctx.restore();
    }
    // threshold plank
    fillCmds(ctx, [["M", 14, 94], ["L", 86, 94], ["L", 86, 98], ["L", 14, 98], ["Z"]],
      mix(pal.wash, pal.deep, 0.4), 0.9, { jit: 0.2, rng });
  },

  /* ------------------------------------------------------------ rain pane end */

  // additional painters follow same pattern below when iterated
};

/* ==================== flow-field loop strokes =========================== */

/**
 * Direct port of the p5.brush spiral idiom (official example): four quarter
 * segments per cycle at heading offsets [0,90,180,270]+init, each cycle
 * growing its segment lengths so the shape never closes. The OPTIONAL field
 * bend modulates headings per-step to emulate "seabed"/"curved"/"waves".
 * Returns dense polyline + per-point pressure for both backends.
 */
export function loopStrokePts(
  rng: Rng,
  opts: { cx: number; cy: number; rMax: number; turns: number;
          initAngle?: number; field?: string },
): { pts: Array<[number, number]>; pressure: number[] } {
  const { cx, cy, rMax, turns } = opts;
  const init = opts.initAngle ?? rng.range(0, 360);
  const bends: Record<string, (t: number) => number> = {
    curved: (t) => Math.sin(t * Math.PI * 1.4) * 22,
    seabed: (t) => Math.sin(t * Math.PI * 0.9 + 1.2) * 30,
    waves: (t) => Math.sin(t * Math.PI * 2.2) * 14,
  };
  const bend = bends[opts.field ?? "curved"] ?? ((t: number) => 0);

  const step = 4; // quarter segments per cycle (matches the reference sketch)
  const totalMoves = turns * step;
  const pts: Array<[number, number]> = [];
  const pressure: number[] = [];

  let x = cx;
  let y = cy;
  for (let i = 0; i < totalMoves; i++) {
    const t = i / totalMoves;
    const q = i % step;                        // which of the 4 arcs
    const cyc = Math.floor(i / step);
    const baseAngles = [0, 90, 180, 270];
    const grow = (cyc * 25 + q * 7) / (turns * 32); // normalized growth 0..~1
    const len = rMax * 0.24 * (0.55 + grow * 1.35);

    const heading =
      baseAngles[q]! +
      init +
      bend(t);                                 // flow-field organic bending

    const rad = (heading * Math.PI) / 180;
    x += Math.cos(rad) * len;
    y += Math.sin(rad) * len;

    pts.push([x + rng.gaussian(0, 0.8), y + rng.gaussian(0, 0.8)]);
    pressure.push(0.6 + rng.float() * 1.0);
  }
  return { pts, pressure };
}

/** Canvas-2D renderer for the stroke set (fallback parity path). */
export function paintStrokeset2D(
  ctx: Ctx2D,
  op: Record<string, unknown>,
  rng: Rng,
): void {
  const [bx, by] = (op.box as [number, number]) ?? [0, 0];
  const bw = Number((op.box as [number, number, number, number])[2] ?? 100);
  const bh = Number((op.box as [number, number, number, number])[3] ?? 100);
  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  const rMax = Math.min(bw, bh) / 2.4;
  const palette = (op.palette as string[]) ?? ["#26241f"];
  const count = Number(op.count ?? 3);

  ctx.save();
  ctx.globalAlpha *= 0.5;
  for (let n = 0; n < count; n++) {
    const { pts, pressure } = loopStrokePts(rng, {
      cx: cx + rng.gaussian(0, bw * 0.05),
      cy: cy + rng.gaussian(0, bh * 0.05),
      rMax: rMax * (0.72 + rng.float() * 0.45),
      turns: Number(op.turns ?? 4),
      initAngle: rng.range(0, 360),
      field: String(op.field ?? "curved"),
    });
    const color = palette[n % palette.length]!;
    for (let k = 1; k < pts.length; k++) {
      const t = k / pts.length;
      const taper = 0.45 + Math.sin(t * Math.PI) * 0.75; // pressure curve
      ctx.globalAlpha *= 0.985;
      ctx.strokeStyle = color;
      ctx.lineWidth = lwOf(ctx) * 1.15 * taper * pressure[k]!;
      ctx.beginPath();
      ctx.moveTo(pts[k - 1]![0], pts[k - 1]![1]);
      ctx.lineTo(pts[k]![0], pts[k]![1]);
      ctx.stroke();
      if (k % 3 === 0) {
        // occasional dabs deepen the ink like marker pooling
        ctx.save();
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(pts[k]![0], pts[k]![1], lwOf(ctx) * 1.4 * taper, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }
  ctx.restore();
}

/* ================= customMotif (LLM-authored shapes) ==================== */

const ROLE_ALPHA: Record<string, number> = {
  body: 0.97, deep: 0.9, wash: 0.88, lift: 0.8, line: 0.95,
};

/** Draws an LLM-authored spec scaled into the cluster box. All fills use the
 * real palette hexes derived at compile time; optional clip keeps interior
 * plates inside the union of body silhouettes. */
export function drawCustomMotif(
  ctx: Ctx2D,
  op: Record<string, unknown>,
  rng: Rng,
): void {
  const spec = op.spec as
    | { caption?: string; shapes?: Array<{ d?: string; role?: string; alpha?: number; lw?: number }>;
        clipSilhouette?: boolean; shadow?: boolean }
    | undefined;
  if (!spec?.shapes?.length) return;

  const [bx, by, bw, bh] = (op.box as [number, number, number, number]) ?? [0, 0, 100, 100];
  const palBody = String(op.accent ?? "#d8412f");
  const paperTone = String(op.paper ?? "#f5f0e6");
  const roleColor: Record<string, string> = {
    body: palBody,
    deep: mix(palBody, "#1c1b18", 0.42),
    wash: mix(palBody, paperTone, 0.6),
    lift: mix(paperTone, "#ffffff", 0.25),
    line: mix(palBody, "#1c1b18", 0.55),
  };

  const u = Math.min(bw, bh) / 100;
  ctx.save();
  ctx.translate(bx + (bw - 100 * u) / 2, by + (bh - 100 * u) / 2);
  ctx.scale(u, u);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // ground contact ellipse first (beneath everything)
  if (spec.shadow) {
    ctx.save();
    ctx.globalAlpha *= 0.16;
    ctx.fillStyle = mix(roleColor.deep!, "#000000", 0.2);
    ctx.beginPath();
    ctx.ellipse(50, 93, 30, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  const paths = spec.shapes.map((sh) => ({
    ...sh,
    path: new Path2D(sh.d!),
  }));

  if (spec.clipSilhouette) {
    // union-clip of all body shapes so detail plates can never fragment
    ctx.save();
    for (const sh of paths.filter((p2) => p2.role === "body")) {
      trace(ctx, [["M", 0, 0]]); // no-op to satisfy typing flow
      ctx.clip(sh.path as unknown as Path2D, "nonzero");
      break;
    }
  }

  // paint order: wash → deep → body → lift → line
  const order = ["wash", "deep", "body", "lift", "line"] as const;
  for (const role of order) {
    for (const sh of paths) {
      if (sh.role !== role) continue;
      const color = roleColor[role]!;
      const alpha = (ROLE_ALPHA[role] ?? 0.9) * (sh.alpha ?? 1);
      if (role === "line") {
        ctx.save();
        ctx.globalAlpha *= alpha;
        ctx.strokeStyle = color;
        ctx.lineWidth *= (sh.lw ?? 1.4) / u;
        ctx.stroke(sh.path as unknown as Path2D);
        ctx.restore();
      } else {
        ctx.save();
        ctx.globalAlpha *= alpha;
        ctx.fillStyle = color;
        // grow-feel: one displaced undercopy then the crisp fill
        ctx.save();
        ctx.globalAlpha *= 0.35;
        ctx.translate(rng.gaussian(0, 0.7), rng.gaussian(0, 0.7));
        ctx.fill(sh.path as unknown as Path2D);
        ctx.restore();
        ctx.fill(sh.path as unknown as Path2D);
        ctx.restore();
      }
    }
  }
  if (spec.clipSilhouette) ctx.restore();

  ctx.restore();
}

/* ============================ entry ==================================== */

export function drawMotifArt(p: PaintCtx & { id: string }): void {
  // IR ids are hyphenated ("rain-on-glass"); painters register with
  // underscores. Normalize BOTH ways so a registry typo degrades a single
  // vignette — never silently collapses every poster into the fallback.
  const painter = PAINTERS[p.id] ?? PAINTERS[p.id.replace(/-/g, "_")];
  if (!painter) {
    specimenFrame(p);
    return;
  }
  painter(p);
}

/** test/UX introspection: which ids have dedicated artists right now */
export function paintedMotifIds(): string[] {
  return Object.keys(PAINTERS);
}

/* neutral fallback: specimen cabinet card */
function specimenFrame({ ctx, pal, rng }: PaintCtx): void {
  contactShadow(ctx, 50, 92, 70, pal, rng);
  fillCmds(ctx, [["M", 12, 10], ["L", 88, 10], ["L", 88, 88], ["L", 12, 88], ["Z"]],
    mix(pal.wash, pal.paper, 0.4), 0.9, { jit: 0.3, rng });
  ellFillSimple(ctx, pal, 50, 50, 17, 17, pal.body);
  for (const [a, b, c, d] of [[10, 10, 24, 24], [90, 10, 76, 24], [10, 90, 24, 76], [90, 90, 76, 76]] as const)
    fillCmds(ctx, [["M", a!, b!], ["L", c!, d!]], pal.deep, 0.9);
  ambientSpeckle(ctx, pal, rng, 14);
}

function ellFillSimple(
  ctx: Ctx2D, pal: Pal, x: number, y: number,
  rx: number, ry: number, fill: string, rng?: Rng,
): void {
  fillCmds(ctx,
    [["M", x - rx, y], ["C", x - rx, y - ry * 1.3, x + rx, y - ry * 1.3, x + rx, y],
     ["C", x + rx, y + ry * 1.3, x - rx, y + ry * 1.3, x - rx, y], ["Z"]],
    fill, 0.95, rng ? { jit: 0.2, rng } : { jit: 0.2 });
  ctx.save();
  ctx.globalAlpha = 0.7;
  ctx.strokeStyle = pal.deep;
  ctx.lineWidth = lwOf(ctx) * 0.8;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function ellK(ctx: Ctx2D, x: number, y: number, r: number, color: string): void {
  fillCmds(ctx,
    [["M", x - r, y], ["C", x - r, y - r * 1.2, x + r, y - r * 1.2, x + r, y],
     ["C", x + r, y + r * 1.2, x - r, y + r * 1.2, x - r, y], ["Z"]],
    color, 0.95);
}

void ellK;

/* =================== transitional tier (iteration wave 2) =================== */
Object.assign(PAINTERS, {
  window_ajar({ ctx, pal, rng }: PaintCtx): void {
    backdropPane(ctx, pal, rng, "arch");
    // night interior behind shutters
    vGradient(ctx,
      [["M", 44, 4], ["L", 56, 4], ["L", 56, 96], ["L", 44, 96], ["Z"]],
      mix(pal.hue2, "#0d1024", 0.45),
      pal.deep,
      0.95);
    const shutter = (x0: number, mirror: number): void => {
      fillCmds(ctx,
        [["M", x0, 6], ["L", x0 + 38 * mirror, 10], ["L", x0 + 38 * mirror, 94], ["L", x0, 92], ["Z"]],
        mix(pal.wash, pal.paper, 0.22), 0.97, { jit: 0.3, rng });
      hatchIn(ctx,
        [["M", x0, 6], ["L", x0 + 38 * mirror, 10], ["L", x0 + 38 * mirror, 94], ["L", x0, 92], ["Z"]],
        mix(pal.deep, pal.paper, 0.4), 8, mirror > 0 ? -12 : 12, rng, 0.11);
      for (const ry of [26, 50, 74]) {
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = mix(pal.deep, pal.paper, 0.35);
        ctx.lineWidth = lwOf(ctx) * 0.7;
        trace(ctx, [["M", x0 + 3, ry], ["L", x0 + 35 * mirror, ry + 1]]);
        ctx.stroke();
        ctx.restore();
      }
    };
    shutter(6, 1);
    shutter(57, 1);
    // sill + city hum dots in the gap
    contactShadow(ctx, 50, 98, 70, pal, rng);
    for (let k = 0; k < 5; k++) {
      ctx.save();ctx.globalAlpha = 0.8;ctx.fillStyle = pal.lift;
      ctx.fillRect(46 + rng.float() * 7, 18 + k * 14, 1.4, 1.4);ctx.restore();
    }

    // moon peering through the gap
    ctx.save(); ctx.globalAlpha = 0.9; ctx.fillStyle = pal.lift;
    ctx.beginPath(); ctx.arc(50, 24, 5.2, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.arc(51.5, 22.8, 1.1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // curtain swags flanking the frame
    for (const sx of [4, 72]) {
      fillCmds(ctx,
        [["M", sx, 4], ["Q", sx + 13, 30, sx + 2, 58], ["L", sx + 16, 54],
         ["Q", sx + 18, 20, sx + 16, 4], ["Z"]],
        mix(pal.wash, pal.deep, 0.22), 0.88, { jit: 0.25, rng });
    }
  },

  cup_melt({ ctx, pal, rng }: PaintCtx): void {
    contactShadow(ctx, 48, 93, 60, pal, rng);
    backdropPane(ctx, pal, rng, "band");
    // glass body — translucent, two-tone sides
    fillCmds(ctx,
      [["M", 22, 24], ["C", 20, 46, 24, 66, 30, 76], ["L", 64, 76],
       ["C", 71, 64, 74, 44, 72, 24], ["Z"]],
      mix(pal.wash, pal.paper, 0.3), 0.82, { jit: 0.25, rng });
    // waterline ellipse
    ellFillSimple(ctx, pal, 47, 40, 23, 4.5, mix(pal.body, pal.paper, 0.45));
    // ice cubes stacked
    const cube = (cx: number, cy: number, s2: number, rot: number): void => {
      ctx.save();ctx.translate(cx, cy);ctx.rotate(rot);
      fillCmds(ctx,
        [["M", -s2, -s2], ["L", s2, -s2 * 0.9], ["L", s2 * 0.9, s2], ["L", -s2 * 0.85, s2 * 0.9], ["Z"]],
        mix(pal.lift, pal.body, 0.12), 0.9, { jit: 0.2, rng });
      ctx.save();ctx.globalAlpha = 0.7;ctx.strokeStyle = pal.deep;ctx.lineWidth = lwOf(ctx) * 0.55;
      trace(ctx, [["M", -s2, -s2], ["L", s2, -s2 * 0.9], ["L", s2 * 0.9, s2], ["L", -s2 * 0.85, s2 * 0.9], ["Z"]]);
      ctx.stroke();ctx.restore();
      ctx.restore();
    };
    cube(38, 32, 8, 0.15);
    cube(54, 34, 7, -0.28);
    // melt puddle spilling to the saucer
    fillCmds(ctx,
      [["M", 16, 88], ["C", 34, 80, 62, 82, 80, 86], ["C", 84, 92, 60, 96, 34, 94], ["Z"]],
      mix(pal.body, pal.paper, 0.5), 0.75);
    // handle arc
    strokeArcRight(ctx, pal, 74, 42, 10);
    strokeArcRight(ctx, pal, 74, 42, 10);
    // trapped air bubbles inside the cubes
    for (let k = 0; k < 4; k++) {
      ctx.save(); ctx.globalAlpha = 0.75; ctx.fillStyle = pal.lift;
      ctx.fillRect(39 + k * 4.6, 29 + k * 1.2, 1.1, 1.1); ctx.restore();
    }
    // meniscus creep along the walls
    ctx.save(); ctx.globalAlpha = 0.5; ctx.strokeStyle = pal.deep; ctx.lineWidth = lwOf(ctx) * 0.5;
    trace(ctx, [["M", 24, 42], ["Q", 47, 48, 70, 42]]);
    ctx.stroke(); ctx.restore();
    hatchIn(ctx,
      [["M", 22, 24], ["C", 20, 46, 24, 66, 30, 76], ["L", 64, 76], ["C", 71, 64, 74, 44, 72, 24], ["Z"]],
      mix(pal.hue2, pal.paper, 0.3), 9, 15, rng, 0.08);
  },

  postcard_stamp({ ctx, pal, rng }: PaintCtx): void {
    contactShadow(ctx, 50, 90, 66, pal, rng);
    fillCmds(ctx,
      [["M", 10, 18], ["L", 90, 16], ["L", 92, 78], ["L", 12, 80], ["Z"]],
      mix(pal.lift, pal.paper, 0.35), 0.97, { jit: 0.25, rng });
    // dashed postmark ring
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = mix(pal.hue2, pal.deep, 0.4);
    ctx.lineWidth = lwOf(ctx) * 0.8;
    ctx.beginPath();ctx.arc(32, 46, 17, 0, Math.PI * 2);ctx.stroke();
    ctx.beginPath();ctx.moveTo(20, 30);ctx.lineTo(44, 62);ctx.stroke();
    ctx.restore();
    // perforated stamp corner
    ctx.save();
    ctx.fillStyle = pal.body;
    const sx = 62, sy = 26;
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 3; c++)
        ctx.fillRect(sx + c * 7, sy + r * 7, 5, 5);
    ctx.restore();
    // address rows smudged — privacy of a card never sent
    for (let k = 0; k < 3; k++) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = pal.hue2;
      ctx.lineWidth = lwOf(ctx) * 0.6;
      trace(ctx, [["M", 18, 60 + k * 7], ["L", 40 + k * 6, 59 + k * 7]]);
      ctx.stroke();
      ctx.restore();
    }
    // wavy cancellation strikes over the stamp zone
    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = pal.deep;
    ctx.lineWidth = lwOf(ctx) * 0.7;
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      ctx.moveTo(58 + k * 5, 24 + k * 3);
      ctx.quadraticCurveTo(70 + k * 5, 30 + k * 3, 80 + k * 5, 24 + k * 4);
      ctx.stroke();
    }
    ctx.restore();
    // paper crease diagonal — the card was once folded and mailed anyway
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = pal.deep;
    ctx.lineWidth = lwOf(ctx) * 0.8;
    trace(ctx, [["M", 14, 70], ["L", 88, 28]]);
    ctx.stroke();
    ctx.restore();
  },

  platform_rails({ ctx, pal, rng }: PaintCtx): void {
    backdropPane(ctx, pal, rng, "band");
    // converging ballast bed
    fillCmds(ctx,
      [["M", 40, 6], ["L", 60, 6], ["L", 88, 94], ["L", 12, 94], ["Z"]],
      mix(pal.deep, pal.paper, 0.72), 0.9);
    // rails — bright metal pair converging
    for (const side of [-1, 1]) {
      fillCmds(ctx,
        [["M", 49.4 + side * 1.6, 8], ["L", 50.6 + side * 1.2, 8],
         ["L", 52 + side * 17, 92], ["L", 48 + side * 17, 92], ["Z"]],
        pal.lift, 0.95);
    }
    // sleepers receding with perspective spacing
    for (let k = 0; k < 7; k++) {
      const t = 0.06 + k * 0.15;
      const y = 12 + t * 80;
      const halfW = 5 + t * 30;
      fillCmds(ctx,
        [["M", 50-halfW, y], ["L", 50+halfW, y], ["L", 50+halfW, y+3+t*2.4], ["L", 50-halfW, y+3+t*2.4], ["Z"]],
        mix(pal.body, pal.paper, 0.4 - t * 0.2), 0.85);
    }
    // platform edge sliver + station lamp glint far away
    fillCmds(ctx, [["M", 84, 30], ["L", 99, 26], ["L", 99, 96], ["L", 92, 96], ["Z"]],
      mix(pal.hue2, pal.paper, 0.45), 0.7);
    fillCmds(ctx, [["M", 90, 22], ["L", 94, 21], ["L", 94.6, 27], ["L", 90.4, 27.6], ["Z"]], pal.lift, 0.95);
    fillCmds(ctx, [["M", 90, 22], ["L", 94, 21], ["L", 94.6, 27], ["L", 90.4, 27.6], ["Z"]], pal.lift, 0.95);
    // signal pole reaching up beside the rails
    strokePolyThin(ctx, mix(pal.deep, pal.paper, 0.25), 1.1, [[91, 21], [91, 8]]);
    // catenary wire humming overhead
    strokePolyThin(ctx, mix(pal.deep, pal.paper, 0.35), 0.7, [[58, 4], [76, 10], [95, 6]]);
    ambientSpeckle(ctx, pal, rng, 10);
  },

  moth_cicada({ ctx, pal, rng }: PaintCtx): void {
    /* ------- twig first (behind everything): organic branch + bark ------- */
    const twigY = 88;
    const twigCmds: Cmd[] =
      [["M", 2, twigY + 3], ["Q", 34, twigY - 3.5, 62, twigY - 1], ["Q", 80, twigY + 0.4, 98, twigY - 2]];
    stampedStroke(ctx, sampleCmds(twigCmds, 18), mix(pal.deep, pal.paper, 0.3),
      lwOf(ctx) * 4.2, rng);
    // bark ticks sprinkled along the upper side
    for (let k = 0; k < 13; k++) {
      const t = 0.06 + k * 0.072;
      const tx = 4 + t * 92;
      const ty = twigY - 3 + Math.sin(t * 9) * 1.4;
      strokePolyThin(ctx, mix(pal.deep, "#000000", 0.32), 0.75,
        [[tx, ty], [tx + 2.1 + rng.float(), ty - 1.8]]);
    }
    // offshoot stub reaching skyward
    fillCmds(ctx,
      [["M", 70, twigY - 1.5], ["L", 79, twigY - 17], ["L", 83, twigY - 16], ["L", 77, twigY - 1], ["Z"]],
      mix(pal.wash, pal.deep, 0.45), 0.95, { jit: 0.3, rng });

    /* ------- cast shadow of the shell onto the twig ------- */
    ctx.save();
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = pal.deep;
    ctx.beginPath();
    ctx.ellipse(50, twigY - 0.5, 24, 2.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    /* ------- legs: 6 jointed limbs gripping the twig ------- */
    const leg = (sx: number, sy: number, gx: number, gy: number, mirror: number): void => {
      const knee: [number, number] = [sx + mirror * (gx > sx ? 4.5 : -4.5), sy + (gy - sy) * 0.42];
      const q: Cmd[] = [["M", sx, sy], ["Q", knee[0]!, knee[1]!, gx, gy]];
      stampedStroke(ctx, sampleCmds(q, 10), mix(pal.body, "#000000", 0.18), lwOf(ctx) * 1.25, rng);
      // claw hook at the grip point
      strokePolyThin(ctx, pal.deep, 0.9, [[gx, gy], [gx + mirror * 2.4, gy - 1.6]]);
    };
    leg(44, 40, 24, twigY - 1, -1);
    leg(56, 40, 76, twigY - 1, 1);
    leg(42, 48, 30, twigY - 0.4, -1);
    leg(58, 48, 71, twigY - 0.4, 1);
    leg(46, 54, 41, twigY - 0.6, -1);
    leg(54, 54, 60, twigY - 0.6, 1);

    /* ------- wings ABOVE the legs now, layered translucency + veins ------- */
    const wing = (dir: number): void => {
      fillCmds(ctx,
        [["M", 50, 36],
         ["C", 50 + dir * 26, 20, 50 + dir * 38, 30, 50 + dir * 40, 46],
         ["C", 50 + dir * 39, 56, 50 + dir * 18, 58, 51, 52], ["Z"]],
        mix(pal.body, pal.paper, 0.35), 0.6, { jit: 0.3, rng });
      for (let k = 0; k < 3; k++) {
        strokeArcLeftFan(ctx, pal, dir, 50, 36, 10 + k * 9, 30 + k * 14, 50 + dir * 38, 44 + k * 5);
      }
    };
    wing(1);wing(-1);

    /* ------- segmented abdomen hanging below the wing bases ------- */
    let sy = 48;
    const segHeights = [9.5, 9, 8.4, 7.6];
    for (let k = 0; k < segHeights.length; k++) {
      const h2 = segHeights[k]!;
      const w2 = 12.5 - k * 1.7;
      const cy2 = sy + h2 / 2;
      fillCmds(ctx,
        [["M", 50 - w2, cy2 - h2 / 2], ["Q", 50, cy2 - h2 / 2 - 2.4, 50 + w2, cy2 - h2 / 2],
         ["L", 50 + w2 * 0.94, cy2 + h2 / 2], ["Q", 50, cy2 + h2 / 2 + 2.2, 50 - w2 * 0.94, cy2 + h2 / 2], ["Z"]],
        k % 2 === 0 ? pal.body : mix(pal.body, pal.deep, 0.35),
        0.96, { jit: 0.22, rng });
      // segment groove (chitin seam)
      if (k < segHeights.length - 1) {
        strokePolyThin(ctx, mix(pal.deep, "#000000", 0.4), 0.8,
          [[50 - (w2 - 1), sy + h2], [50 + (w2 - 1), sy + h2]]);
      }
      // joint glint
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = pal.lift;
      ctx.fillRect(50 - w2 + 1.4, sy + 1.6, 1.5, 2.4);
      ctx.restore();
      sy += h2 - 1.2;
    }

    /* ------- pronotum shield + head nub ------- */
    fillCmds(ctx,
      [["M", 40, 26], ["Q", 50, 20, 60, 26], ["Q", 63, 33, 59, 40],
       ["L", 41, 40], ["Q", 37, 33, 40, 26], ["Z"]],
      mix(pal.deep, pal.paper, 0.28), 0.97, { jit: 0.2, rng });
    // shield rim light
    strokePolyThin(ctx, pal.lift, 0.8, [[41, 27.5], [49, 23.6]]);
    strokePolyThin(ctx, pal.lift, 0.8, [[49, 23.6], [58, 27]]);
    fillCmds(ctx, [["M", 45, 22], ["Q", 50, 19.4, 55, 22], ["Q", 50, 16.5, 45, 22], ["Z"]],
      pal.hue2, 0.92);

    ambientSpeckle(ctx, pal, rng, 9);
  },

  stair_gap({ ctx, pal, rng }: PaintCtx): void {
    backdropPane(ctx, pal, rng, "corner");
    let y = 92;
    for (let x = 6; x <= 62; x += 19) {
      // riser shade then tread light
      fillCmds(ctx, [["M", x, y], ["L", x + 18, y], ["L", x + 18, y - 6], ["L", x, y - 6], ["Z"]],
        mix(pal.deep, pal.paper, 0.55), 0.9);
      fillCmds(ctx, [["M", x, y - 6], ["L", x + 18, y - 6], ["L", x + 18, y - 13], ["L", x, y - 13], ["Z"]],
        mix(pal.wash, pal.paper, 0.15), 0.97);
      y -= 13;
    }
    // the gap: dashed ghost of a missing tread floating last position
    ctx.save();
    ctx.setLineDash([5, 4]);
    strokePolyThin(ctx, pal.body, 1.2, [[81, 33],[97, 33],[97, 46],[81, 46],[81, 33]]);
    ctx.restore();
    // railing hint
    strokePolyThin(ctx, mix(pal.deep, pal.paper, 0.2), 1.3, [[2, 40],[30, 26],[58, 22]]);
    strokePolyThin(ctx, mix(pal.deep, pal.paper, 0.2), 1.3, [[2, 40],[30, 26],[58, 22]]);
    // newel post cap at the rail start
    ctx.save(); ctx.fillStyle = pal.body; ctx.globalAlpha = 0.92;
    ctx.beginPath(); ctx.arc(2, 33, 2.6, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    ambientSpeckle(ctx, pal, rng, 12);
  },
});

function strokeArcRight(ctx: Ctx2D, pal: Pal, cx: number, cy: number, r: number): void {
  ctx.save();
  ctx.strokeStyle = mix(pal.deep, pal.paper, 0.2);
  ctx.lineWidth *= 1.15;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2);
  ctx.stroke();
  ctx.restore();
}
function strokeArcLeftFan(
  ctx: Ctx2D, pal: Pal, dir: number,
  ox: number, oy: number, ex: number, ey: number, tx: number, ty: number,
): void {
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = mix(pal.deep, pal.paper, 0.45);
  ctx.lineWidth *= 0.5;
  trace(ctx, [["M", ox, oy], ["Q", ox + dir * ex, ey - 6, tx, ty]].map((c) => c as unknown as Cmd));
  ctx.stroke();
  ctx.restore();
}
function strokePolyThin(ctx: Ctx2D, color: string, lwMul: number, pts: Array<[number, number]>): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth *= lwMul;
  ctx.lineCap = "round";
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.stroke();
  ctx.restore();
}

/* ---------------------------------------------------- creature (animals) */

/**
 * SINGLE-SILHOUETTE anatomy: the whole body is ONE closed bezier path
 * (head→back→haunch→tail→legs), and every internal plate (shading, belly,
 * markings, eyes) is clipped inside it — so the creature can never read as
 * disconnected patches. Species variant: cat-like default, bird fallback.
 */
PAINTERS["creature"] = ({ ctx, pal, rng }: PaintCtx): void => {
  const species = String((JOB as unknown as { species?: string }).species ?? "cat");
  const bird = /bird|鸟|雀/i.test(species);

  contactShadow(ctx, bird ? 50 : 52, bird ? 78 : 88, bird ? 40 : 62, pal, rng);

  /* --- one continuous silhouette -------------------------------------- */
  const body: Cmd[] = bird
    ? [
        ["M", 22, 58],                                    // tail base
        ["C", 34, 46, 44, 38, 58, 36],                    // back to head
        ["C", 64, 35, 70, 37, 72, 42],                    // crown/beak area
        ["L", 80, 45], ["L", 71, 49],                     // beak
        ["C", 68, 57, 60, 60, 54, 61],                    // chest curve down
        ["C", 56, 66, 52, 72, 46, 74],                    // belly
        ["C", 36, 76, 26, 72, 22, 66],
        ["C", 18, 62, 19, 60, 22, 58], ["Z"],
      ]
    : [
        // sitting cat-ish quadruped: ears → head → back → haunch → front legs → tail wrap
        ["M", 38, 30],                                    // left ear tip
        ["L", 43, 22], ["Q", 47, 20, 51, 23],             // between ears
        ["L", 57, 20], ["Q", 59, 26, 58, 31],             // right ear + skull
        ["C", 64, 33, 68, 39, 69, 46],                    // neck/back rise
        ["C", 78, 50, 84, 58, 83, 68],                    // rounded haunch
        ["C", 82, 76, 76, 81, 68, 82],                    // rear reaches ground
        ["L", 62, 82], ["Q", 60, 78, 61, 74],             // hind leg crease
        ["L", 55, 74], ["C", 52, 77, 48, 79, 44, 80],     // belly line to forelegs
        ["L", 42, 82], ["L", 34, 82],                     // front paws on ground
        ["C", 32, 76, 33, 70, 36, 64],                    // chest sweep up
        ["C", 33, 56, 33, 47, 37, 41],                    // face front
        ["Q", 35, 36, 38, 30], ["Z"],
      ];

  // 1) body base wash then saturated ink pass (grow keeps hand-made edge)
  fillCmds(ctx, body, mix(pal.body, pal.paper, 0.12), 0.96,
           { jit: 0.5, rng, shadeOffset: [-2.2, 1.6], shadeColor: mix(pal.deep, "#000000", 0.25) });
  hatchIn(ctx, body, mix(pal.deep, "#000000", 0.15), 7.5, 118, rng, 0.09);

  // 2) interior volume plates — CLIPPED so shading can never fragment outside
  ctx.save();
  trace(ctx, body);
  ctx.clip();

  if (!bird) {
    // rump mass darker toward rear
    fillCmds(ctx,
      [["M", 60, 40], ["C", 76, 46, 86, 60, 84, 74],
       ["C", 82, 80, 72, 82, 64, 80], ["C", 58, 66, 57, 52, 60, 40], ["Z"]],
      mix(pal.body, "#000000", 0.16), 0.85, { jit: 0.4, rng });
    // chest/belly light plate
    fillCmds(ctx,
      [["M", 40, 58], ["C", 44, 62, 52, 63, 58, 60],
       ["C", 56, 70, 48, 76, 42, 74], ["C", 38, 70, 38, 62, 40, 58], ["Z"]],
      mix(pal.lift, pal.paper, 0.3), 0.8);
    // facial wedge slightly lighter
    fillCmds(ctx,
      [["M", 38, 34], ["C", 44, 30, 52, 31, 56, 36],
       ["C", 53, 42, 44, 43, 38, 40], ["Z"]],
      mix(pal.lift, pal.body, 0.28), 0.85);
    // inner ears
    regionInClip(ctx, [[40, 29], [43, 24], [46, 28]], pal.hue2, 0.85);
    regionInClip(ctx, [[52, 27], [55, 22], [57, 27]], pal.hue2, 0.85);
    // closed-eye serenity curves
    strokePolyThin0(ctx, mix(pal.deep, "#000000", 0.3), 0.8,
      [[43, 34], [46, 35]]);
    strokePolyThin0(ctx, mix(pal.deep, "#000000", 0.3), 0.8,
      [[52, 35], [55, 34]]);
    // tiny nose
    ctx.save(); ctx.fillStyle = pal.hue2; ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.arc(48, 38, 1.1, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    // tail — thick tapering S-curve INSIDE silhouette end? tails extend past
    // silhouette rim by design, so draw OUTSIDE clip below instead.
  } else {
    // wing plate over body
    fillCmds(ctx,
      [["M", 40, 52], ["C", 48, 44, 62, 42, 70, 47],
       ["C", 64, 56, 52, 60, 40, 52], ["Z"]],
      mix(pal.deep, pal.paper, 0.12), 0.85, { jit: 0.3, rng });
    // eye
    ellFillSimple(ctx, pal, 66, 42, 1.4, 1.6, "#14130f", rng);
    // legs
    for (const lx of [40, 52]) {
      strokePolyThin0(ctx, pal.lift, 1.4, [[lx, 64], [lx - 2, 78]]);
      strokePolyThin0(ctx, pal.lift, 1.1, [[lx + 4, 64], [lx + 3, 78]]);
    }
  }
  ctx.restore(); // unclip

  // 3) outline re-ink — the signature continuous contour
  ctx.save();
  ctx.strokeStyle = mix(pal.deep, "#000000", 0.12);
  ctx.lineWidth = lwOf(ctx) * 1.15;
  trace(ctx, body, 0.35, rng);
  ctx.stroke();
  ctx.restore();

  if (!bird) {
    // tail curling around the front — outside main body, its own spline
    const tailCmds: Cmd[] = [
      ["M", 82, 70], ["C", 92, 72, 94, 80, 88, 86], ["C", 84, 90, 76, 91, 70, 89],
    ];
    stampedStroke(ctx, sampleCmds(tailCmds, 14), pal.body, lwOf(ctx) * 2.6, rng);
  } else {
    // tail feathers fan
    for (let k = -1; k <= 1; k++) {
      strokePolyThin0(ctx, pal.body, 1.6,
        [[24, 60], [14 + k * 3, 56 + k * 6], [6 + k * 4, 52 + k * 10]]);
    }
  }

  ambientSpeckle(ctx, pal, rng, bird ? 6 : 9);
};

/* helpers used only here (module-scoped, defined below painter registry use) */
function regionInClip(
  ctx: Ctx2D, pts: Array<[number, number]>, color: string, alpha: number,
): void {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
function strokePolyThin0(
  ctx: Ctx2D, color: string, lwMul: number, pts: Array<[number, number]>,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth *= lwMul;
  ctx.lineCap = "round";
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.stroke();
  ctx.restore();
}

function strokeArcRight0(ctx: Ctx2D, x: number, y: number, r: number): void {
  ctx.strokeStyle = "#55524b";
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.arc(x, y, r, Math.PI * 0.85, Math.PI * 1.6);
  ctx.stroke();
}
