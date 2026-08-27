/**
 * custom.ts — LLM-AUTHORED MOTIFS ("live motif generation").
 *
 * The model authors a bounded declarative spec of SHAPES in a 100×100 unit
 * box (SVG-path syntax), tagged with palette ROLES (body/deep/wash/lift/line)
 * resolved to actual hexes at render time. Two canonical DEMO specs ship
 * below: they are injected into the design prompt as few-shot examples AND
 * double as test fixtures.
 *
 * Safety: zod-validated, ≤40 shapes, coordinates auto-clamped, path length
 * capped. Rendering happens in the late-chrome layer (identical pixels on
 * both rasterizers), silhouettes may declare clip so interiors never leak.
 */
import { z } from "zod";
import { mix } from "../util/color.js";

export const ShapeRoleSchema = z.enum(["body", "deep", "wash", "lift", "line"]);
export type ShapeRole = z.infer<typeof ShapeRoleSchema>;

export const CustomShapeSchema = z.object({
  /** SVG path data, viewport 0..100 × 0..100 */
  d: z.string().min(3).max(1600),
  role: ShapeRoleSchema,
  /** role default unless overridden */
  alpha: z.number().min(0.08).max(1).optional(),
  lw: z.number().min(0.4).max(4).optional(),
});
export type CustomShape = z.infer<typeof CustomShapeSchema>;

export const CustomMotifSpecSchema = z.object({
  /** one-line poetic description of what is depicted */
  caption: z.string().max(80),
  shapes: z.array(CustomShapeSchema).min(2).max(40),
  /** treat the union of the two largest `body` shapes as one silhouette and
   * clip every later decoration inside it (single-piece anatomy rule) */
  clipSilhouette: z.boolean().default(true),
  /** ground contact ellipse */
  shadow: z.boolean().default(true),
});

export type CustomMotifSpec = z.infer<typeof CustomMotifSpecSchema>;

export class MotifSpecError extends Error {
  constructor(message: string) {
    super(`MotifSpecError: ${message}`);
    this.name = "MotifSpecError";
  }
}

/** Clamp coordinates into the unit box; strip junk; enforce caps. */
export function sanitizeCustomMotif(raw: unknown): CustomMotifSpec {
  const clampNum = (v: number): number => Math.max(-20, Math.min(120, v));
  const repositionNumbers = (d: string): string =>
    // every numeric run gets clamped, keeping command letters intact
    d.replace(/-?\d+(?:\.\d+)?/g, (n) => String(clampNum(Number(n))));
  const cleaned: CustomMotifSpec = (() => {
    try {
      return CustomMotifSpecSchema.parse(raw);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "validation failed";
      throw new MotifSpecError(msg.slice(0, 140));
    }
  })();
  return {
    ...cleaned,
    shapes: cleaned.shapes.map((sh) => ({
      ...sh,
      d: repositionNumbers(sh.d).slice(0, 1600),
      alpha: sh.alpha ?? undefined,
    })),
  };
}

/** Remove the builtin motif op, insert this authored one at the same index. */
export function applyCustomMotif(
  ir: import("./compile.js").SceneIR,
  spec: CustomMotifSpec,
): void {
  const idx = ir.ops.findIndex((o) => o.op === "motif");
  if (idx === -1)
    throw new MotifSpecError("no builtin motif op to replace — pipeline integrity issue");
  const builtin = ir.ops[idx] as Record<string, unknown>;
  // inherit the render-critical palette/light context the builtin carried
  ir.ops[idx] = {
    op: "customMotif",
    box: builtin.box,
    accent: builtin.accent,
    accent2: builtin.accent2,
    paper: builtin.paper,
    lightDeg: builtin.lightDeg,
    species: builtin.species,
    palette: {
      body: String(builtin.accent ?? "#d8412f"),
      deep: mix(String(builtin.accent ?? "#d8412f"), "#1c1b18", 0.42),
      wash: mix(String(builtin.accent ?? "#d8412f"), String(builtin.paper ?? "#f5f0e6"), 0.6),
      lift: mix(String(builtin.paper ?? "#f5f0e6"), "#ffffff", 0.25),
      line: mix(String(builtin.accent ?? "#d8412f"), "#1c1b18", 0.55),
    },
    spec: cleanedForSerialization(spec),
  };
}

function cleanedForSerialization(spec: CustomMotifSpec): CustomMotifSpec {
  return JSON.parse(JSON.stringify(spec));
}

/* ============================ demo specs ================================ */

/** Envelope — teaches: closed main body, layered flap, accent detail. */
export const DEMO_ENVELOPE: CustomMotifSpec = sanitizeCustomMotif({
  caption: "unsealed letter, flap raised",
  clipSilhouette: false,
  shadow: true,
  shapes: [
    { d: "M10 28 L90 26 L92 78 L8 80 Z", role: "wash", alpha: 0.96 },
    { d: "M8 30 Q50 62 92 28 L92 40 Q50 70 8 42 Z", role: "deep", alpha: 0.9 },
    { d: "M16 36 Q50 66 84 36 L84 44 Q50 74 16 46 Z", role: "body", alpha: 0.94 },
    { d: "M42 64 Q50 58 57 65 Q60 73 50 76 Q41 72 42 64 Z", role: "line", alpha: 0.95 },
    { d: "M47 86 Q50 82 53 86 Q52 90 47 86 Z", role: "lift", alpha: 0.9 },
  ],
});

/** Fish — teaches: SINGLE connected silhouette (clip) + interior plates. */
export const DEMO_FISH: CustomMotifSpec = sanitizeCustomMotif({
  caption: "one quiet fish, nose to the left",
  clipSilhouette: true,
  shadow: true,
  shapes: [
    { d: "M12 52 Q30 30 55 32 Q78 34 86 48 L96 38 L96 62 L86 52 Q78 68 55 70 Q30 72 12 52 Z",
      role: "body", alpha: 0.97 },
    { d: "M30 46 Q48 40 66 46 Q48 54 30 46 Z", role: "lift", alpha: 0.75 },
    { d: "M52 66 Q56 76 63 80 Q55 79 49 71 Z", role: "deep", alpha: 0.85 },
    { d: "M22 44 Q27 39 33 43 Q29 47 22 44 Z", role: "deep", alpha: 0.8 },
  ],
});
