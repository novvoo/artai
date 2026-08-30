/**
 * artai public barrel.
 * Functional path (pure): realize(draft, opts) / compilePrompt / parseRecipe …
 * Convenience path (stateful): setIntentProvider → poster(theme)
 */
export * from "./core/index.js";
export {
  BrowserIntentProvider,
  PROVIDER_PRESETS,
  setDefaultProvider,
  getDefaultProvider,
  type BrowserModelConfig,
} from "./agent/index.js";
export { renderPoster, renderGraphPoster, paintGraphOntoCanvas, brushAvailable, registerAsset, getAsset, clearAssets, hasAsset } from "./render/index.js";
export { applyCustomMotif } from "./core/scene/custom.js";
export type { CustomMotifSpec } from "./core/scene/custom.js";
export type { RasterResult, RenderOptions } from "./render/index.js";
import { getDefaultProvider } from "./agent/index.js";
import type { ParseInput } from "./core/types/index.js";
import { realize, type Envelope, type RealizeOptions } from "./core/pipeline.js";

/**
 * Environment capability probe (§12) — safe to call in Node: every browser
 * check is guarded so importers never touch DOM at load time.
 */
export function capabilities(): {
  webgl2: boolean;
  offscreenCanvas: boolean;
  fontsReady: boolean;
} {
  const hasDom = typeof document !== "undefined";
  return {
    webgl2:
      typeof WebGL2RenderingContext !== "undefined" &&
      hasDom &&
      !!document.createElement("canvas").getContext("webgl2"),
    offscreenCanvas: typeof OffscreenCanvas !== "undefined",
    fontsReady: true,
  };
}

export type { IntentProvider } from "./core/types/index.js";

/**
 * One-shot: theme → envelope via the configured intent provider.
 * Falls back honestly: LLM failure downgrades to heuristic with provenance
 * recorded ("heuristic-fallback") rather than throwing into the caller.
 */
export async function poster(
  themeOrInput: string | ParseInput,
  opts: RealizeOptions & { allowFallback?: boolean } = { seed: 1 },
): Promise<Envelope> {
  const input: ParseInput =
    typeof themeOrInput === "string" ? { theme: themeOrInput } : themeOrInput;
  const provider = getDefaultProvider();
  if (!provider)
    throw Object.assign(
      new Error(
        "NoIntentProvider: configure one via setDefaultProvider(...) (browser BYOK or pi adapter)",
      ),
      { name: "NoIntentProviderError" },
    );
  opts.onStage?.("intent");
  try {
    const draft = await provider.parse(input);
    return realize(draft, opts);
  } catch (err) {
    // strict policy: surface model failures; never silently substitute tiers
    throw err;
  }
}
