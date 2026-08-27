import { describe, expect, it } from "vitest";
import {
  DEMO_ENVELOPE,
  DEMO_FISH,
  applyCustomMotif,
  sanitizeCustomMotif,
} from "../../src/core/scene/custom.js";
import { StubIntentProvider } from "../fixtures/intent-stub.js";
import { realize } from "../../src/core/pipeline.js";

describe("LLM-authored motif specs", () => {
  it("demo specs pass sanitization untouched in structure", () => {
    expect(DEMO_ENVELOPE.shapes.length).toBeGreaterThanOrEqual(4);
    expect(DEMO_FISH.shapes[0]!.role).toBe("body");
    expect(DEMO_FISH.clipSilhouette).toBe(true);
  });

  it("coordinates are clamped into sane bounds on sanitize", () => {
    const spec = sanitizeCustomMotif({
      caption: "wild",
      shapes: [
        { d: "M-500 -900 L9000 80 L40 60 Z", role: "body" },
        { d: "M10 10 L90 8 L88 92 L12 90 Z", role: "lift" },
      ],
      clipSilhouette: true,
    });
    const allNums = spec.shapes.flatMap((s) => s.d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    for (const n of allNums) expect(n).toBeGreaterThanOrEqual(-20);
    for (const n of allNums) expect(n).toBeLessThanOrEqual(120);
  });

  it("applyCustomMotif swaps the builtin op in place, keeping neighbors", async () => {
    const draft = await new StubIntentProvider().parse({ theme: "迟迟没有寄出的信" });
    const env = realize(draft, { seed: 42 });
    const kindsBefore = env.ir.ops.map((o) => o.op);
    const idx = kindsBefore.indexOf("motif");
    expect(idx).toBeGreaterThan(-1);

    applyCustomMotif(env.ir, DEMO_FISH);
    const after = env.ir.ops.map((o) => o.op);
    expect(after[idx]).toBe("customMotif");
    expect(after.length).toBe(kindsBefore.length);
    // palette context travels with the replaced op
    const custom = env.ir.ops[idx] as { palette?: Record<string,string> };
    expect(custom.palette?.body).toMatch(/^#/);
  });
});
