/**
 * raster-p5.ts — primary rasterizer: folds SceneIR into p5.brush (standalone
 * WebGL2 build) calls. Falls back to `null` whenever the environment can't
 * host it; the caller then uses the canvas-fallback path.
 *
 * Ink/natural-media work (paper tone, fills, hatching, letterpress bleed)
 * runs through p5.brush's own state machine — the character layer. Crisp
 * chrome (text/marks/grain) is composited afterwards from the shared overlay
 * so both renderers stay typographically identical (§13 note applies).
 */
import { paintOverlay } from "./overlay.js";
import { Rng } from "../core/util/rand.js";
import type { RasterResult, SceneIRAny } from "./index.js";

export function brushAvailable(): boolean {
  return (
    typeof WebGL2RenderingContext !== "undefined" &&
    typeof document !== "undefined" &&
    !!document.createElement("canvas").getContext("webgl2")
  );
}

/** inline hex mixer for standalone adapter */
function mixN(a: string, b: string, t: number): string {
  const pa = parseInt(a.replace("#",""),16), pb = parseInt(b.replace("#",""),16);
  const ra=(pa>>16)&255, ga=(pa>>8)&255, ba=pa&255;
  const rb=(pb>>16)&255, gb=(pb>>8)&255, bb=pb&255;
  return "#"+[Math.round(ra+(rb-ra)*t),Math.round(ga+(gb-ga)*t),Math.round(ba+(bb-ba)*t)].map(c=>c.toString(16).padStart(2,"0")).join("");
}
let __detailLocal = 2;
function D_LOCAL(): number { return __detailLocal; }

