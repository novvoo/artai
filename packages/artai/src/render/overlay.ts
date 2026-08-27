/**
 * overlay.ts — crisp editorial chrome (text, marks, photo frames, grain)
 * painted onto ANY 2D context. Executed identically for both rasterizers so
 * the two backends share typography/mark semantics byte-for-byte.
 *
 * Text is deliberately canvas-rendered in v0.9 (system fonts cover CJK;
 * bundled Latin faces don't). Upgrading to opentype.js outlines — unlocking
 * hatchable/ghost-letterforms — stays per architecture §13.
 */
import type { Rng } from "../core/util/rand.js";
import { mix, readableOn } from "../core/util/color.js";
import { beginJob, drawCustomMotif, drawMotifArt, endJob, type Pal } from "./motif-art.js";

type Ctx2D = CanvasRenderingContext2D;
type Pt = [number, number];

export function paintOverlay(
  ctx: Ctx2D,
  ir: Record<string, unknown>,
  rng: Rng,
  detail = 2,
): void {
  // canvas-level clip
  const _cw = Number((ir.canvas as Record<string,unknown>)?.width ?? 1200);
  const _ch = Number((ir.canvas as Record<string,unknown>)?.height ?? 2000);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0,0,_cw,_ch);
  ctx.clip();
  const ops = (ir.ops ?? []) as Array<Record<string, unknown>>;
  for (const op of ops) {
    switch (op.op) {
      case "guides":
        paintGuides(ctx, op);
        break;
      case "panelShadow":
        break; // ink pass owns shadows; nothing in late chrome
      case "backdrop":
        paintBackdrop(ctx, op);
        break;
      case "motif":
        paintMotif(ctx, op, rng);
        break;
      case "customMotif":
        drawCustomMotif(ctx, op, rng);
        break;
      case "chip":
        paintChip(ctx, op, rng);
        break;
      case "frame":
        paintFrame(ctx, op);
        break;
      case "captionRule":
        paintCaptionRule(ctx, op);
        break;
      case "microtext":
        paintMicrotext(ctx, op);
        break;
      case "text":
        paintText(ctx, op);
        break;
      case "mark":
        paintMark(ctx, op, rng);
        break;
      case "postpress":
        paintGrain(ctx, ir.canvas as { width: number; height: number }, rng, op, detail);
        break;
      case "photoFragment":
        if (!op.asset) paintPlaceholder(ctx, op);
        break;
      default:
        break;
    }
  }
}

/* ------------------------------- motif ---------------------------------- */

/**
 * The poster's ONE small imageable event — rendered as COLLAGE FILLS, not
 * bare strokes. Every vignette composes closed regions in four roles derived
 * from the accent + paper tone: wash (light panel), body (saturated ink),
 * deep (shaded plate), lift (paper highlight); outlines read like cut-paper
 * edges. Deterministic; rng only jitters endpoints for print feel.
 */
function paintMotif(ctx: Ctx2D, op: Record<string, unknown>, rng: Rng): void {
  const id = String(op.id ?? "");
  const [bx, by, bw, bh] = (op.box as [number, number, number, number]) ?? [0, 0, 100, 160];
  const accent = String(op.accent ?? op.color ?? "#d8412f");
  const paperTone = String(op.paper ?? "#f5f0e6");

  const pal: Pal = {
    paper: paperTone,
    wash: mix(accent, paperTone, 0.58),
    body: accent,
    deep: mix(accent, "#1c1b18", 0.4),
    lift: mix(paperTone, "#ffffff", 0.25),
    hue2: String(op.accent2 ?? mix(accent, "#2a6f77", 0.6)),
  };

  const s = Math.min(bw, bh) * 0.88;
  const ox = bx + (bw - s) / 2;
  const oy = by + (bh - s) / 2;
  const u = s / 100;

  ctx.save();
  // paper drop-shadow plate lifts the collage off the sheet
  ctx.save();
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = "#1c1b18";
  ctx.fillRect(ox + s * 0.025, oy + s * 0.04, s * 0.97, s * 0.97);
  ctx.restore();

  ctx.translate(ox, oy);
  ctx.scale(u, u);
  ctx.lineWidth = Math.max(1.5, s * 0.014) / u;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  beginJob({
    lightDeg: Number(op.lightDeg ?? 145),
    edge: (op.edge as "cut" | "wet" | "dry" | "emboss") ?? "wet",
    detail: Number(op.detail ?? 2),
    species: typeof op.species === "string" ? op.species : undefined,
  });
  try {
    drawMotifArt({ ctx, pal, rng, id, lw: ctx.lineWidth });
  } finally {
    endJob();
  }

  ctx.restore();
}

