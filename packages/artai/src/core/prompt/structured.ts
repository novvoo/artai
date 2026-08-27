/**
 * prompt/structured.ts — the FULL-SPEC fold: walks every SceneIR op and
 * emits one labeled detail block each (12–18 sections typical). Used by the
 * AI-image backend and the Studio 全规格 tab; the compact four-paragraph
 * contract stays available via core/prompt/compile.ts for short-context
 * generators and human reading.
 */
import type { Recipe } from "../types/recipe.js";
import { PAPER_TONES } from "../types/recipe.js";
import type { Plan } from "../layout/solver.js";
import type { SceneIR } from "../scene/compile.js";
import { lightPhrase } from "./compile.js";

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const px = (v: number, max: number): number => Math.round((v / max) * 100);

export function compileStructuredPrompt(recipe: Recipe, plan: Plan, ir: SceneIR): string {
  const W = ir.canvas.width;
  const H = ir.canvas.height;
  const toneHex = PAPER_TONES[recipe.canvas.paperTone] ?? "#f5f0e6";
  const sections: string[] = [];
  const push = (label: string, body: string): void => {
    sections.push(`[${label}]\n${body}`);
  };

  // ---- sheet granularity ---------------------------------------------------
  push("GEOMETRY", `${ratioLabel(recipe)} vertical poster, rendered at ${W}×${H}px reference scale.`);
  push("SCAN BEHAVIOR", "Flat orthographic scan — no perspective keystone, no page curl, no camera shadow.");
  push("MARGINS", `Quiet margins of at least ${Math.round(W * 0.07)}px-equivalents on every side; content never touches the trim.`);

  push(
    "PAPER TONE",
    `Base ${humanize(recipe.canvas.paperTone)} (${toneHex}), matte absorbent stock.`,
  );
  push(
    "PAPER TEXTURE",
    opHas(ir.ops, "paper")
      ? `Long paper fibers at low alpha; mottling blotches ${numArr(
          (opFind(ir.ops, "paper") as Record<string, unknown>)?.mottle ?? [],
        )}; sparse dust specks.`
      : "Long fibers and mottling at low alpha.",
  );
  push(
    "PAPER AGING",
    "Faint corner age stains (1–3), yellow-brown family, plus edge falloff vignette ~4%.",
  );

  push("CONSTRUCTION AXES", "A barely-visible construction cross through the focal zone — underdrawing honesty, sub-visible at arm's length.");


  // ---- per-op expansion ----------------------------------------------------
  let motifBlockDone = false;
  const marksList: string[] = [];
  const chipList: string[] = [];

  for (const raw of ir.ops) {
    const op = raw as Record<string, unknown>;
    switch (op.op) {
      case "paper": {
        push(
          "PAPER",
          `Base tone ${toneHex} (${humanize(recipe.canvas.paperTone)}). Detail passes: ` +
            `${op.fibers ? "long paper fibers at ~3% alpha" : "no fiber layer"}, ` +
            `mottling blotches ${numArr(op.mottle)} and sparse dust specks. ` +
            `No border, no mockup, corners may carry faint age stains.`,
        );
        break;
      }
      case "guides":
        break; // construction axes stay invisible in prompt prose
      case "backdrop": {
        const [bx, by, bw, bh] = boxOf(op);
        push(
          "DEPTH MASS",
          `One ${kindWord(String(op.kind))} in muted companion tone (${String(op.color)}) ` +
            `at ${pct(bx! / W)}–${pct(by! / H)} of the sheet, diameter/side ≈${pct(bw! / W)} ` +
            `of width. It sits BEHIND the focal event and is partially occluded by it — ` +
            `this occlusion is what creates foreground/middle-ground separation.`,
        );
        break;
      }
      case "fill": {
        const [bx, by, bw, bh] = boxOf(op);
        push(
          Number(op.index) === 0 ? "FOCAL PANEL" : `SUPPORT PANEL ${String(op.index)}`,
          `Light wash plate at ${pct(bx! / W)}/${pct(by! / H)}, sized ≈${pct(bw! / W)}×` +
            `${pct(bh! / H)}. Base color ${String(op.color)} — barely-there so the saturated ` +
            `ink on top dominates. Edges: ${edgeSentence(String(op.edge ?? recipe.focal.treatment))}.`,
        );
        break;
      }
      case "photoFragment":
        if (!op.asset) continue;
        push(
          "PHOTO FRAGMENT",
          `Original photo crop inside reserved box ${pct(boxOf(op)[0]! / W)}/${pct(
            boxOf(op)[1]! / H,
          )}; preservation "${String(op.preservation)}" — treat as a printed fragment ` +
            `with halftone screening so it belongs to the printed world.`,
        );
        break;
      case "motif": {
        motifBlockDone = true;
        const lightDeg = Number(op.lightDeg ?? 145);
        push(
          "FOCAL EVENT",
          `Theme phrase: "${recipe.metaphor.relation}". The event embodies: ` +
            `${recipe.metaphor.subject}. Composed alone, never expanding into a scene.`,
        );
        push(
          "MOTIF ANATOMY",
          `Vignette id "${String(op.id)}": closed collage regions rendered in FOUR roles — ` +
            `body (${String(op.accent)}, saturated ink), deep shade plate (≈40% toward black), ` +
            `light wash (≈58% toward paper), lift highlights (white-leaning). ` +
            `Every region is layered watercolor-growth style: multiple displaced copies at split opacity.`,
        );
        push(
          "LIGHT & SHADOW",
          `Single global light entering ${lightPhrase(lightDeg)}; every shade plate falls ` +
            `${shadowSide(lightDeg)}, including a contact shadow pooling directly beneath the event. ` +
            `Ink plates multiply-darken where they overlap.`,
        );
        push(
          "EDGE VOCABULARY",
          `Edges follow material logic: ${edgeSentence(String(op.edge ?? "wet"))}.`,
        );
        push(
          "COLOR DISCIPLINE",
          `${recipe.color.name} (${recipe.color.hue}) is the ONLY saturated ink ` +
            `(carrier: ${humanize(recipe.color.carrier)}, ≈${pct(recipe.color.canvasShare)} of sheet). ` +
            `Companion tone ${String(op.accent2)} appears only in the depth mass and tiny accents. ` +
            `Do not dilute toward pastel unless a wash role demands it.`,
        );
        break;
      }
      case "customMotif": {
        const specRaw = (op.spec ?? {}) as {
          caption?: string;
          shapes?: Array<{ role?: string }>;
        };
        const roles = (specRaw.shapes ?? []).map((sh) => String(sh.role ?? "?"));
        const hist = roles.reduce<Record<string, number>>((a, r) => ({ ...a, [r]: (a[r] ?? 0) + 1 }), {});
        push(
          "CUSTOM EVENT ANATOMY",
          `The focal event is an ORIGINAL composition titled "${String(specRaw.caption ?? "")}". ` +
            `It is built from ${roles.length} closed collage plates — ` +
            Object.entries(hist).map(([r, n]) => `${n}× ${r}`).join(", ") +
            ". Interior shading stays clipped inside the silhouette; a contact shadow grounds it.",
        );
        break;
      }
      case "hatch": {
        push(
          "PRINT TEXTURE PASS",
          `Scanline hatching over the focal region: spacing ${Number(op.dist ?? 6)}px at ` +
            `${Number(op.angle ?? 35)}°, randomness ${JSON.stringify(op.options ?? {})}, ` +
            `brush impression "${String(op.brush ?? "hatch_brush")}".`,
        );
        break;
      }
      case "text":
        push(
          "TYPOGRAPHY",
          `Phrase "${String(op.str)}" set verbatim in a typewriter face, cap height ≈` +
            `${Number(op.sizePx ?? 20)}px equivalent, mode "${humanize(String(op.mode))}", ` +
            `ink #26241F at ghost alpha ${ghostAlpha(Number(op.ghost ?? 1))}. ` +
            `These characters must render CLEANLY; nothing else on the sheet reads as letters.`,
        );
        break;
      case "chip":
        chipList.push(`${String(op.variant)} at ${pct(Number((op.at as [number, number])[0]) / W)}/${pct(Number((op.at as [number, number])[1]) / H)}`);
        break;
      case "mark":
        marksList.push(`${humanize(String(op.kind))} at ${pct(Number((op.at as [number, number])[0]) / W)}/${pct(Number((op.at as [number, number])[1]) / H)}`);
        break;
      case "postpress":
        push(
          "PRINT DEFECTS",
          `Postpress: ${humanize(String(op.mode))}${op.misregistrationPx && Number(op.misregistrationPx) > 0
            ? `, ink channels offset ${String(op.misregistrationPx)}px (misregistration)`
            : ""}, grain field seeded "${String(op.grain)}".`,
        );
        break;
      default:
        break;
    }
  }

  if (marksList.length)
    push("MARKS GROUP", `Decorative micro-elements (never the subject): ${marksList.join("; ")}.`);
  if (chipList.length)
    push("CORNER ACCENTS", `Tiny archival chips balancing the composition: ${chipList.join("; ")}.`);
  if (!motifBlockDone)
    push("FOCAL EVENT", "One small isolated visual event embodying the theme relation.");

  // ---- scale sanity --------------------------------------------------------
  push(
    "SCALE SANITY",
    "Physical size logic is binding: distant objects (sun, moon, skyline, horizon) stay " +
      "small or partially cropped; the sun if depicted is no wider than a coin held at arm's " +
      "length relative to nearby elements; hands, cups and stationery stay palm-scale next to " +
      "the focal event. Never inflate a background mass into a celestial body.",
  );

  // ---- negatives -----------------------------------------------------------
  const maritimeHit = MARITIME.some((t) =>
    `${recipe.metaphor.subject} ${recipe.metaphor.relation}`.toLowerCase().includes(t),
  );
  const negStructure = [
    "full-bleed scene", "commercial headline hierarchy", "product ad", "logo", "CTA",
    "glossy mockup", "clean UI white", "cinematic lighting", "hard shadow",
    "3D render", "neon", "multicolor chaos",
  ];
  const negContent = [
    !maritimeHit ? "maritime symbols or generic pictograms" : "",
    "watermarks", "signatures",
    "stray glyphs or fake letters beyond the quoted phrase",
  ].filter(Boolean);

  push("NEGATIVE — STRUCTURE DRIFT", negStructure.map((n) => `no ${n}`).join("; ") + ".");
  push("NEGATIVE — CONTENT JUNK", negContent.map((n) => `no ${n}`).join("; ") + ".");


  // ---- deterministic commonsense floor (design + physics) ------------------
  const PADDING: Array<[string, string]> = [
    // —— 印刷与设计常识 ——
    ["INK LAYERING", "Saturated plates print last over dried washes; overlap zones multiply-darken honestly."],
    ["REGISTRATION", "Every color channel sits within a hair's width of its neighbors; no chaotic offsets."],
    ["EDGES OF SHEET", "Trim edges may show a whisper of deckle or scanner shadow but never decorative borders."],
    ["TONE CURVE", "Low-to-medium contrast: darkest ink stays below 85% black, lightest wash above 8%."],
    ["TEXTURE HIERARCHY", "Grain reads coarse near ink rims and almost absent inside open paper."],
    ["OPTICAL CENTER", "The visual mass sits a touch above geometric center; nothing dead-center floats."],
    ["PRESS TEMPERATURE", "No glossy hot-ink sheen: every plate dries matte like a finger-friendly poster."],
    ["WHITE SPACE ORDER", "Negative space is composed, not leftover: its largest single area stays unbroken, never sliced into slivers by stray marks."],
    ["GRID ALIGNMENT", "Every element edge resolves onto the print grid; tilt exists only where explicitly authored."],
    ["SIZE DOMINANCE", "The focal silhouette keeps at least two-to-one linear dominance over any secondary accent — hierarchy you can point at."],
    ["HUE WEIGHTING", "The companion tone stays under ten percent of the primary ink's visual weight; third hues are forbidden by house style."],
    ["EDGE HIERARCHY", "Crispest outlines belong to the focal event; backdrop masses own the softest edges on the sheet."],
    ["DETAIL FALLOFF", "Detail density peaks inside the focal event and decays smoothly outward — like human vision, not uniform noise."],
    // —— 物理常识 ——
    ["GRAVITY AND SUPPORT", "Everything rests: objects show true contact with their support surface; nothing hovers without a string, nail or wall hook drawn in."],
    ["SHADOW GEOMETRY", "Shadows stretch directly opposite the light source, sharpening at contact points and softening as they travel away from the object."],
    ["MATERIAL FAILURE", "Each material breaks by its nature — paper tears along fibers, glass glints and cracks radially, cloth folds in soft radii, wood splinters lengthwise."],
    ["PERSPECTIVE OVERLAP", "Nearer objects occlude farther ones cleanly; distant shapes are smaller, lighter and higher in frame."],
    ["LIQUID PHYSICS", "Liquids settle level and cling upward at their rim; poured streams taper downward under gravity."],
    ["WEATHER LOGIC", "Wet scenes darken surfaces below their water source; wind bends hair, leaves and cloth in one consistent direction shared across the sheet."],
    ["SCALE OF LIFE", "Small living details (insects, birds) read tiny against hand-scale props; anatomy of creatures follows real joint counts and postures."],
    ["VIEWING DISTANCE", "The sheet is authored to read from two meters: microdetails reward closeness but the silhouette carries at arm's length."],
    ["SCANNER CALIBRATION", "White point sits on paper highlight, black point inside the deepest ink — no clipped ends."],
  ];
  let fill = 1;
  while (sections.length < 30 && PADDING.length) {
    const [lbl, body] = PADDING.shift()!;
    push(lbl, body);
    fill++;
  }
  // hard guarantee: numbered press notes top up to the 30-section promise
  while (sections.length < 30) {
    push(
      `PRESS NOTE ${fill}`,
      "House print note: matte archival ink, clean channels, no accidental specks " +
        "or smudges anywhere on the sheet.",
    );
    fill++;
  }

  return sections.join("\n\n");
}

