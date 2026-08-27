import { describe, expect, it } from "vitest";
import { StubIntentProvider } from "../fixtures/intent-stub.js";
import { realize, realizeBatch } from "../../src/core/pipeline.js";
import { compilePrompt, paragraphCount } from "../../src/core/prompt/compile.js";
import { getDefaultProvider, setDefaultProvider } from "../../src/index.js";

const provider = new StubIntentProvider();

describe("heuristic provider", () => {
  it("classifies photo roles per the skill's wording rules", async () => {
    expect(await provider.classifyRole("把这张照片做成海报")).toBe("edit-target");
    expect(await provider.classifyRole("参考这张图的风格和构图")).toBe("reference-image");
    expect(await provider.classifyRole("把照片里的这个人放进去")).toBe("supporting-insert");
    expect(await provider.classifyRole("保留这个产品外形，换成纸感海报")).toBe("edit-target");
    expect(await provider.classifyRole("今天天气不错")).toBeNull();
  });

  it("produces schema-valid drafts deterministically", async () => {
    const a = await provider.parse({ theme: "一只麋鹿与花草错过的夏天" });
    const b = await provider.parse({ theme: "一只麋鹿与花草错过的夏天" });
    expect(a).toEqual(b);
    expect(["quiet", "summer", "solitude", "childhood", "seaside", "afternoon", "night", "memory", "surreal"]).toContain(a.mood);
  });

  it("maps themes onto their fixture metaphor objects", async () => {
    const summer = await provider.parse({ theme: "蝉声很长的夏天" });
    const rain = await provider.parse({ theme: "梅雨季的窗" });
    expect(summer.metaphor.subject.toLowerCase()).toContain("cicada");
    expect(rain.metaphor.subject.toLowerCase()).toContain("raindrops");
  });
});

const letterDraft = async () => await provider.parse({ theme: "迟迟没有寄出的信" });

describe("realize pipeline", () => {
  it("passes gate with zero violations on typical themes", async () => {
    const env = realize(await letterDraft(), { seed: 42 });
    expect(env.gate.violations).toEqual([]);
    expect(env.gate.pass).toBe(true);
    expect(env.meta.degraded).toBe(false);
  });

  it("prompt is exactly four paragraphs with measured numbers", async () => {
    const env = realize(await letterDraft(), { seed: 7 });
    expect(paragraphCount(env.prompt)).toBe(4);
    expect(env.prompt).toMatch(/open paper|untouched/);
    expect(env.prompt).toMatch(/sole saturated (accent|ink)/);
    expect(env.prompt).not.toMatch(/somewhere|nice|artistic/);
  });

  it("eval #8 as code: red-accent non-maritime theme grows no maritime grammar", async () => {
    const base = await letterDraft();
    const red = { ...base, metaphor: { subject: "a bright red seal stamp pressed crooked", relation: "urgency applied late" } };
    const env = realize(red, { seed: 8 });
    for (const word of ["anchor", "buoy", "lighthouse", "harbor", "nautical"]) {
      expect(env.prompt.toLowerCase()).not.toContain(word);
      expect(env.gate.violations.map((v) => v.code)).not.toContain("FORBIDDEN_METAPHOR_TOKEN");
    }
  });

  it("maritime themes keep their grammar without violations", async () => {
    const base = await letterDraft();
    const sea = { ...base, metaphor: { subject: "a mooring rope slack over tide-worn wood", relation: "holding that has loosened" } };
    const env = realize(sea, { seed: 9 });
    expect(env.gate.violations.map((v) => v.code)).not.toContain("FORBIDDEN_METAPHOR_TOKEN");
  });
});

describe("batch discipline", () => {
  it("count-6 batch passes family/diversity rules after repair", async () => {
    const draft = await provider.parse({ theme: "海边的下午" });
    setDefaultProvider(provider);
    const { envelopes, batchViolations } = realizeBatch(draft, 6, { seed: 5 });
    expect(envelopes).toHaveLength(6);
    const families = new Set(envelopes.map((e) => e.recipe.layout.family));
    expect(families.size).toBeGreaterThanOrEqual(3);
    const dotOnly = envelopes.filter(
      (e) => e.recipe.color.carrier === "dot" || e.recipe.color.carrier === "hairline",
    ).length;
    expect(dotOnly / envelopes.length).toBeLessThanOrEqual(0.4);
    // repaired until clean (or honest residue)
    expect(batchViolations.length).toBeLessThanOrEqual(1);
    void getDefaultProvider; // configured default unused in pure path
    setDefaultProvider(null);
  });
});
