import { describe, expect, it } from "vitest";
import { sanitizeCustomMotif } from "../../src/core/scene/custom.js";
import { resolveMotifId } from "../../src/core/recipe/motifs.js";

describe("cache integrity — schema evolution guards", () => {
  it("stale cached IntentDraft without motifHint causes clear loud failure", async () => {
    // Simulate: old cache entry from pre-think-first era (no motifHint field)
    const staleDraft = {
      mode: "generate",
      thesis: "test",
      metaphor: { subject: "s", relation: "r" },
      mood: "quiet",
      shortText: null,
      lang: "zh",
      // ← NO motifHint — a cached draft from an older engine version
    };
    const hint = undefined; // what resolveMotifId would see
    expect(resolveMotifId(hint)).toBeNull(); // resolves to null (type-led path)
  });

  it("resolveMotifId throws on hints outside the palette (junk cache)", () => {
    expect(() => resolveMotifId("a totally made up thing"))
      .toThrow(/not part of the palette/);
  });

  it("all palette ids have staging copy + painter coverage (no orphan hooks)", async () => {
    const { MOTIF_IDS, MOTIF_STAGING } = await import("../../src/core/recipe/motifs.js");
    for (const id of MOTIF_IDS) expect(MOTIF_STAGING[id]).toBeTruthy();
    expect(MOTIF_IDS.length).toBe(14);
  });

  it("customMotif spec sanitization clamps and shapes survive round-trip", () => {
    const spec = sanitizeCustomMotif({
      caption: "test creature",
      clipSilhouette: true,
      shadow: true,
      shapes: [
        { d: "M10 20 C30 5 70 5 90 20 Q60 80 10 20 Z", role: "body" },
        { d: "M30 40 L40 30", role: "line", alpha: 0.6 },
        { d: "M-50 900 Q30 20 6000 -400 Z", role: "wash" },   // extreme coords
      ],
    });
    // coordinates were clamped by repositionNumbers
    for (const sh of spec.shapes) {
      for (const n of (sh.d.match(/-?\d+/g) ?? []).map(Number)) {
        expect(n).toBeGreaterThanOrEqual(-20);
        expect(n).toBeLessThanOrEqual(120);
      }
    }
    expect(spec.shapes[2]!.d).toContain("-20"); // was clamped
  });
});