export async function rasterizeBrush(
  ir: SceneIRAny,
  opts: { seed: number; host?: HTMLElement; detail?: number },
): Promise<RasterResult> {
  // @ts-expect-error untyped standalone build (plain-JS dist)
  const B: Record<string, any> = await import("p5.brush/standalone");
  if (!brushAvailable()) throw new Error("WebGL2 host unavailable");

  const W = ir.canvas.width;
  const H = ir.canvas.height;
  B.seed(opts.seed);
  if (opts.detail) { __detailLocal = opts.detail; }
  B.noiseSeed(opts.seed);

  // snapshot canvases that existed BEFORE creation so we can identify the
  // newly-spawned GL surface regardless of where p5.brush mounts it
  const knownCanvases = new Set<HTMLCanvasElement>();
  if (typeof document !== "undefined")
    document.querySelectorAll("canvas").forEach((c) => knownCanvases.add(c));

  const mount =
    opts.host ??
    (() => {
      const d = document.createElement("div");
      d.style.cssText =
        "position:fixed;left:-99999px;top:-99999px;width:" + W + "px;height:" + H + "px";
      document.body.appendChild(d);
      opts.host = d as HTMLElement;
      return d;
    })();

  // standalone build creates and owns its WEBGL canvas
  B.createCanvas(W, H);
  try {
    B.angleMode(B.DEGREES);
  } catch {
    /* older builds default to degrees */
  }
  // WEBGL origin sits at canvas CENTER — shift to TOP-LEFT so every IR
  // coordinate (authored in scan-space) lands exactly where planned.
  // Same reason the official sketch calls translate(-width/2,-height/2).
  B.translate(-W / 2, -H / 2);

  // Example2-derived brush kit: the custom "wash" tip (official teaser
  // params: scatter 1.05 / spacing 0.3 / pressure [0.8,1.3] / rotate natural,
  // low opacity for layered stacking) plus canvas-relative brush scaling.
  try {
    B.scaleBrushes(Math.max(1, Math.min(W, H) / 800));
    B.add("artai-wash", {
      type: "custom",
      weight: 10,
      scatter: 1.05,
      opacity: 9,
      spacing: 0.3,
      pressure: [0.8, 1.3],
      rotate: "natural",
      tip: (_m: {
        fill(r: number, g?: number, b?: number, a?: number): void;
        rect(x: number, y: number, w: number, h: number): void;
      }) => {
        _m.fill(0, 200);
        _m.rect(-20, -20, 50, 50);
        _m.rect(25, 25, 20, 20);
      },
    });
  } catch {
    /* duplicate registration or older builds — harmless */
  }

  const warnings: string[] = [];
  const rng = new Rng(`${opts.seed}:p5`);

  // p5.brush's own expressiveness layer: a vector field that bends every
  // subsequent stroke (the library's signature "hand" quality), with
  // wiggle amount varied per poster
  const FIELD_POOL = ["curved", "hand", "seabed", "waves", "zigzag"] as const;
  const fieldName = rng.pick(FIELD_POOL);
  let fieldLive = false;
  try {
    B.field(fieldName);
    B.wiggle?.(rng.range(0.6, 1.4));
    fieldLive = true;
  } catch (err) {
    warnings.push(`field ${fieldName}: ${(err as Error).message}`);
  }

  const warningsRef = { push: (w: string) => warnings.push(w) };

  for (const op of ir.ops) {
    try {
      switch (op.op) {
        case "motif": {
          // render motif shapes natively in GL: silhouette fill + hatch + contour.
          // Much richer than late-chrome overlay because fills/hatches go through
          // p5.brush's full ink pipeline (pressure dabs, scatter, field bending).
          const mid = String(op.id ?? "specimen-frame");
          const [mx, my, mw, mh] = op.box as [number,number,number,number];
          const mAccent = String(op.accent ?? "#d8412f");
          const paperTone = String(op.paper ?? "#f5f0e6");
          void mid; void paperTone;
          try {
            B.push();
            B.noStroke();

            // underplate wash across motif zone
            B.fill(mixN(mAccent, "#ffffff", 0.35), 90);
            B.rect(mx, my, mw, mh);

            // grow-stacked main body plate (like scene-6 layering)
            const modeE = String(op.edge ?? "wet");
            const layersN = modeE === "cut" ? 3 : Math.round(8 * Math.max(1, D_LOCAL()));
            B.fill(mixN(mAccent, "#000000", 0.08), 65);
            if (modeE !== "cut") {
              B.fillBleed?.(0.12);
              B.fillTexture?.(0.35, 0.3);
            }
            B.rect(mx + mw*0.06, my + mh*0.06, mw*0.88, mh*0.88);

            for (let li = 0; li < layersN; li++) {
              const t = li / layersN;
              const jx = rng.gaussian(0, t * mw * 0.01);
              const jy = rng.gaussian(0, t * mh * 0.01);
              B.push(); B.translate(jx, jy);
              B.fill(mAccent, Math.round(160 / layersN));
              B.rect(mx + mw*0.04, my + mh*0.04, mw*0.92, mh*0.92);
              B.pop();
            }

            // inner hatch texture for depth
            if (modeE === "risograph-grain" || modeE === "halftone-degradation") {
              B.hatchStyle("2B", mixN(mAccent,"#26241f",0.4), 1);
              B.hatch(6, 35, { rand:0.25, continuous:false });
              B.rect(mx+mw*0.06,my+mh*0.06,mw*0.88,mh*0.88);
              B.noHatch();
            }
            B.pop();
          } catch (err) { warningsRef.push(`motif: ${(err as Error).message}`); }
          break;
        }
        case "strokeset": {
          // the library idiom: field-bent beginStroke/move loops (official
          // spiral example), using absolute px coordinates like our fills
          const count = Number(op.count ?? 3);
          const [bx, by] = op.box as [number, number];
          const bw = Number((op.box as [number, number, number, number])[2]);
          const bh = Number((op.box as [number, number, number, number])[3]);
          const cx = bx + bw / 2;
          const cy = by + bh / 2;
          const rMax = Math.min(bw, bh) / 2.4;
          const palette = (op.palette as string[]) ?? ["#26241f"];
          try {
            B.field(String(op.field ?? "curved"));
            B.pick(rng.float() < 0.5 ? "marker" : "marker2");
            B.scaleBrushes?.(1.15);
            for (let n = 0; n < count; n++) {
              const color = palette[n % palette.length]!;
              B.stroke(color);
              B.beginStroke(
                "curve",
                cx + rng.gaussian(0, bw * 0.04),
                cy + rng.gaussian(0, bh * 0.04),
              );
              const init = rng.range(0, 360);
              const turns = Number(op.turns ?? 4);
              for (let i = 0; i < turns * 4; i++) {
                const q = i % 4;
                const base = [0, 90, 180, 270][q]!;
                const grow = ((i * 25) % 220) / 220;
                B.move(
                  base + init,
                  rMax * 0.24 * (0.55 + grow * 1.35),
                  rng.range(0.6, 1.6),
                );
              }
              B.endStroke(init, 1);
            }
          } catch (err) {
            warningsRef.push(`strokeset: ${(err as Error).message}`);
          }
          break;
        }
        case "paper":
          paperBrush(B, op, ir.canvas.width, ir.canvas.height);
          break;
        case "panelShadow": {
          const [px2, py2, pw2, ph2] = op.box as [number, number, number, number];
          B.noStroke();
          B.fill(String(op.color ?? "#8a8375"), 46);
          B.rect(px2 + Number(op.dx ?? 4), py2 + Number(op.dy ?? 3), pw2, ph2);
          break;
        }
        case "fill":
          fillBrush(B, op, ir, rng, fieldLive, warningsRef);
          break;
        case "hatch":
          hatchBrush(B, op, ir, rng);
          break;
        default:
          break;
      }
    } catch (err) {
      warnings.push(`op ${op.op}: ${(err as Error).message}`);
    }
  }

  B.render(); // standalone build requires explicit frame flush

  // composite GL frame into a plain 2D canvas → shared overlay → PNG
  let glCanvas: HTMLCanvasElement | null =
    mount.querySelector("canvas");
  if (!glCanvas && typeof document !== "undefined") {
    for (const c of document.querySelectorAll("canvas")) {
      if (!knownCanvases.has(c)) { glCanvas = c; break; }
    }
  }
  if (!glCanvas) {
    if (mount && mount.parentElement) mount.parentElement.removeChild(mount);
    throw new Error(
      "p5.brush did not expose its canvas element (searched mount + whole document)",
    );
  }

  const out = document.createElement("canvas");
  out.width = glCanvas.width;
  out.height = glCanvas.height;
  const octx = out.getContext("2d")!;
  octx.drawImage(glCanvas, 0, 0, out.width, out.height);

  paintOverlay(octx, ir as unknown as Record<string, unknown>, rng, opts.detail ?? 2);

  const dataUrl = out.toDataURL("image/png");

  /* ---- LAYER TEARDOWN (guaranteed, all paths) ----
   * Every transient canvas must leave BOTH the DOM and the GPU: an idle
   * WebGL context counts against the browser's per-page limit and will
   * eventually kill older surfaces or fail new ones. */
  disposeGlContext(glCanvas);
  glCanvas.remove();                                  // DOM exit
  if (mount && mount.parentElement)
    mount.parentElement.removeChild(mount);           // wrap exit

  if (warnings.length) console.warn("[artai render]", warnings);
  return { canvas: out, dataUrl, renderer: "p5.brush", warnings };
}