/** underdrawing: faint construction axes through the cluster */
function paintGuides(ctx: Ctx2D, op: Record<string, unknown>): void {
  const [ax, ay] = (op.at as [number, number]) ?? [0, 0];
  const [cx, cy, cw, chh] = (op.cluster as [number, number, number, number]) ?? [0, 0, 0, 0];
  ctx.save();
  ctx.globalAlpha = 0.055;
  ctx.strokeStyle = String(op.color ?? "#3a3831");
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ax - cw * 1.6, ay);
  ctx.lineTo(ax + cw * 1.6, ay);
  ctx.moveTo(ax, ay - chh * 0.9);
  ctx.lineTo(ax, ay + chh * 0.9);
  ctx.stroke();
  ctx.strokeRect(cx, cy, cw, chh);
  ctx.restore();
}

/* ------------------------------- chips ---------------------------------- */

/** Exported standalone so raster-canvas dispatches identical pixels. */
export function paintChip(ctx: Ctx2D, op: Record<string, unknown>, rng: Rng): void {
  const variant = String(op.variant ?? "dotgrid");
  const [cx, cy] = (op.at as [number, number]) ?? [0, 0];
  const scale = Number(op.scale ?? 1);
  const rotation = Number(op.rotation ?? 0);
  const color = String(op.color ?? "#55524b");

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.scale(scale, scale);
  ctx.strokeStyle = ctx.fillStyle = color;

  switch (variant) {
    case "dotgrid":
      for (let gx = 0; gx < 3; gx++)
        for (let gy = 0; gy < 3; gy++) {
          ctx.globalAlpha = 0.75;
          ctx.beginPath();
          ctx.arc(gx * 9, gy * 9, 1.8, 0, Math.PI * 2);
          ctx.fill();
        }
      break;
    case "strip": {
      // barcode: seeded irregular bar widths read as archive reference marks
      let x = 0;
      while (x < 64) {
        const w = 1 + Math.floor(rng.float() * 3);
        ctx.fillRect(x, -9, w, 18);
        x += w + 2 + Math.floor(rng.float() * 3);
      }
      ctx.fillRect(0, 12, 64, 1);
      break;
    }
    case "regis":
      ctx.beginPath();
      ctx.arc(0, 0, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-11, 0);ctx.lineTo(11, 0);
      ctx.moveTo(0, -11);ctx.lineTo(0, 11);
      ctx.stroke();
      break;
    case "tickrow":
      for (let k = 0; k < 6; k++) {
        ctx.globalAlpha = 0.55 + k * 0.07;
        ctx.fillRect(k * 7, -3 - k * 2.2, 1.6, 4 + k * 2.2);
      }
      break;
  }
  ctx.restore();
}

/** Depth mass peeking from behind the focal silhouette. Exported for the
 * fallback renderer; the p5.brush path re-implements it with native calls
 * because this layer must sit UNDER ink fills, not in late chrome. */
