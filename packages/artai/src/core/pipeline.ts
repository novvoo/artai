/**
 * pipeline.ts — realize(): the bounded repair loop from §14.
 * Pure and provider-agnostic: consumes an IntentDraft, never a live model.
 */
import { parseRecipe, type IntentDraft, type Recipe } from "./types/index.js";
import { pickRecipe } from "./recipe/variation.js";
import { checkBatch, repairBatch } from "./recipe/constraints.js";
import { solveLayout, type Plan } from "./layout/solver.js";
import { compileScene, type SceneIR } from "./scene/compile.js";
import { compilePrompt } from "./prompt/compile.js";
import { checkCore, type Violation } from "./gate/checks-core.js";
import { resolveMotifId } from "./recipe/motifs.js";
import { Rng } from "./util/rand.js";

export interface Envelope {
  recipe: Recipe;
  plan: Plan;
  ir: SceneIR;
  prompt: string;
  gate: { pass: boolean; violations: Violation[]; measured: Plan["measured"] };
  meta: {
    seedUsed: number;
    attempts: number;
    degraded: boolean;
    intentSource: string;
    durationMs: number;
  };
}

export interface RealizeOptions {
  readonly seed: number;
  /** compute-density knob 1–6 threaded onto the Recipe (texture engines scale with it) */
  readonly detail?: number;
  readonly maxAttempts?: number; // mirrors the skill's regenerate-once rule, default 2
  readonly backend?: "render" | "prompt" | "hybrid";
  /** user-locked accent hex (studio 配色 preset) — forwarded to pickRecipe */
  readonly accent?: string;
  /** user-locked paper tone hex (studio 配色 preset) */
  readonly paperTone?: string;
  /** registered render-asset id of the user's original photo — forwarded to
   * pickRecipe so the photoFragment op paints REAL pixels (photo-input mode) */
  readonly photoAssetId?: string;
  readonly onStage?: (stage: StageName, data?: unknown) => void;
}

export type StageName =
  | "intent"
  | "recipe"
  | "layout"
  | "scene"
  | "gate"
  | "done";

export function realize(draft: IntentDraft, opts: RealizeOptions): Envelope {
  const t0 = now();
  const maxAttempts = opts.maxAttempts ?? 2;
  let best: Envelope | null = null;
  let bestViolations: Violation[] = [];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const seedUsed = deriveSeed(opts.seed, attempt);
    opts.onStage?.("recipe");
    const recipe = pickRecipe(draft, {
      seed: seedUsed,
      detail: opts.detail,
      accent: opts.accent,
      paperTone: opts.paperTone,
      ...(opts.photoAssetId ? { photoAssetId: opts.photoAssetId } : {}),
      contentKey: `${draft.metaphor.subject}|${draft.metaphor.relation}`,
    });
    const motifId = resolveMotifId(draft.motifHint);

    opts.onStage?.("layout");
    const plan = solveLayout(recipe);

    opts.onStage?.("scene");
    if (!recipe.visual) recipe.visual = {};
    recipe.visual.motifId = motifId ?? undefined;

    const ir = compileScene(recipe, plan);

    opts.onStage?.("gate");
    const violations = checkCore(recipe, plan);

    const envelope: Envelope = {
      recipe,
      plan,
      ir,
      prompt: compilePrompt(recipe, plan, ir),
      gate: { pass: violations.length === 0, violations, measured: plan.measured },
      meta: {
        seedUsed,
        attempts: attempt + 1,
        degraded: false,
        intentSource: recipe.provenance.intentSource ?? "heuristic",
        durationMs: now() - t0,
      },
    };

    if (envelope.gate.pass) return envelope;

    // keep the least-violating attempt ("return the better result")
    if (!best || violations.length < bestViolations.length) {
      best = envelope;
      bestViolations = violations;
    }
    // tightening between attempts: variation resamples via derived seed;
    // explicit constraint fixes (drop marks / shrink) happen in solveLayout.
  }

  if (!best) throw new Error("unreachable: realize produced no attempt");
  best.meta.degraded = true;
  best.gate.violations = bestViolations;
  best.gate.pass = false;
  return best;
}

/** Batch realize with the zine variety discipline enforced (eval #1 at scale). */
export function realizeBatch(
  draft: IntentDraft,
  count: number,
  baseOpts: Omit<RealizeOptions, "seed"> & { seed: number },
): { envelopes: Envelope[]; batchViolations: ReturnType<typeof checkBatch> } {
  const envelopes: Envelope[] = [];
  const makeOne = (index: number, saltSeed: number): Recipe => {
    const env = realize(draft, { ...baseOpts, seed: deriveSeed(baseOpts.seed + saltSeed * 7919, index) });
    if (envelopes[index] !== undefined) envelopes[index] = env;
    else envelopes[index] = env;
    return env.recipe;
  };

  // first pass: straight seeds
  const recipes: Recipe[] = [];
  for (let i = 0; i < count; i++) {
    recipes.push(makeOne(i, 0));
  }
  // enforce discipline: resample violators
  const { violations } = repairBatch(recipes, (index, salt) => makeOne(index, salt));
  return { envelopes, batchViolations: violations };
}

function deriveSeed(base: number, attempt: number): number {
  const rng = new Rng(`${base}:attempt${attempt}`);
  return rng.int(0, 2 ** 31);
}

const now = (): number =>
  typeof performance !== "undefined" ? Math.round(performance.now()) : Date.now();

// keep parseRecipe reachable through this module's public surface for CLI use
export { parseRecipe };
