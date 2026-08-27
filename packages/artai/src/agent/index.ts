/**
 * agent barrel — providers only. The library never auto-configures one;
 * host apps call configureIntent() (root index.ts).
 */
export {
  BrowserIntentProvider,
  PROVIDER_PRESETS,
  ProviderError,
  ProviderContractViolation,
  coerce,
  extractJson,
  type BrowserModelConfig,
} from "./browser.js";
export {
  ImageGenClient,
  enrichPromptForImageGen,
  type GeneratedImage,
} from "./image.js";
import type { IntentProvider } from "../core/types/index.js";

let defaultProvider: IntentProvider | null = null;

/** Root-level mutable state lives OUTSIDE core; core stays pure. */
export function getDefaultProvider(): IntentProvider | null {
  return defaultProvider;
}
export function setDefaultProvider(p: IntentProvider | null): void {
  defaultProvider = p;
}