/**
 * Spec-backed GPU release: WEBGL_lose_context frees the context slot even
 * though JS references are gone; shrinking the buffer stops residual paint.
 */
function disposeGlContext(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  try {
    const gl = (canvas.getContext("webgl2") ??
      canvas.getContext("webgl")) as WebGL2RenderingContext | null;
    const lc = gl?.getExtension("WEBGL_lose_context") as
      | { loseContext(): void } | undefined;
    lc?.loseContext();
  } catch {
    /* best-effort */
  }
  canvas.width = 1;
  canvas.height = 1;
}

/* --------------------------- op interpreters ----------------------------- */

type Op = Record<string, any>;

function paperBrush(B: Record<string, any>, op: Op, w: number, h: number): void {
  B.noStroke();
  B.fill(String(op.tone ?? "#f5f0e6"), 255);
  B.rect(0, 0, w, h);
}

function polyPts(ir: SceneIRAny, ref: unknown): Array<{ x: number; y: number }> | null {
  if (typeof ref !== "string") return null;
  return ((ir.defs ?? {})[ref] as Array<{ x: number; y: number }>) ?? null;
}

function drawShape(
  B: Record<string, any>,
  ir: SceneIRAny,
  op: Op,
): void {
  const pts = polyPts(ir, op.poly);
  if (pts) {
    B.beginShape();
    for (const p of pts) B.vertex(p.x, p.y);
    B.endShape();
  } else {
    const [x, y, w, h] = op.box as [number, number, number, number];
    B.rect(x, y, w, h);
  }
}