export function paintBackdrop(ctx: Ctx2D, op: Record<string, unknown>): void {
  const kind = String(op.kind ?? "disc");
  const [bx, by, bw, bh] = (op.box as [number, number, number, number]) ?? [0, 0, 100, 100];
  const rot = ((Number(op.rotation ?? 0)) * Math.PI) / 180;

  ctx.save();
  try {
    (ctx as unknown as { globalCompositeOperation?: string }).globalCompositeOperation =
      "multiply";
  } catch {
    /* soft-light unavailable on legacy stacks */
  }
  ctx.globalAlpha = Number(op.alpha ?? 0.5);
  ctx.fillStyle = String(op.color ?? "#d8cdb4");

  ctx.translate(bx + bw / 2, by + bh / 2);
  ctx.rotate(rot);

  if (kind === "disc") {
    ctx.beginPath();
    ctx.arc(0, 0, bw / 2, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === "slab") {
    const r = Math.min(18, bw * 0.08);
    roundRectPath(ctx, -bw / 2, -bh / 2, bw, bh, r);
    ctx.fill();
  } else {
    // wedge: a generous arc slice rising behind the cluster
    ctx.beginPath();
    ctx.moveTo(0, bh / 2);
    ctx.arc(0, bh / 2, bw / 2, Math.PI * 1.08, Math.PI * 1.92);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function paintFrame(ctx: Ctx2D, op: Record<string, unknown>): void {
  const inset = Number(op.inset ?? 16);
  ctx.save();
  ctx.globalAlpha = Number(op.alpha ?? 0.55);
  ctx.strokeStyle = String(op.color ?? "#8a8375");
  ctx.lineWidth = 1;
  const c = ctx.canvas;
  ctx.strokeRect(inset, inset, c.width - inset * 2, c.height - inset * 2);
  ctx.restore();
}


function paintCaptionRule(ctx: Ctx2D, op: Record<string, unknown>): void {
  const x1 = Number(op.x1 ?? 0);
  const x2 = Number(op.x2 ?? 100);
  const y = Number(op.y ?? 0);
  ctx.save();
  ctx.strokeStyle = String(op.color ?? "#55524b");
  ctx.globalAlpha = 0.65;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
  ctx.restore();
}

/** archival strip: manually letter-spaced tiny caps (canvas letterSpacing is
 * inconsistently supported), right-aligned to the inner margin */
function paintMicrotext(ctx: Ctx2D, op: Record<string, unknown>): void {
  const str = String(op.str ?? "");
  const [ax] = (op.at as [number, number]) ?? [0, 0];
  const y = ((op.at as [number, number]) ?? [0, 0])[1]!;
  const sizePx = Number(op.sizePx ?? 11);
  const spacing = sizePx * 0.22;

  ctx.save();
  ctx.font = `${sizePx}px 'IBM Plex Mono', 'Courier New', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', monospace`;
  ctx.fillStyle = readableOn(String(op.color ?? "#5b574e"), String(op.paper ?? "#f5f0e6"), 3.2);
  ctx.globalAlpha = 0.85;
  let total = 0;
  for (const ch of str) total += ctx.measureText(ch).width + spacing;
  total -= spacing;
  const startX = op.align === "right" ? ax - total : ax;
  let cursor = startX;
  for (const ch of str) {
    ctx.fillText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + spacing;
  }
  ctx.restore();
}

/* ------------------------------- text ---------------------------------- */

function paintText(ctx: Ctx2D, op: Record<string, unknown>): void {
  const str = String(op.str ?? "");
  const [x, y] = (op.at as [number, number]) ?? [0, 0];
  const sizePx = Number(op.sizePx ?? 24);
  const mode = String(op.mode ?? "edge-pressed-phrase");
  const ghost = Number(op.ghost ?? 1);

  const paperHex = String(op.paper ?? "#f5f0e6");
  const requested = String(op.color ?? "#26241f");
  // body-text readability floor (ghost modes intentionally whisper below it)
  const ink = ghost >= 0.5 ? readableOn(requested, paperHex, 4.5) : requested;

  ctx.save();
  ctx.globalAlpha = Math.max(0.14, Math.min(1, ghost));
  ctx.fillStyle = ink;
  ctx.textBaseline = "alphabetic";
  applyTextTransform(ctx, x, y, mode);

  const family =
    mode === "headline-object"
      ? `bold ${Math.round(sizePx * 1.7)}px Georgia, 'Songti SC', 'STSong', 'SimSun', 'Noto Serif CJK SC', serif`
      : `${sizePx}px 'IBM Plex Mono', 'Courier New', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', monospace`;
  ctx.font = family;

  // letterpress double-print: hairline offset echo beneath the main ink
  if (mode === "text-in-block") {
    ctx.fillStyle = "#f2ecdf";
    ctx.fillText(str, 0, 0);
  } else {
    ctx.save();
    ctx.globalAlpha *= 0.35;
    ctx.translate(1.2, 1.4);
    ctx.fillText(str, 0, 0);
    ctx.restore();
    ctx.fillText(str, 0, 0);
  }
  ctx.restore();
}

/** spatial grammar per typography mode (mirrors the zine's own vocabulary) */
function applyTextTransform(
  ctx: Ctx2D,
  x: number,
  y: number,
  mode: string,
): void {
  switch (mode) {
    case "diagonal-scattered":
      ctx.translate(x, y);
      ctx.rotate((-7 * Math.PI) / 180);
      ctx.translate(-x, -y - 20);
      break;
    case "ghost-text":
      break;
    case "floating-letters":
      ctx.letterSpacing = "4px"; // widely supported; harmless if ignored
      break;
    case "archive-microtext":
      ctx.font = "";
      break;
    default:
      break;
  }
  void x;
  void y;
}

/* ------------------------------- marks --------------------------------- */

function paintMark(
  ctx: Ctx2D,
  op: Record<string, unknown>,
  rng: Rng,
): void {
  const kind = String(op.kind ?? "dot-group");
  const [cx, cy] = (op.at as [number, number]) ?? [0, 0];
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = String(op.color ?? "#55524b");
  ctx.lineWidth = 1;

  switch (kind) {
    case "dot-group": {
      for (let gx = 0; gx < 4; gx++)
        for (let gy = 0; gy < 4; gy++) {
          ctx.beginPath();
          ctx.arc(cx + gx * 9 + rng.gaussian(0, 0.7), cy + gy * 9 + rng.gaussian(0, 0.7), 1.4, 0, Math.PI * 2);
          ctx.fill();
        }
      break;
    }
    case "annotation-line":
      ctx.beginPath();
      ctx.moveTo(cx - 46, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + 10, cy - 10);
      ctx.stroke();
      break;
    case "tiny-arrow":
      ctx.beginPath();
      ctx.moveTo(cx - 18, cy);
      ctx.lineTo(cx + 14, cy);
      ctx.moveTo(cx + 14, cy);
      ctx.lineTo(cx + 6, cy - 5);
      ctx.moveTo(cx + 14, cy);
      ctx.lineTo(cx + 6, cy + 5);
      ctx.stroke();
      break;
    case "dashed-line":
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(cx - 70, cy);
      ctx.lineTo(cx + 70, cy);
      ctx.stroke();
      break;
    case "transparent-rect":
      ctx.globalAlpha = 0.22;
      ctx.strokeRect(cx, cy, 90, 60);
      break;
    case "registration-mark": {
      ctx.beginPath();
      ctx.arc(cx, cy, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - 11, cy);ctx.lineTo(cx + 11, cy);
      ctx.moveTo(cx, cy - 11);ctx.lineTo(cx, cy + 11);
      ctx.stroke();
      break;
    }
    case "hand-curve": {
      ctx.beginPath();
      ctx.moveTo(cx - 40, cy);
      ctx.quadraticCurveTo(cx + rng.gaussian(0, 14), cy - 26 + rng.gaussian(0, 6), cx + 44, cy - 4);
      ctx.stroke();
      break;
    }
  }
  ctx.restore();
}

/* --------------------------- photo placeholder -------------------------- */

function paintPlaceholder(ctx: Ctx2D, op: Record<string, unknown>): void {
  const [bx, by, bw, bh] = (op.box as [number, number, number, number]) ?? [0, 0, 60, 40];
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = "#77736a";
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(bx, by, bw, bh);
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx + bw, by + bh);
  ctx.moveTo(bx + bw, by);
  ctx.lineTo(bx, by + bh);
  ctx.globalAlpha = 0.28;
  ctx.stroke();
  ctx.restore();
}

/* ------------------------------- grain ---------------------------------- */

function paintGrain(
  ctx: Ctx2D,
  canvas: { width: number; height: number },
  rng: Rng,
  op: Record<string, unknown>,
  detail = 2,
): void {
  const count = Math.round((canvas.width * canvas.height) / (1400 / Math.min(detail, 3)));
  ctx.save();
  for (let i = 0; i < count; i++) {
    const light = rng.float() < 0.5;
    ctx.fillStyle = light ? "#ffffff" : "#1c1b18";
    ctx.globalAlpha = 0.015 + rng.float() * 0.03;
    ctx.fillRect(rng.float() * canvas.width, rng.float() * canvas.height, 1, 1);
  }
  // misregistration echo of the focal accent
  const px = Number(op.misregistrationPx ?? 0);
  if (px > 0) {
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = "#d8412f";
    ctx.strokeRect(px, -px, 1, 1); // marker only; real channel offset handled in fills
  }
  ctx.restore();
}