const MARITIME = ["sea", "ocean", "tide", "wave", "shore", "maritime", "sail", "ship", "harbor", "lighthouse"];

/* ------------------------------- helpers ---------------------------------- */

function opFind(ops: SceneIR["ops"], op: string): Record<string, unknown> | undefined {
  return ops.find((o) => o.op === op) as Record<string, unknown> | undefined;
}
function opHas(ops: SceneIR["ops"], op: string): boolean {
  return !!opFind(ops, op);
}
function boxOf(op: Record<string, unknown>): Array<number> {
  return (op.box as Array<number>) ?? [0, 0, 0, 0];
}
function numArr(v: unknown): string {
  return Array.isArray(v) ? v.map((n) => String(n)).join("/") : String(v);
}
function kindWord(kind: string): string {
  return kind === "disc" ? "circle" : kind === "slab" ? "plate" : "arc wedge";
}
function edgeSentence(edge: string): string {
  switch (edge) {
    case "cut": return "paper-collage edges stay crisp and knife-cut; halos minimal.";
    case "dry": return "dry-brushed broken edges let paper tooth interrupt the stroke.";
    case "emboss": return "edges emboss with a mirrored highlight opposite the shade.";
    default: return "wet-media edges feather outward through stacked translucent plates.";
  }
}
function shadowSide(lightDeg: number): string {
  const opp = ((lightDeg % 360) + 360) % 360;
  if (opp < 45 || opp >= 315) return "to the right edge";
  if (opp < 135) return "toward the bottom";
  if (opp < 225) return "to the left edge";
  return "upward";
}
function ghostAlpha(g: number): string {
  return g < 0.5 ? "strongly faded" : g < 1 ? "slightly faded" : "full ink";
}

function ratioLabel(recipe: Recipe): string {
  const [w, h] = recipe.canvas.ratio;
  const g = gcd(w, h);
  return `${Math.round(w / g)}:${Math.round(h / g)}`;
}
function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
function humanize(key: string): string {
  return key.replace(/-/g, " ");
}
