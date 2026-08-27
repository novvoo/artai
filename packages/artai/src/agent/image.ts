/**
 * ImageGenClient — the third backend consumer of the four-paragraph prompt
 * (the zine skill's own production contract): text-to-image via OpenAI-
 * compatible /images/generations endpoints (OpenAI, OpenRouter mirrors, most
 * OpenAI-compatible proxies). Keys stay browser-local exactly like intent
 * config (§18.4).
 *
 * Notes:
 * - Anthropic ships no image endpoint; Settings gates this per preset.
 * - Returns a PNG data-url regardless of whether the upstream replied with
 *   b64_json or a hosted url.
 */
import type { Rng } from "../core/util/rand.js";

export interface ImageGenConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** e.g. "1024x1536" (portrait, matches poster ratio family) */
  size?: string;
}

export interface GeneratedImage {
  readonly dataUrl: string;
  readonly model: string;
  readonly revisedPrompt?: string | undefined;
}

export function enrichPromptForImageGen(basePrompt: string): string {
  // print-medium steering shared across models — keeps the zine identity even
  // on general-purpose generators; appended AFTER the four compiler paragraphs
  return [
    basePrompt,
    "Rendered as an authentic scanned risograph/zine print: visible paper fiber,",
    "slight misregistration between ink layers, matte absorbent stock, generous",
    "negative space preserved exactly as described, flat orthographic view.",
  ].join(" ");
}

export class ImageGenClient {
  constructor(private readonly cfg: ImageGenConfig) {}

  async generate(basePrompt: string, seedRng?: Rng): Promise<GeneratedImage> {
    const res = await fetch(`${this.cfg.baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.model,
        prompt: enrichPromptForImageGen(basePrompt),
        n: 1,
        size: this.cfg.size ?? "1024x1536",
        ...(seedRng ? {} : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "<no body>");
      throw Object.assign(new Error(`ProviderError ${res.status}: ${body.slice(0, 160)}`), {
        name: "ProviderError",
      });
    }
    const data = (await res.json()) as {
      data?: Array<{ b64_json?: string | null; url?: string | null; revised_prompt?: string }>;
      error?: { message?: string };
    };
    const item = data.data?.[0];
    if (!item || (!item.b64_json && !item.url)) {
      const msg = data.error?.message?.slice(0, 140) ?? "no image payload in reply";
      throw Object.assign(new Error(`ProviderContractViolation: ${msg}`), {
        name: "ProviderContractViolation",
      });
    }
    let dataUrl: string;
    if (item.b64_json) {
      dataUrl = `data:image/png;base64,${item.b64_json}`;
    } else {
      const imgRes = await fetch(item.url!);
      if (!imgRes.ok) {
        throw Object.assign(new Error(`ProviderError ${imgRes.status} fetching hosted image`), {
          name: "ProviderError",
        });
      }
      const buf = await imgRes.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000)
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      dataUrl = `data:image/png;base64,${btoa(bin)}`;
    }
    return { dataUrl, model: this.cfg.model, revisedPrompt: item.revised_prompt };
  }
}
