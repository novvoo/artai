/**
 * BrowserIntentProvider — BYOK transport hosting three model capabilities:
 *   parse(theme)        → IntentDraft      (think-first contract)
 *   designMotif(...)    → CustomMotifSpec  (live motif generation)
 *   refinePrompt(text)  → enriched prompt
 * All calls escalate budgets/rungs against thinking-model token burn; empty
 * replies surface precise diagnostics instead of silent degradation.
 */
import {
  MOODS,
  IntentDraftSchema,
  type IntentDraft,
} from "../core/types/index.js";
import { type IntentProvider, type ParseInput } from "../core/types/index.js";
import type { CustomMotifSpec } from "../core/scene/custom.js";

export interface BrowserModelConfig {
  kind: "openai-compatible" | "anthropic";
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const PROVIDER_PRESETS = {
  openrouter: { kind: "openai-compatible" as const,
    baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4.5" },
  openai: { kind: "openai-compatible" as const,
    baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  anthropic: { kind: "anthropic" as const,
    baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5" },
};

const INTENT_SYSTEM = [
  "You convert a poster theme into a minimal-zine design intent. THINK first.",
  "STRICT JSON only \u2014 schema:",
  '{"mode":"generate"|"photo-input","thesis":string,"metaphor":{"subject":string,"relation":string},',
  ' "motifId":"envelope|postcard-stamp|rain-on-glass|window-ajar|door-light|cup-melt|branch-leaf|open-book|platform-rails|tide-mark|moth-cicada|stair-gap|bicycle",',
  ' "mood":"quiet|summer|solitude|childhood|seaside|afternoon|night|memory|surreal","shortText":string,"lang":"zh"|"en"}',
  "motifId MANDATORY \u2014 best match for theme core noun/action. subject = concrete object (never scene).",
  "shortText MANDATORY \u2014 2\u20136 char poetic caption in the theme language.",
].join("\n");

const DESIGN_SYSTEM_BASE = [
  "You design ONE custom motif. STRICT JSON only. Schema:",
  '{"caption":string,"shapes":[{"d":string,"role":"body"|"deep"|"wash"|"lift"|"line","alpha"?:number}],"clipSilhouette":boolean,"shadow":boolean}',
  "Closed SVG paths in 100x100 box. Palette roles resolve to:",
  "__PALETTE__",
  "Rules: animals \u2192 FIRST body path is ONE continuous closed silhouette (head-back-legs-tail), clipSilhouette=true;",
  "objects \u2192 layered plates, largest dominates; one/two body fills carry ink; deep=shadow, lift=lit belly, line=thin accents;",
  "ground near y=95 when shadow=true.",
].join("\n");

const REFINE_SYSTEM = [
  "You refine image-generation prompts for a minimal-zine poster engine.",
  "Preserve EVERY measurable clause verbatim: ratios, percentages, margins, hex colors, quoted phrases, avoid items.",
  "Enrich only sensory or lighting specifics serving the mood. Keep paragraph breaks; under 260 words.",
].join("\n");

export class ProviderError extends Error {
  constructor(msg: string, readonly status: number) { super(msg); this.name = "ProviderError"; }
}
export class ProviderContractViolation extends Error {
  constructor(message: string,
              readonly stage: "empty" | "no-json" | "invalid",
              readonly replyPreview: string) {
    super(message); this.name = "ProviderContractViolation";
  }
}

interface AttemptOpts {
  /** undefined ⇒ omit max_tokens entirely so the provider default applies */
  readonly maxTokens?: number | undefined;
  readonly useRF: boolean;
  readonly prefill: boolean;
  readonly system: string;
  /** abort signal — forwarded to fetch so 停止 kills the in-flight request */
  readonly signal?: AbortSignal;
  /** when provided, the request switches to SSE streaming and this callback
   * receives text deltas as they arrive (used by composeGraph for live preview) */
  readonly onDelta?: ((chunk: string) => void) | undefined;
  /** force SSE streaming even with no delta consumer — keeps bytes flowing
   * so gateways (GLM etc.) don't idle-timeout and reset long-generation
   * requests, which browsers report as an opaque "Failed to fetch" */
  readonly preferStream?: boolean | undefined;
}
interface RawReply {
  text: string;
  finish?: string | undefined;
  usageNote?: string | undefined;
}
const TOKEN_RUNGS_INTENT: ReadonlyArray<number> = [2048, 6048, 6048];
/** module-level memo of which anthropic base variant actually worked,
 * keyed by provider config — survives across BrowserIntentProvider instances */
const anthropicBaseCache = new Map<string, string>();
/** origins whose direct fetch previously died at network level (CORS etc.).
 * Exported for tests so fixtures can reset the memo between cases. */
export const directBlockedOrigins = new Set<string>();
export { parseGraphJsonl, stripFence } from "../core/scene/graph.js";
import { parseGraphJsonl, stripFence } from "../core/scene/graph.js";
/**
 * Design-budget policy (user directive): thinking models get UNBOUNDED
 * room — `tokens: null` means the max-tokens field is OMITTED entirely so
 * the provider applies its own generous default and hidden reasoning never
 * starves the visible answer. Unused budget isn't billed by major providers.
 * Anthropic's /messages requires an explicit number, so its rungs escalate.
 */
const DESIGN_BUDGETS: ReadonlyArray<{ tokens: number | null }> = [
  { tokens: 8192 },
  { tokens: null },
  { tokens: null },
];
const ANTHROPIC_DESIGN_MAX = [4096, 16000, 32000] as const;

export class BrowserIntentProvider implements IntentProvider {
  get id(): string { return `browser:${this.cfg.kind}`; }

  constructor(private readonly cfg: BrowserModelConfig) {}

  private anthropic(): boolean { return this.cfg.kind === "anthropic"; }

  /* ============================ transport ================================ */

  /**
   * fetch with network-layer diagnosis. Browsers surface offline / DNS /
   * CORS failures as an opaque TypeError("Failed to fetch") — name the
   * likely causes and the target URL instead of letting it bubble up raw.
   *
   * On such a failure (HTTP-level errors arrive as real responses and never
   * get here) the request is retried ONCE through the Studio dev server's
   * same-origin passthrough (/artai-proxy), which erases CORS problems like
   * gateways that answer `Access-Control-Allow-Origin: origin, *`. Absent
   * proxy support the retry fails fast and the decorated error surfaces.
   */
  private async guardedFetch(url: string, init: RequestInit): Promise<Response> {
    const decorate = (msg: string): Error => Object.assign(
      new Error(/abort/i.test(msg)
        ? "request aborted before completion"
        : `${msg} \u2014 network failure reaching ${url} (\u68c0\u67e5\u7f51\u7edc\u8fde\u63a5 / BASE URL / \u662f\u5426\u88ab\u6d4f\u89c8\u5668 CORS \u62e6\u622a)`),
      { name: "ProviderError" });

    // origins whose direct fetch already failed at network level (CORS etc.)
    // are remembered: later calls go straight through the local proxy so the
    // browser stops re-printing its CORS console noise on every request
    let origin = "";
    try { origin = new URL(url).origin; } catch { /* relative URL */ }
    if (origin && directBlockedOrigins.has(origin)) {
      try {
        return await fetch(`/artai-proxy?target=${encodeURIComponent(url)}`, init);
      } catch { /* proxy unavailable — fall back to one direct attempt */ }
      try { return await fetch(url, init); } catch { /* both dead */ }
      throw decorate("Failed to fetch");
    }

    try {
      return await fetch(url, init);
    } catch (e) {
      if (/^https?:\/\//i.test(url)) {
        if (origin) directBlockedOrigins.add(origin);
        try {
          return await fetch(`/artai-proxy?target=${encodeURIComponent(url)}`, init);
        } catch { /* no passthrough here — report the direct failure */ }
      }
      const msg = e instanceof Error ? e.message : String(e);
      // lead with the underlying cause: upstream error strings get sliced
      // to ~140 chars by the retry ladders, so it must survive truncation
      throw decorate(msg);
    }
  }

  /** Shared low-level call \u2014 both wire formats, one options shape. */
  private async raw(prompt: string, o: AttemptOpts): Promise<RawReply> {
    if (this.anthropic()) {
      // system MUST be a top-level field on /messages; some Anthropic-compatible
      // proxies (GLM / open.bigmodel.cn, etc.) return empty content if system
      // is concatenated into the user message \u2014 so always send it as a top
      // level string. Anthropic-native servers accept this exact shape too.
      const messages: Array<{ role: "user" | "assistant"; content: string }> =
        [{ role: "user", content: prompt }];
      if (o.prefill) messages.push({ role: "assistant", content: "{" });

      // Anthropic endpoints live under /v1 (native: api.anthropic.com/v1,
      // GLM: open.bigmodel.cn/api/anthropic/v1). Users paste base URLs both
      // with and without the prefix, so try theirs first, then /v1.
      const bare = this.cfg.baseUrl.replace(/\/+$/, "");
      // remember which base variant actually reached the endpoint so later
      // calls skip the wrong-path probe entirely (paste-without-/v1 users)
      const cacheKey = "anthropic|" + bare;
      const remembered = anthropicBaseCache.get(cacheKey);
      const bases = remembered
        ? [remembered]
        : [bare, ...(!/\/v\d+$/.test(bare) ? [bare + "/v1"] : [])];

      let lastBody = "";
      let netErr: string | null = null;
      for (let i = 0; i < bases.length; i++) {
        let res: Response;
        try {
          res = await this.guardedFetch(`${bases[i]}/messages`, {
            method: "POST",
            ...(o.signal ? { signal: o.signal } : {}),
            headers: {
              "content-type": "application/json",
              // pass BOTH x-api-key AND Authorization so Anthropic-native and
              // proxy gateways (which sometimes honor Bearer) both authenticate
              "x-api-key": this.cfg.apiKey,
              "authorization": `Bearer ${this.cfg.apiKey}`,
              "anthropic-version": "2023-06-01",
              "anthropic-dangerous-direct-browser-access": "true",
            },
            body: JSON.stringify({
              model: this.cfg.model,
              // anthropic requires an explicit positive integer; fall back to a
              // safe default so requests never silently cap at 0 tokens.
              max_tokens: o.maxTokens !== undefined && o.maxTokens > 0 ? o.maxTokens : 4096,
              system: o.system,
              messages,
              ...((o.onDelta || o.preferStream) ? { stream: true } : {}),
            }),
          });
        } catch (e) {
          // network-level failure (offline / DNS / CORS) — remember it and
          // still try the next base variant instead of abandoning raw()
          netErr = (e as Error).message;
          continue;
        }
        if (!res.ok)
          throw Object.assign(
            new ProviderError(`${res.status} ${await txt(res)}`, res.status),
            { name: "ProviderError" });

        // streaming path: consume content_block_delta SSE events, accumulate
        // the full text and surface deltas live. If the proxy ignored
        // stream:true it answers with plain JSON — fall through to that.
        if ((o.onDelta || o.preferStream) && (res.headers.get("content-type") ?? "").includes("event-stream")) {
          const s = await this.consumeAnthropicSSE(res, o);
          if (s.text.trim() || s.finish)
            return { ...s,
              text: o.prefill && !s.text.trimStart().startsWith("{")
                ? `{${stripFence(s.text)}`
                : stripFence(s.text) };
          continue; // streamed but empty — try next base variant
        }

        const d = (await res.json()) as {
          content?: Array<{ text?: string }>;
          stop_reason?: string | null;
          usage?: { output_tokens?: number } | null;
          // GLM and some Anthropic-compatible proxies return an error envelope
          // with HTTP 200 \u2014 surface it instead of reporting empty content.
          type?: string;
          error?: { message?: string; type?: string | number };
          // gateway-style envelopes: {code, msg, success:false}
          code?: number | string;
          msg?: string;
          success?: boolean;
        };
        lastBody = JSON.stringify(d);

        // classify the response before deciding what to do with it:
        //  • real endpoint speaking the messages API → has content/stop_reason/usage
        //  • proxy error envelope (HTTP 200)         → {type:"error"} or {error:{}}
        //  • wrong-path gateway page                 → {code,msg,success:false} etc.
        const proxyError =
          d.type === "error" || Boolean(d.error?.message);
        const gatewayReject = d.success === false && Boolean(d.msg);
        const reachedEndpoint =
          Boolean(d.content || d.stop_reason || d.usage);

        if (proxyError) {
          const m = String(d.error?.message ?? "proxy returned error envelope");
          throw Object.assign(
            new ProviderError(`upstream: ${m.slice(0, 200)}`, 200),
            { name: "ProviderError" });
        }

        const looksWrongPath = gatewayReject ||
          (!reachedEndpoint && !proxyError);
        if (looksWrongPath && i < bases.length - 1)
          continue; // retry against the /v1 variant before giving up

        if (gatewayReject)
          throw Object.assign(
            new ProviderError(`upstream: ${String(d.msg).slice(0, 200)}`, 200),
            { name: "ProviderError" });

        const t = d.content?.map((b) => b.text ?? "").join("") ?? "";
        // this base variant works — remember it for later calls
        anthropicBaseCache.set(cacheKey, bases[i]!);
        // the assistant prefill assumes the model continues straight into
        // JSON, but some proxies/models open with their own ```json fence —
        // strip any fence BEFORE deciding whether "{" still needs prepending
        const cleaned = stripFence(t).trim();
        return {
          text: o.prefill && !cleaned.startsWith("{") ? `{${cleaned}` : cleaned,
          finish: d.stop_reason ?? undefined,
          // when nothing usable came back, embed a body preview so the
          // failure is diagnosable instead of an opaque "empty"
          usageNote: cleaned || reachedEndpoint
            ? (d.usage ? `output_tokens=${d.usage.output_tokens ?? "?"}` : undefined)
            : `unrecognized body: ${lastBody.slice(0, 140)}`,
        };
      }
      if (netErr)
        throw Object.assign(
          new Error(`all endpoint variants unreachable (${netErr})`),
          { name: "ProviderError" });
      throw Object.assign(new Error("anthropic transport exhausted"), { name: "ProviderError" });
    }
    const res = await this.guardedFetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: "POST",
      ...(o.signal ? { signal: o.signal } : {}),
      headers: { "content-type": "application/json",
                 authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({
        model: this.cfg.model,
        // budget === undefined ⇒ omit the field entirely (provider default)
        ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}),
        ...(o.useRF ? { response_format: { type: "json_object" } } : {}),
        ...((o.onDelta || o.preferStream) ? { stream: true } : {}),
        messages: [{ role: "system", content: o.system }, { role: "user", content: prompt }],
      }),
    });
    if (!res.ok)
      throw Object.assign(new ProviderError(`${res.status} ${await txt(res)}`, res.status),
                          { name: "ProviderError" });

    // streaming path (see anthropic branch); proxies that ignore stream:true
    // answer with plain JSON and fall through to the standard parser below
    if ((o.onDelta || o.preferStream) && (res.headers.get("content-type") ?? "").includes("event-stream")) {
      return await this.consumeOpenAISSE(res, o);
    }

    const d = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string | null; reasoning?: string | null };
        finish_reason?: string | null }>;
      usage?: { completion_tokens?: number } | null;
      error?: { message?: string };
    };
    if (d.error?.message)
      throw Object.assign(new ProviderError(`upstream: ${d.error.message.slice(0, 160)}`, 200),
                          { name: "ProviderError" });
    const c0 = d.choices?.[0];
    const text = c0?.message?.content || c0?.message?.reasoning || "";
    // fool-proofing: an Anthropic gateway URL driven through the OpenAI wire
    // always 404s at the gateway level — name the mismatch explicitly
    const urlLooksAnthropic = /\/anthropic(\/|$)/.test(this.cfg.baseUrl.toLowerCase());
    return { text,
             finish: c0?.finish_reason ?? undefined,
             usageNote: text
               ? (d.usage ? `completion_tokens=${d.usage.completion_tokens ?? "?"}` : undefined)
               : urlLooksAnthropic
                 ? "wire mismatch: BASE URL is an Anthropic gateway but the preset uses /chat/completions — set WIRE FORMAT (or preset) to anthropic"
                 : `unrecognized body: ${JSON.stringify(d).slice(0, 140)}` };
  }

  /** Anthropic /messages SSE: message content arrives as content_block_delta. */
  private async consumeAnthropicSSE(
    res: Response, o: AttemptOpts,
  ): Promise<RawReply> {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "", acc = "", finish: string | undefined;
    for (;;) {
      if (o.signal?.aborted) throw new DOMException("stopped by user", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const ev = JSON.parse(payload) as {
            type?: string;
            delta?: { type?: string; text?: string; stop_reason?: string };
            error?: { message?: string };
          };
          if (ev.error?.message)
            throw Object.assign(
              new ProviderError(`upstream: ${ev.error.message.slice(0, 200)}`, 200),
              { name: "ProviderError" });
          if (ev.type === "content_block_delta" && ev.delta?.text) {
            acc += ev.delta.text;
            o.onDelta?.(ev.delta.text);
          }
          if (ev.type === "message_delta" && ev.delta?.stop_reason)
            finish = ev.delta.stop_reason;
        } catch (e) {
          if ((e as Error)?.name === "ProviderError") throw e;
          // malformed SSE line — tolerate, next data frame carries on
        }
      }
    }
    return { text: acc, finish, usageNote: acc ? undefined : "stream produced no content" };
  }

  /** OpenAI chat/completions SSE: deltas arrive at choices[0].delta.content. */
  private async consumeOpenAISSE(
    res: Response, o: AttemptOpts,
  ): Promise<RawReply> {
    const abortCheck = (): void => {
      if (o.signal?.aborted) throw new DOMException("stopped by user", "AbortError");
    };
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "", content = "", reasoning = "";
    let finish: string | undefined;
    for (;;) {
      abortCheck();
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const ev = JSON.parse(payload) as {
            choices?: Array<{
              delta?: { content?: string | null; reasoning_content?: string | null };
              finish_reason?: string | null }>;
            error?: { message?: string };
          };
          if (ev.error?.message)
            throw Object.assign(
              new ProviderError(`upstream: ${ev.error.message.slice(0, 200)}`, 200),
              { name: "ProviderError" });
          const d0 = ev.choices?.[0]?.delta;
          const piece = d0?.content ?? "";
          if (piece) {
            content += piece;
            o.onDelta?.(piece);
          }
          if (d0?.reasoning_content) reasoning += d0.reasoning_content;
          if (ev.choices?.[0]?.finish_reason) finish = ev.choices[0]!.finish_reason!;
        } catch (e) {
          if ((e as Error)?.name === "ProviderError") throw e;
        }
      }
    }
    return { text: content || reasoning, finish, usageNote: content ? undefined : "stream produced no content" };
  }

  /* ============================ parse ==================================== */

  async parse(input: ParseInput): Promise<IntentDraft> {
    let lastErr = "", lastPrev = "";
    let lastStage: "empty" | "no-json" | "invalid" = "invalid";
    const user = userFor(input);

    for (let rung = 0; rung < TOKEN_RUNGS_INTENT.length; rung++) {
      if (input.signal?.aborted)
        throw new DOMException("stopped by user", "AbortError");
      const maxTokens = TOKEN_RUNGS_INTENT[rung]!;
      let rr: RawReply;
      try {
        rr = await this.raw(user + retryHint(lastErr), {
          system: INTENT_SYSTEM, maxTokens,
          useRF: !this.anthropic(), prefill: this.anthropic(),
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (e) {
        if (input.signal?.aborted)
          throw new DOMException("stopped by user", "AbortError");
        lastErr = String((e as Error).message ?? e).slice(0, 140);
        // the next rung burns real budget, so give a hiccuping endpoint
        // (rate limit, dropped connection) a beat before escalating
        await new Promise(r => setTimeout(r, 600 * (rung + 1)));
        continue;
      }
      if (!rr.text.trim()) {
        lastStage = "empty";
        lastErr = `empty (${explain(rr)})`; lastPrev = "<empty>";
        continue;
      }
      lastPrev = rr.text.replace(/\s+/g, " ").slice(0, 140);
      try {
        return IntentDraftSchema.parse(coerce(JSON.parse(extractJson(rr.text))));
      } catch (err) {
        lastErr = err instanceof Error ? err.message.slice(0, 120) : String(err);
        lastStage = /no JSON/.test(lastErr) ? "no-json" : "invalid";
        // a no-json reply with a body preview means the transport never saw
        // real content — surface what the wire actually carried
        if (/no JSON/.test(lastErr) && rr.usageNote)
          lastErr += ` (${rr.usageNote.slice(0, 160)})`;
      }
    }
    throw Object.assign(
      new ProviderContractViolation(
        `${lastStage}: ${lastErr} | reply: ${lastPrev}`, lastStage, lastPrev),
      { name: "ProviderContractViolation" });
  }

  /* ============================ designMotif ============================== */

  async designMotif(input: {
    theme: string; subject: string; relation: string; mood: string;
    palette: { body: string; deep: string; wash: string; lift: string; line: string };
    paperHex: string; species?: string | undefined;
    fullSpec?: string | undefined;
  }): Promise<CustomMotifSpec> {
    const { DEMO_ENVELOPE, DEMO_FISH, sanitizeCustomMotif } =
      await import("../core/scene/custom.js");
    const demos = JSON.stringify({ envelope: DEMO_ENVELOPE, fish: DEMO_FISH });

    // craft rules enrich the system prompt
    const craft = [
      "\u2022 ANIMALS: FIRST body path = ONE continuous closed silhouette (head\u2192back\u2192haunch\u2192tail); later plates interior; clipSilhouette=true.",
      "\u2022 OBJECTS: layered cut-paper plates; largest body dominates.",
      "\u2022 'body' fills carry saturated ink; 'deep'=shadow; 'lift'=lit belly; 'line'=crisp accents.",
      "\u2022 Add 2\u20134 background masses or atmospheric strokes for depth.",
      "\u2022 Use companion hue for ambient elements behind body.",
    ].join("\n");

    // full-spec gives the model the COMPLETE creative brief when available
    const briefBlock = input.fullSpec
      ? `\n\n== FULL CREATIVE BRIEF (from the prompt compiler) ==\n${input.fullSpec}\n\nUse this as your primary source of inspiration. Match its palette, mood and edge character in every shape.`
      : "";

    const system = DESIGN_SYSTEM_BASE.replace("__PALETTE__", JSON.stringify(input.palette)) +
      `\n${craft}\nTwo demo specs teach format+density:\n${demos}`;
    const user =
      `Theme: ${input.theme}\nSubject: ${input.subject}\nRelation: ${input.relation}` +
      `\nMood: ${input.mood}${input.species ? `\nSpecies hints: ${input.species}` : ""}` +
      (input.fullSpec ? `\n\nDetailed design brief:\n${input.fullSpec}` : "");

    let lastErr = "", preview = "";
    for (let rung = 0; rung < DESIGN_BUDGETS.length; rung++) {
      let rr: RawReply;
      try {
        const budget = DESIGN_BUDGETS[rung]!.tokens;
        // Anthropic /messages mandates max_tokens; OpenAI-compatible omits it
        // when null so hidden reasoning has the provider's full headroom.
        const effMax =
          this.anthropic()
            ? ANTHROPIC_DESIGN_MAX[rung]!
            : budget ?? undefined;
        rr = await this.raw(user, {
          system, maxTokens: effMax ?? 0,
          useRF: !this.anthropic(),
          prefill: false,
        });
      } catch (e) {
        lastErr = String((e as Error).message ?? e).slice(0, 140);
        // the next rung burns real budget, so give a hiccuping endpoint
        // (rate limit, dropped connection) a beat before escalating
        await new Promise(r => setTimeout(r, 600 * (rung + 1)));
        continue;
      }
      if (!rr.text.trim()) {
        lastErr = `empty (${explain(rr)})`;
        preview = `<empty> ${rr.usageNote ?? ""} finish=${rr.finish ?? "?"}`;
        continue;
      }
      preview = rr.text.replace(/\s+/g, " ").slice(0, 140);
      try {
        const obj = JSON.parse(extractJson(rr.text)) as Record<string, unknown>;
        const payload = Array.isArray(obj.shapes) ? obj : ((obj.motif as unknown) ?? obj);
        return sanitizeCustomMotif(payload);
      } catch (err) {
        lastErr = err instanceof Error ? err.message.slice(0, 120) : String(err);
      }
    }
    const advice = /token ceiling|length/i.test(lastErr)
      ? " 建议：在模型设置中换用非思考型号号（如 gpt-4.1-mini、claude-sonnet-4-5 本体），或暂时关闭“实时生成母题”。"
      : "";
    throw Object.assign(
      new Error(`motif design failed after escalation: ${lastErr} | reply: ${preview}.${advice}`),
      { name: "MotifSpecError" });
  }

  /**
   * RAW CODE GENERATION — the LLM authors an enriched, artistic Canvas-2D
   * rendering script based on the full-spec prompt + IR op list. It goes
   * beyond the mechanical translation done by irToScript: adding organic
   * texture passes, shading gradients, atmospheric layers, and expressive
   * stroke work that the deterministic compiler can't author on its own.
   */
  async generateRawCode(input: {
    /** 30+ section full-spec prompt describing every layer */
    fullSpec: string;
    /** compact four-paragraph prompt */
    fourPara: string;
    /** serialized IR ops (mechanical baseline) */
    irJson: string;
    canvasWidth: number;
    canvasHeight: number;
    palette: { body: string; deep: string; wash: string; lift: string; line: string; hue2: string };
  }): Promise<string> {
    const sys = [
      "You are an expert creative coder who translates design descriptions into beautiful Canvas-2D JavaScript.",
      "You will receive: (1) a detailed creative brief describing every visual element of a minimal-zine poster,",
      "(2) a mechanical IR-to-drawing-code baseline that already produces basic shapes and fills.",
      "",
      "Your job: WRITE AN ENHANCED VERSION of this code that adds the richness described in the brief but",
      "missing from the baseline — organic strokes, layered washes, grain textures, atmospheric gradients,",
      "expressive marks. Keep the same coordinate system and canvas dimensions.",
      "",
      "Rules:",
      "- Output ONLY a JavaScript IIFE body (no wrapper), targeting variable `ctx` with canvas ${W}x${H}.",
      "- Use ctx.fillRect, ctx.arc, ctx.beginPath, createLinearGradient, globalAlpha, composite ops.",
      "- NEVER use fillText or drawImage — text is added separately by the overlay system.",
      "- Include paper texture pass, backdrop masses, focal silhouette region, orbital details.",
      "- Total output: one function body, under 200 lines.",
    ].join("\n");

    const user = [
      "=== CREATIVE BRIEF ===",
      input.fullSpec,
      "",
      `=== CANVAS === ${input.canvasWidth}x${input.canvasHeight}`,
      `=== PALETTE === body=${input.palette.body} deep=${input.palette.deep} wash=${input.palette.wash} lift=${input.palette.lift} line=${input.palette.line} hue2=${input.palette.hue2}`,
      "",
      "=== MECHANICAL BASELINE (IR ops) ===",
      input.irJson.slice(0, 3000),
      "",
      "Now write the ENHANCED Canvas-2D rendering code. Output only JavaScript between ```js markers.",
    ].join('\n');

    const rr = await this.raw(user, {
      system: sys,
      maxTokens: 4096,
      useRF: !this.anthropic(),
      prefill: false,
    });
    const raw = rr.text.trim();
    if (!raw)
      throw Object.assign(
        new Error(`empty reply from model (${explain(rr)})`),
        { name: "ProviderContractViolation" });

    // extract JS code from fences or bare output
    const jsMatch = raw.match(/```(?:js|javascript)?\n?([\s\S]*?)```/);
    return jsMatch ? jsMatch[1]!.trim() : raw.trim();
  }

  private anthropicFn(): boolean {
    void 0; return false; // overridden at instance level by kind check
  }

  /**
   * VISUAL COMPOSITION GRAPH — the model reads the full-spec creative brief
   * and authors a rich, layered scene graph (15+ visual layers) that a
   * deterministic renderer can draw. This is the "think like an illustrator"
   * step: decide every blob, stroke, gradient and atmospheric effect BEFORE
   * writing any code.
   */
  async composeGraph(input: {
    /** 30+ section full-spec prompt \u2014 the complete creative brief */
    fullSpec: string;
    paletteHexes: string[];
    theme: string;
    /** optional streaming callback — deltas of the graph JSON as they arrive */
    onDelta?: (chunk: string) => void;
    /** optional live progress callback — fires per pipeline step so the
     * studio can show 构图初稿 / 打磨 round N as they happen */
    onStatus?: (label: string) => void;
    /** abort signal — aborted fetches die mid-flight and the loop unwinds */
    signal?: AbortSignal;
    /** seed the FIRST attempt as a revision of an existing graph (the
     * studio's 继续打磨 button): complaints empty ⇒ a generic elevation
     * brief is used instead */
    previousGraph?: { graphJson: string; complaints?: string[] };
    /** the user's own polish suggestion — injected into the patch prompt
     * as high-priority guidance (e.g. "把主体移到左下，加一只猫") */
    userNote?: string;
  }): Promise<import("../core/scene/graph.js").CompositionGraph> {
    const { GRAPH_SYSTEM_PROMPT, GRAPH_JSONL_SYSTEM_PROMPT,
            buildGraphUserPrompt, buildGraphJsonlUserPrompt, critiqueGraph } =
      await import("../core/scene/graph.js");

    let lastErr = "", preview = "", diag = "";
    // Format ladder: (0) single-object JSON at a moderate budget; (1) same
    // shape with an escalated budget — on the OpenAI wire an undefined
    // budget OMITS max_tokens so the provider's own headroom applies, while
    // Anthropic-native /messages requires a number (32000); (2) JSONL mode —
    // one layer per line, each line parses independently so a token-ceiling
    // cut costs only its tail instead of corrupting the whole object.
    // Attempts past the ladder are QUALITY REVISIONS (see below), reusing
    // the JSONL format for compactness.
    const objectUser = buildGraphUserPrompt(input.fullSpec, input.paletteHexes);
    const RUNGS: ReadonlyArray<{
      jsonl?: boolean; budget?: number; system: string; user: string;
    }> = [
      // 16384 comfortably fits a dense 10–13 layer graph (the JSON runs
      // 4–9k tokens); unused budget is never billed, so the only thing a
      // generous cap changes is fewer pointless truncation retries
      { system: GRAPH_SYSTEM_PROMPT, user: objectUser, budget: 16384 },
      { system: GRAPH_SYSTEM_PROMPT, user: objectUser,
        ...(this.anthropic() ? { budget: 32000 as const } : {}) },
      { jsonl: true, system: GRAPH_JSONL_SYSTEM_PROMPT,
        user: buildGraphJsonlUserPrompt(input.fullSpec, input.paletteHexes),
        ...(this.anthropic() ? { budget: 32000 as const } : {}) },
    ];
    const MAX_ATTEMPTS = 5; // 3 format rungs + up to 2 art-direction revisions
    let truncatedLastRun = false;
    // When a graph parses but the art director complains, the next attempt
    // is a REVISION seeded with the previous graph + the concrete complaints
    // — the model edits what it wrote instead of rolling dice on a fresh try.
    let revision: { graphJson: string; complaints: string } | null = null;
    let revisionRound = 0;
    if (input.previousGraph) {
      const listed = input.previousGraph.complaints?.join("; ") ?? "";
      revision = {
        graphJson: input.previousGraph.graphJson,
        complaints: listed || (
          "composition passes structural checks \u2014 ELEVATE it: refine the focal " +
          "object's interior detail (2\u20133 more structure strokes / shading blobs), " +
          "strengthen the value hierarchy (deepen darks or add a lift highlight), " +
          "add one subtle atmospheric layer, tighten accent scatter. Keep the " +
          "overall composition and palette"),
      };
    }
    // best-effort tracking: if revisions never satisfy the director, the
    // version with the fewest complaints still beats the RAW baseline
    let best: {
      graph: import("../core/scene/graph.js").CompositionGraph;
      complaints: number;
    } | null = null;

    for (let rung = 0; rung < MAX_ATTEMPTS; rung++) {
      if (input.signal?.aborted)
        throw new DOMException("stopped by user", "AbortError");
      // revision attempts ALWAYS use the JSONL rung in PATCH mode: the model
      // re-emits only the layers it changes (~1k tokens) instead of the whole
      // graph (~6k+) — a full regen per polish round was why revisions were
      // barely faster than the first draft
      const r = revision ? RUNGS[RUNGS.length - 1]! : RUNGS[Math.min(rung, RUNGS.length - 1)]!;
      let attemptUser = r.user;
      if (revision) {
        attemptUser = r.user +
          "\n\nYou are PATCHING your previous composition for this same brief." +
          "\nDo NOT assume the previous graph is correct \u2014 AUDIT it before revising:" +
          "\n\u2022 depth = paint order: paper base must be depth 0; the focal subject above ALL content layers; grain/vignette topmost" +
          "\n\u2022 every layer carries 3\u20135 shapes (focal 6\u201310); shading masses opposite lightDeg" +
          "\n\n=== PREVIOUS GRAPH ===\n" + revision.graphJson +
          "\n\n=== ART-DIRECTOR COMPLAINTS (fix every one; it verified the graph, not blessed it) ===" +
          revision.complaints.split("; ").map((c) => `\n\u2022 ${c}`).join("") +
          (input.userNote?.trim()
            ? `\n\n=== USER GUIDANCE (the user's explicit request \u2014 honor it as top priority, unless it violates the layer-order/density rules above) ===\n\u2022 ${input.userNote.trim()}`
            : "") +
          "\n\n=== PATCH FORMAT (CRITICAL \u2014 keeps the revision fast) ===" +
          (revision.complaints.includes("ELEVATE")
            ? "\n\u2022 ELEVATE brief: improve the composition with targeted patches \u2014 keep the overall composition and palette"
            : "\n\u2022 Output ONLY the layers you change or add \u2014 one complete layer object per line") +
          "\n\u2022 modify a layer \u2192 its COMPLETE replacement object with the SAME id" +
          "\n\u2022 add a layer \u2192 a new object with a NEW id" +
          "\n\u2022 delete a layer \u2192 {\"remove\":\"layerId\"}" +
          "\n\u2022 optionally first line {\"lightDeg\":N} to change the lighting angle" +
          "\n\u2022 DO NOT repeat unchanged layers; DO NOT re-output the whole graph" +
          (truncatedLastRun
            ? "\nStay terse: at most 10 layers, at most 4 shapes per layer, labels under 30 characters."
            : "");
      } else if (rung > 0) {
        attemptUser += `\n\nPrevious reply failed: ${lastErr}. Reply again with corrected output only.` +
          (truncatedLastRun && !r.jsonl
            ? " Your previous reply hit the OUTPUT TOKEN LIMIT and was cut off mid-JSON \u2014 stay terse: at most 10 layers, at most 4 shapes per layer (focal silhouette contour may have up to 12 points), labels under 30 characters."
            : "");
      }
      input.onStatus?.(revision
        ? `打磨构图 第${++revisionRound}轮（针对 ${revision.complaints.split("; ").length} 项批评）…`
        : rung === 0 ? "构图初稿…"
        : `构图重试（${/length|max.?token/i.test(lastErr)
            ? "输出截断，升级预算"
            : /network failure|unreachable|Failed to fetch/i.test(lastErr)
              ? "传输失败，改走备用通道"
              : /art direction/i.test(lastErr)
                ? "艺术总监批评"
                : "回复解析失败"}）…`);
      let rr: RawReply;
      try {
        rr = await this.raw(attemptUser, {
          system: r.system,
          maxTokens: r.budget,
          ...(input.signal ? { signal: input.signal } : {}),
          // response_format/assistant-prefill both force ONE top-level JSON
          // value — they must be OFF in JSONL mode or the format collapses
          useRF: !this.anthropic() && !r.jsonl,
          prefill: this.anthropic() && !r.jsonl,
          // the graph request is the largest and longest in the pipeline —
          // stream it so gateways don't idle-timeout and reset the connection
          // mid-generation (browsers surface that as "Failed to fetch")
          preferStream: true,
          ...(input.onDelta ? { onDelta: input.onDelta } : {}),
        });
      } catch (e) {
        if (input.signal?.aborted)
          throw new DOMException("stopped by user", "AbortError");
        lastErr = String((e as Error).message ?? e).slice(0, 140);
        // the next attempt burns real budget, so give a hiccuping endpoint
        // (rate limit, dropped connection) a beat before escalating
        await new Promise(r => setTimeout(r, 600 * (rung + 1)));
        continue;
      }
      if (!rr.text.trim()) {
        lastErr = `empty reply (${explain(rr)})`;
        diag = `finish=${rr.finish ?? "?"}${rr.usageNote ? ` ${rr.usageNote}` : ""}`;
        preview = `<empty> ${diag}`;
        continue;
      }
      if (input.signal?.aborted)
        throw new DOMException("stopped by user", "AbortError");
      truncatedLastRun = /length|max.?token/i.test(rr.finish ?? "");
      diag = `finish=${rr.finish ?? "?"}${rr.usageNote ? ` ${rr.usageNote}` : ""}`;
      preview = rr.text.replace(/\s+/g," ").slice(0,140);

      try {
        // Single-object rungs: bracket-balanced, string-aware extraction —
        // tolerates fences, leading prose and trailing commentary. A reply
        // cut off by the token ceiling mid-object is salvaged from its last
        // structurally-complete prefix instead of being discarded.
        // The JSONL rung parses per line instead — no bracket surgery needed.
        let lenient = false;
        let parsed: {
          lightDeg?: number | undefined;
          layers?: Array<Record<string, unknown>>;
        };
        if (r.jsonl) {
          const out = parseGraphJsonl(rr.text);
          if (revision) {
            // PATCH mode: merge the changed/add/remove lines back into the
            // previous graph locally — untouched layers are never re-emitted
            const prev = JSON.parse(revision.graphJson) as {
              lightDeg?: number; layers?: Array<Record<string, unknown>>;
            };
            const removed = new Set(out.removes);
            const merged = (prev.layers ?? [])
              .filter((l) => !removed.has(l.id as string));
            for (const nl of out.layers) {
              const idx = merged.findIndex((l) => l.id === nl.id);
              if (idx >= 0) merged[idx] = nl;
              else merged.push(nl);
            }
            parsed = { lightDeg: out.lightDeg ?? prev.lightDeg, layers: merged };
            input.onStatus?.(`补丁合并：改 ${out.layers.length} 层 / 删 ${out.removes.length} 层 / 共 ${merged.length} 层`);
          } else {
            parsed = { lightDeg: out.lightDeg, layers: out.layers };
          }
          if (!parsed.layers?.length)
            throw new Error(out.badLines
              ? `${out.badLines} unparseable JSON lines (${diag})`
              : "no JSON lines found in reply");
          lenient = truncatedLastRun || out.badLines > 0;
        } else {
          let salvaged = false;
          let jsonText: string;
          try { jsonText = extractJson(rr.text); }
          catch {
            const repaired = truncatedLastRun ? repairTruncatedJson(rr.text) : null;
            if (!repaired)
              throw new Error(truncatedLastRun
                ? `reply hit the token ceiling before any complete element (${diag})`
                : "no JSON object found in reply");
            jsonText = repaired;
            salvaged = true;
          }
          parsed = JSON.parse(jsonText);
          if (salvaged && Array.isArray(parsed.layers)) lenient = true;
        }
        if (lenient && Array.isArray(parsed.layers)) {
          // drop half-specified survivors, default their depth, and add the
          // print finishers back deterministically when truncation ate them
          parsed.layers = parsed.layers
            .filter((l: any) => Array.isArray(l?.shapes) && l.shapes.length > 0)
            .map((l: any) => ({ ...l, depth: typeof l.depth === "number" ? l.depth : 5 }));
          appendFinishers(parsed.layers);
        }
        // full graphs need >=8 layers to be rich enough; a salvaged or
        // partially-received one is still worth rendering rather than
        // falling all the way back to the RAW baseline
        const minLayers = lenient ? 6 : 8;
        if (!Array.isArray(parsed.layers) || parsed.layers.length < minLayers)
          throw new Error(`graph has ${parsed.layers?.length ?? 0} layers \u2014 fewer than ${minLayers}`);
        const graph = { lightDeg: parsed.lightDeg ?? 145,
                        layers: parsed.layers as import("../core/scene/graph.js").CompositionGraph["layers"],
                        paletteLocked: input.paletteHexes };
        // art-director gate: deterministic critique of the composition.
        // Complaints seed the next attempt's revision; if the attempt budget
        // runs out, the fewest-complaints version wins — a flawed graph is
        // still better than the RAW baseline fallback.
        const complaints = critiqueGraph(graph);
        if (!complaints.length) return graph;
        if (!best || complaints.length < best.complaints)
          best = { graph, complaints: complaints.length };
        if (rung < MAX_ATTEMPTS - 1)
          revision = {
            graphJson: JSON.stringify({ lightDeg: graph.lightDeg, layers: parsed.layers }),
            complaints: complaints.join("; "),
          };
      } catch (e) {
        lastErr = e instanceof Error ? e.message.slice(0,120) : String(e);
      }
    }
    if (best) return best.graph;
    throw Object.assign(
      new Error(`composition graph failed after retry: ${lastErr}${diag ? ` [${diag}]` : ""} | reply: ${preview}`),
      { name: "MotifSpecError" });
  }

  /* ============================ refinePrompt ============================= */

  /**
   * Liveness probe — one tiny round-trip with no schema parsing, no
   * escalation ladder and no assistant prefill. Studio's "test connection"
   * uses this instead of a full intent parse so the check takes seconds.
   */
  async ping(): Promise<{ ok: true; note: string }> {
    const rr = await this.raw('Reply with exactly {"ok":true} and nothing else.', {
      system: "You are a health-check endpoint. Output strictly compact JSON.",
      maxTokens: 4096, // generous ceiling: thinking models burn hidden tokens
      useRF: false,
      prefill: false,
    });
    if (!rr.text.trim())
      throw Object.assign(new Error(`empty reply (${explain(rr)})`),
        { name: "ProviderContractViolation" });
    return { ok: true, note: rr.usageNote ?? rr.finish ?? "stop" };
  }

  async refinePrompt(compiledPrompt: string): Promise<string> {
    const r = await this.raw(compiledPrompt, {
      system: REFINE_SYSTEM, maxTokens: 900,
      useRF: false, prefill: false,
    });
    return r.text.trim() || compiledPrompt;
  }
}

function retryHint(lastErr: string): string {  return lastErr
    ? `\n\nPrevious reply failed: ${lastErr}. Reply again with corrected STRICT JSON.`
    : "";
}
function userFor(input: ParseInput): string {
  return `Theme: ${input.theme}` +
    (input.hasPhoto ? "\n(A photograph will be supplied as an edit target.)" : "");
}
function explain(r: RawReply): string {
  if (/length|max.?token/i.test(r.finish ?? "")) return "token ceiling hit while thinking";
  return `finish=${r.finish ?? "?"}${r.usageNote ? " " + r.usageNote : ""}`;
}

/* --------------- tolerant mapping + extraction --------------- */

export function coerce(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) throw new Error("reply is not an object");
  const o = raw as Record<string, unknown>;
  const meta = (o.metaphor ?? {}) as Record<string, unknown>;
  const moodRaw = typeof o.mood === "string" ? o.mood.toLowerCase().trim() : "";
  const mood = (MOODS as readonly string[]).includes(moodRaw) ? moodRaw : softMood(moodRaw);
  return {
    mode: typeof o.mode === "string" && /photo/i.test(o.mode) ? "photo-input" : "generate",
    thesis: typeof o.thesis === "string" && o.thesis.trim()
      ? o.thesis.trim().slice(0, 120) : "untitled",
    metaphor: {
      subject: typeof meta.subject === "string" ? meta.subject.trim() : "",
      relation: typeof meta.relation === "string" ? meta.relation.trim() : "",
    },
    mood,
    motifHint: typeof o.motifId === "string" ? o.motifId.trim().toLowerCase() : undefined,
    shortText: typeof o.shortText === "string" && o.shortText.trim() ? o.shortText.trim() : null,
    lang: typeof o.lang === "string" && o.lang.startsWith("en") ? "en" : "zh",
  };
}
function softMood(raw: string): string {
  if (/melanchol|somber|lonely|\u84dd|\u90c1/.test(raw)) return "solitude";
  if (/warm|nostalg|\u6000|\u6696/.test(raw)) return "memory";
  return "quiet";
}
export function extractJson(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("no JSON object found in reply");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("no JSON object found in reply");
}

/**
 * Salvage a reply that the token ceiling cut off mid-JSON: rewind to the
 * latest position where a member ended cleanly (a closing bracket or a
 * separating comma outside strings), snapshot the open-bracket stack there,
 * then close every bracket still open. Returns null when nothing usable
 * survives (cut before the first element completed).
 */
export function repairTruncatedJson(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  const stack: string[] = [];
  let inStr = false, esc = false;
  let safeEnd = -1, openAtSafe: string[] = [];
  const mark = (i: number) => { safeEnd = i; openAtSafe = stack.slice(); };
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{" || ch === "[") { stack.push(ch); continue; }
    if (ch === "}" || ch === "]") {
      stack.pop();
      // fully balanced root object — nothing was actually truncated
      if (stack.length === 0) return text.slice(start, i + 1);
      mark(i + 1);
    } else if (ch === ",") mark(i + 1);
  }
  if (safeEnd === -1) return null;
  const prefix = text.slice(start, safeEnd).replace(/[,\s]+$/, "");
  return prefix + openAtSafe.reverse().map(b => b === "{" ? "}" : "]").join("");
}

/** Re-add the print finishers the graph prompt asks models to END with —
 * they are the first casualties of any mid-output truncation. */
function appendFinishers(layers: Array<Record<string, unknown>>): void {
  const has = (t: string) => layers.some(l =>
    Array.isArray(l.shapes) &&
    (l.shapes as Array<{ type?: string }>).some(s => s?.type === t));
  if (!has("grain"))
    layers.push({ id: "grain-finish", label: "press grain", depth: 10,
                  shapes: [{ type: "grain", density: 4800, twoTone: true }] });
  if (!has("vignette"))
    layers.push({ id: "vignette-finish", label: "print vignette", depth: 10,
                  shapes: [{ type: "vignette", intensity: 0.32, falloff: "soft" }] });
}

/**
 * Parse a JSONL composition-graph reply: line 1 declares `lightDeg`, each
 * following line is ONE layer. Lines parse independently, so anything cut
 * off by the token ceiling costs only its own line. Tolerates fences,
 * prose noise, list numbering and dangling commas; also accepts a legacy
 * full-object reply ({"lightDeg":…,"layers":[…]}) by unpacking it.
 */
async function txt(res: Response): Promise<string> {
  try { return (await res.text()).slice(0, 160); } catch { return "<no body>"; }
}