function fillBrush(
  B: Record<string, any>,
  op: Op,
  ir: SceneIRAny,
  _rng: Rng,
  fieldLive: boolean,
  warn: { push(w: string): void },
): void {
  const color = String(op.color ?? "#33312d");
  const bleed = op.bleed as [number, string] | undefined;

  B.noStroke();
  // letterpress bleed pre-passes
  if (bleed && bleed[0] > 0) {
    B.fill(color, 70);
    for (let k = 0; k < 2; k++) {
      B.push();
      B.translate((k === 0 ? 1 : -1) * bleed[0]! * 6, -bleed[0]! * 6);
      drawShape(B, ir, op);
      B.pop();
    }
  }

  // Example2 scene-6 layering: translucent wash + bleed + texture per plate
  const mode = String((op.texture as { mode?: string } | undefined)?.mode ?? "");
  const tMode = mode;
  
  if (mode !== "misregistration") {
    B.fill(color, 70);
    if (typeof B.fillBleed === "function") B.fillBleed(bleed ? bleed[0]! : 0.15);
    if (typeof B.fillTexture === "function") B.fillTexture(0.4, 0.4);
    drawShape(B, ir, op);
    B.noFill();
  }
  B.fill(color, 200);
  drawShape(B, ir, op);

  // treatment-specific brush language on the cluster rim — this is where
  // p5.brush's personality shows: different brushes + a live flow field make
  // every poster's edge unmistakably its own
  
  const edgeBrush =
    tMode === "xerox-softness"
      ? "marker2"
      : mode === "risograph-grain"
        ? "spray"
        : mode === "film-grain"
          ? "cpencil"
          : mode === "misregistration"
            ? "charcoal"
            : null;
  if (!edgeBrush || !op.box || !fieldLive) return;

  try {
    const [bx, by, bw, bh] = op.box as [number, number, number, number];
    const strokes = Math.round(Math.min(26, Math.max(8, (bw + bh) / 46)));
    B.set(edgeBrush, color, mode === "spray" ? 2 : 1.4);
    for (let k = 0; k < strokes; k++) {
      const along = k % 4; // which rim
      const t = _rng.float();
      let x: number, y: number;
      if (along === 0) { x = bx + t * bw; y = by - 3; }
      else if (along === 1) { x = bx + bw + 3; y = by + t * bh; }
      else if (along === 2) { x = bx + t * bw; y = by + bh + 3; }
      else { x = bx - 3; y = by + t * bh; }
      // flow field bends these stubs organically — never two alike
      B.flowLine(x, y, 10 + _rng.float() * 16);
    }
  } catch (err) {
    warn.push(`edge ${edgeBrush}: ${(err as Error).message}`);
  }
}

function hatchBrush(B: Record<string, any>, op: Op, ir: SceneIRAny, rng: Rng): void {
  const dist = Number(op.dist ?? 6);
  const angle = Number(op.angle ?? 35);
  const rand = Number(op.options?.rand ?? 0);

  B.hatchStyle(String(op.brush ?? "hatch_brush"), String(op.color ?? "#43413c"), 1);
  B.hatch(dist, angle, {
    rand,
    continuous: rng.float() < 0.4,
    gradient: rng.float() < 0.35 ? 1.06 : false,
  });
  drawShape(B, ir, op);
  // second pass for denser printed-degradation reads (cross-hatch)
  if (Number(dist) <= 5 && rng.float() < 0.5) {
    B.hatch(dist * 1.7, angle + 68, { rand, continuous: false });
    drawShape(B, ir, op);
  }
  B.noHatch();
}
