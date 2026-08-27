import { describe, expect, it } from "vitest";
import { StubIntentProvider } from "../fixtures/intent-stub.js";
import { realize } from "../../src/core/pipeline.js";
import { solveLayout } from "../../src/core/layout/solver.js";
import { compileScene } from "../../src/core/scene/compile.js";
import { resolveMotifId } from "../../src/core/recipe/motifs.js";
import { pickRecipe } from "../../src/core/recipe/variation.js";
import { PAPER_TONES } from "../../src/core/types/recipe.js";

const provider = new StubIntentProvider();

describe("scene IR", () => {
  it("paper wash leads; construction axes ride above it; JSON-round-trips", async () => {
    const draft = await provider.parse({ theme: "窗边的一杯凉水" });
    const env = realize(draft, { seed: 11 });
    const ir = env.ir;

    expect(ir.irVersion).toBe(1);
    const kinds = ir.ops.map((o) => o.op);
    expect(kinds[0]).toBe("paper");
    expect(kinds.indexOf("guides")).toBeGreaterThan(0); // axes ride above wash
    expect(kinds.indexOf("backdrop")).toBeGreaterThan(-1);

    for (const op of ir.ops) {
      if (typeof op.poly === "string") expect(Object.keys(ir.defs)).toContain(op.poly);
      if (typeof op.region === "string") expect(Object.keys(ir.defs)).toContain(op.region);
    }
    const roundTrip = JSON.parse(JSON.stringify(ir));
    expect(roundTrip).toEqual(ir);
  });

  it("paper op carries the resolved hex of the recipe's paper tone", async () => {
    const draft = await provider.parse({ theme: "旧书店的最后一排书架" });
    const recipe = pickRecipe(draft, { seed: 3 });
    // scenes require a resolved subject; supply one via strict palette
    recipe.visual = { motifId: resolveMotifId("open-book")! };
    const plan = solveLayout(recipe);
    const ir = compileScene(recipe, plan);
    const paperOp = ir.ops.find((o) => o.op === "paper");
    expect(paperOp).toBeDefined();
    if (paperOp) expect(paperOp.tone).toBe(PAPER_TONES[recipe.canvas.paperTone]);
  });

  it("unresolved subjects refuse to render (strict policy)", async () => {
    const draft = await provider.parse({ theme: "时间的形状" });
    const recipe = pickRecipe(draft, { seed: 4 });
    delete (recipe as { visual?: unknown }).visual;
    expect(() => compileScene(recipe, solveLayout(recipe))).toThrow(
      /IntentIncompleteError/,
    );
  });

  it("structured prompt is sectioned and mentions motif anatomy", async () => {
    const draft = await provider.parse({ theme: "迟迟没有寄出的信" });
    const env = realize(draft, { seed: 5 });
    const { compileStructuredPrompt } = await import("../../src/core/prompt/structured.js");
    const text = compileStructuredPrompt(env.recipe, env.plan, env.ir);
    const labels = [...text.matchAll(/^\[([A-Z0-9 .—&-]+)\]/gm)].map((m) => m[1]);
    expect(labels.length).toBeGreaterThanOrEqual(20);
    expect(text).toMatch(/\[MOTIF ANATOMY\]/);
  });
});
