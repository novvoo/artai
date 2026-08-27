import { describe, expect, it } from "vitest";
import { MOTIF_IDS, MOTIF_STAGING, UnknownMotifError, resolveMotifId } from "../../src/core/recipe/motifs.js";

describe("motif palette (LLM-chosen)", () => {
  it("has fourteen dedicated artists, every one staged", () => {
    expect(MOTIF_IDS).toHaveLength(14);
    for (const id of MOTIF_IDS) expect(MOTIF_STAGING[id]).toBeTruthy();
  });

  it("resolves exact ids plus underscore variants, rejects everything else", () => {
    expect(resolveMotifId("envelope")).toBe("envelope");
    expect(resolveMotifId("rain_on_glass")).toBe("rain-on-glass");
    expect(() => resolveMotifId("a nice sunset")).toThrow(UnknownMotifError);
    expect(resolveMotifId(null)).toBeNull(); // type-led-only path
  });
});
