// engine.svelte.ts — Svelte 5 runes over the artai public API
// Transaction semantics: UI commits only after all stages succeed.
import * as artai from "artai";
import { BrowserIntentProvider } from "artai/agent";
import { compileStructuredPrompt } from "artai/core";
import type { IntentDraft } from "artai/core";

const hasLS = typeof localStorage !== "undefined";
function ld<T>(k: string, f: T): T {
  try { const r = hasLS ? localStorage.getItem(k) : null; if (r) return JSON.parse(r); } catch {}
  return f;
}
function sv(k: string, v: unknown): void {
  try { if (hasLS) localStorage.setItem(k, JSON.stringify(v)); } catch {}
}

/* ============ model settings ============ */
export interface StoredModelConfig {
  preset: string; baseUrl: string; apiKey: string; model: string;
  wireKind?: string;
}
export const settings = $state<StoredModelConfig>(
  ld("artai.keys.v1", { preset:"", baseUrl:"", apiKey:"", model:"", wireKind:"auto" }),
);
export function saveSettings(): void { sv("artai.keys.v1", { ...settings }); }
export function clearKeys(): void {
  Object.assign(settings, { preset:"", baseUrl:"", apiKey:"", model:"" });
}
export function presetDefaults(
  preset: string,
): { baseUrl: string; model: string } {
  if (preset === "openrouter") return { baseUrl:"https://openrouter.ai/api/v1", model:"anthropic/claude-sonnet-4.5" };
  if (preset === "openai")     return { baseUrl:"https://api.openai.com/v1", model:"gpt-4.1-mini" };
  if (preset === "anthropic")  return { baseUrl:"https://api.anthropic.com/v1", model:"claude-sonnet-4-5" };
  if (preset === "pi-node")    return { baseUrl:"http://127.0.0.1:8787/v1", model:"anthropic/claude-sonnet-4-5" };
  return { baseUrl:"", model:"" };
}

/* ============ wire format ============ */
export function resolveWireKind(): string {
  // explicit user choice wins (custom preset's WIRE FORMAT select)
  if (settings.wireKind === "anthropic") return "anthropic";
  if (settings.wireKind === "openai-compatible") return "openai-compatible";
  // auto: sniff from the base URL — Anthropic-wire gateways end in /anthropic
  // (e.g. GLM open.bigmodel.cn/api/anthropic) or are the native host
  const url = (settings.baseUrl || "").toLowerCase();
  if (/\/anthropic(\/|$)/.test(url) || url.includes("api.anthropic.com"))
    return "anthropic";
  if (settings.preset === "anthropic") return "anthropic";
  return "openai-compatible";
}

/* ============ provider label ============ */
export function providerLabel(): string {
  const short = settings.model.split("/").pop() ?? settings.model;
  return `${settings.preset}:${short}`;
}

/* ============ transport status ============ */
export function transportStatus(): "none" | "browser-key" | "pi-bridge" {
  const baseOk = settings.preset && settings.baseUrl && settings.model;
  // pi-node auth lives on this machine inside pi (~/.pi/agent) — no key field
  if (settings.preset === "pi-node")
    return baseOk ? "pi-bridge" : "none";
  const ok = baseOk && settings.apiKey;
  return ok ? "browser-key" : "none";
}

/** true when the selected preset needs no API KEY input at all */
export function keylessPreset(): boolean {
  return settings.preset === "pi-node";
}

/* ============ image generation credentials (independent) ============ */
export const imageGen = $state({
  baseUrl: "", apiKey: "", model: "",
});
export function saveImageGen(): void { sv("artai.imagegen.v2", { ...imageGen }); }
export function imageCapable(): boolean {
  return Boolean(imageGen.baseUrl && imageGen.apiKey && imageGen.model &&
    !/anthropic/i.test(imageGen.baseUrl));
}

/* ============ detail knob ============ */
export const detail = $state({ level: 2 });
export function setDetailLevel(v: number): void {
  detail.level = Math.min(6, Math.max(1, Math.round(v)));
}

/* ============ cache toggle ============ */
export const useCache = $state({ on: true });
export function setUseCache(v: boolean): void { useCache.on = v; }

/* ============ live motif toggle ============ */
export const liveMotif = $state({ on: true });
export function setLiveMotif(v: boolean): void { liveMotif.on = v; }

/* ============ cache module (three-phase gen cache) ============ */

async function genHash(theme: string, kind: string): Promise<string> {
  const raw = [theme, settings.model ?? "-", kind].join("\0");
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export function cacheGet<T>(key: string): T | null {
  try {
    const r = hasLS ? localStorage.getItem("artai.gen." + key) : null;
    return r ? JSON.parse(r) : null;
  } catch { return null; }
}
export function cacheSet(key: string, val: unknown): void {
  try { if (hasLS) localStorage.setItem("artai.gen." + key, JSON.stringify(val)); } catch {}
}
export function clearGenerationCache(): void {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k?.startsWith("artai.gen.")) localStorage.removeItem(k);
  }
}
export function cacheCount(): number {
  let n = 0;
  for (let i = 0; i < localStorage.length; i++) {
    if (localStorage.key(i)?.startsWith("artai.gen.")) n++;
  }
  return n;
}

/* ============ engine class ============ */

class Engine {
  theme = $state("\u9519\u8fc7\u7684\u590f\u5929");
  baseSeed = $state(42);
  busy = $state(false);
  stageIndex = $state(-1);
  stageLabelZh = $state("\u89e3\u8bfb\u4e3b\u9898...");
  envelope = $state<any | null>(null);
  pngUrl = $state<string | null>(null);
  renderCode = $state<string | null>(null);
  renderCodeBaseline = $state<string | null>(null);
  graph = $state<any | null>(null);
  graphScript = $state<string | null>(null);
  /** live-streaming state: raw graph JSON text + canvas render target */
  graphStreamText = $state("");
  graphLiveBase = $state<{ width: number; height: number; seed: number; paletteHexes: string[] } | null>(null);
  graphFailed = $state("");
  /** 继续打磨 state: true while a polish round runs, count of finished rounds */
  polishing = $state(false);
  polishRound = $state(0);
  /** real-time activity log — one line per pipeline event, shown live in the UI */
  log = $state<string[]>([]);
  /** floating windows: activity log + full-size poster lightbox */
  logOpen = $state(false);
  lightbox = $state<string | null>(null);
  lightboxOpen = $state(false);
  rendererName = $state("");
  renderWarnings = $state<string[]>([]);
  webgl2 = $state(true);
  error = $state("");
  elapsedSec = $state(0);
  backend=$state<'render'|'prompt'|'image'>('render');
  readonly stages: string[] =
    ["\u89e3\u8bfb\u4e3b\u9898", "\u751f\u6210\u914d\u65b9", "\u89c4\u5212\u7248\u5f0f",
     "\u7f16\u8bd1\u573a\u666f", "\u8d28\u91cf\u95e8\u7981", "\u6e32\u67d3"];
  private salt = 0;
  private lastTheme = "";
  private timer: ReturnType<typeof setInterval> | null = null;

  /** append one timestamped line to the live activity log */
  pushLog(msg: string): void {
    const t = new Date();
    const stamp = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
    this.log = [...this.log.slice(-199), `[${stamp}] ${msg}`];
  }

  /** LLM-authored composition graph, cached under the cache toggle */
  private async composeGraphCached(
    env: any, fullSpec: string, onDelta?: (chunk: string) => void,
    onStatus?: (label: string) => void,
  ) {
    const key = "graph." + await genHash(this.theme.trim(), "graph:v1");
    if (useCache.on) {
      const hit = cacheGet<any>(key);
      // floor 6 matches composeGraph's lenient acceptance so polished
      // salvaged versions (6–7 layers) still round-trip through the cache
      if (hit && Array.isArray(hit.layers) && hit.layers.length >= 6) {
        this.pushLog(`③ 构图命中缓存（${hit.layers.length} 层）`);
        return hit;
      }
    }
    const graph = await bpInstance().composeGraph({
      fullSpec,
      paletteHexes: paletteOf(env),
      theme: this.theme.trim(),
      ...(onDelta ? { onDelta } : {}),
      ...(onStatus ? { onStatus } : {}),
    });
    if (useCache.on) cacheSet(key, graph);
    return graph;
  }

  async generate(): Promise<void> {
    // guard: provider exists
    artai.setDefaultProvider(bpInstance());

    const t = this.theme.trim();
    if (t !== this.lastTheme) { this.salt = 0; this.lastTheme = t; }

    this.busy = true; this.error = ""; this.pngUrl = null;
    this.graph = null; this.graphScript = null;
    this.graphStreamText = ""; this.graphLiveBase = null; this.graphFailed = "";
    this.stageIndex = 0; this.stageLabelZh = "\u89e3\u8bfb\u4e3b\u9898...";
    this.log = [];
    this.logOpen = true;
    this.pushLog(`\u25b6 GENERATE \u300c${t}\u300d backend=${this.backend}`);
    const t0 = Date.now();
    this.timer && clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.elapsedSec = Math.round((Date.now() - t0) / 1000);
    }, 1000);

    try {
      this.salt++;
      const seed = ((this.baseSeed + 1) * 7919 + this.salt * 104729) >>> 0;

      const draftKey = await genHash(t, "intent:v1");
      let draft: IntentDraft;
      const intentHit = useCache.on ? cacheGet<IntentDraft>("intent." + draftKey) : null;
      if (intentHit) {
        draft = intentHit;
        this.pushLog("\u2460 \u4e3b\u9898\u89e3\u8bfb\u547d\u4e2d\u7f13\u5b58");
      } else {
        this.pushLog("\u2460 \u89e3\u8bfb\u4e3b\u9898\u2026\uff08LLM \u8c03\u7528\uff0c\u53ef\u80fd\u591a\u8f6e\uff09");
        draft = await bpInstance().parse({ theme: t });
        if (useCache.on) cacheSet("intent." + draftKey, draft);
      }
      this.pushLog(`\u2713 \u4e3b\u9898\u89e3\u8bfb\uff1a\u201c${draft.thesis}\u201d \u00b7 mood=${draft.mood} \u00b7 motif=${draft.motifHint ?? "-"} \u00b7 lang=${draft.lang}`);
      artai.setDefaultProvider(bpInstance());

      this.pushLog("\u2461 \u914d\u65b9\u00b7\u7248\u5f0f\u00b7\u95e8\u7981\uff08\u672c\u5730\u786e\u5b9a\u6027\u7ba1\u7ebf\uff09\u2026");
      env = await artai.realize(draft, {
        seed,
        backend: this.backend === "render" ? "render" : "prompt",
      });
      this.pushLog(`\u2713 \u914d\u65b9\u5c31\u7eea\uff1alayout=${env.recipe.layout.family} \u00b7 focal=${env.recipe.focal.form} \u00b7 hue=${env.recipe.color.hue} \u00b7 \u95e8\u7981 ${env.gate.pass ? "pass" : "degraded"}`);

      document.documentElement.style.setProperty("--accent",
        String(env.recipe.color.hue));

      // recompute the four-paragraph prompt to reflect final IR (incl customMotif)
      env.prompt = artai.compilePrompt(env.recipe, env.plan, env.ir);

      this.fullSpec =
        compileStructuredPrompt(env.recipe, env.plan, env.ir);

      // expose the envelope BEFORE the LLM stages — the result sheet (with
      // the live streaming canvas) is gated on it, and landing it only after
      // the graph finished was why nothing showed until the run completed
      this.envelope = env;

      // RAW CODE: deterministic baseline stays; the LLM authors a visual
      // composition GRAPH first (think like an illustrator), then the graph
      // renders to the enhanced Canvas-2D code shown on web.
      if (this.backend === "render") {
        try {
          const { irToScript, graphToScript } = await import("artai/core");
          this.renderCodeBaseline =
            irToScript(env.ir);

          // ── LLM composes the layered graph BEFORE any code exists ──
          // Streaming: deltas land in graphStreamText; ResultSheet redraws
          // the canvas live as each layer's JSON object completes.
          this.stageLabelZh = "构图…";
          this.pushLog("③ LLM 构图（初稿 → 审计 → 打磨）…");
          this.graphStreamText = "";
          this.graphLiveBase = {
            width: env.ir.canvas.width,
            height: env.ir.canvas.height,
            seed: Number(env.meta?.seedUsed ?? seed),
            paletteHexes: paletteOf(env),
          };
          const graph = await this.composeGraphCached(
            env, String(this.fullSpec ?? ""),
            (chunk) => { this.graphStreamText += chunk; },
            (label) => {
              // each polish round is a fresh draft — clear the stale stream
              this.graphStreamText = "";
              this.stageLabelZh = label;
              this.pushLog(label);
            },
          );
          this.graphStreamText = "";   // switch preview to the finished graph
          this.graphLiveBase = null;
          this.graph = graph;
          this.pushLog(`✓ 构图完成：${graph.layers.length} 层 · ${graph.layers.reduce((a: number, l: any) => a + (l.shapes?.length ?? 0), 0)} shapes · lightDeg=${graph.lightDeg}`);

          // the enhanced code IS the graph + its deterministic renderer
          const seedUsed = Number(env.meta?.seedUsed ?? seed);
          this.graphScript = graphToScript(graph, {
            width: env.ir.canvas.width,
            height: env.ir.canvas.height,
            seed: seedUsed,
          });
          this.renderCode = this.graphScript;
          this.graphFailed = "";

          // the poster appears the MOMENT the graph exists — no waiting for
          // later stages; the final render block below is then a no-op.
          // renderGraphPoster = graph pixels + the shared typography overlay
          // (中文标题/短句/microtext), exactly what the IR paths stamp on top
          const poster = artai.renderGraphPoster(graph, env.ir, {
            seed: seedUsed,
            width: env.ir.canvas.width,
            height: env.ir.canvas.height,
          });
          this.pngUrl = poster.dataUrl;
          this.rendererName = poster.renderer;
          this.renderWarnings = poster.warnings || [];
        } catch (e) {
          // strict no-silent-degradation: surface the graph failure but keep
          // the deterministic baseline so the poster still renders
          this.graph = null;
          this.graphScript = null;
          this.graphStreamText = "";
          this.graphLiveBase = null;
          this.graphFailed = fmtErr(e).slice(0, 300);
          this.pushLog(`✗ 构图失败，已回退 RAW 基线：${this.graphFailed}`);
          this.renderCode = this.renderCodeBaseline;
        }
      }

      this.pushLog("④ 渲染海报 PNG…");

      if (this.backend === "render" && !this.graph) {
        // only the graph-failure fallback still renders here; the success
        // path already produced the final PNG straight from the graph
        this.stageLabelZh = "render...";
        const r = await artai.renderPoster(env.ir, { seed: env.meta.seedUsed });
        this.pngUrl = r.dataUrl;
        this.rendererName = r.renderer;
        this.renderWarnings = r.warnings || [];
      }
    } catch (err) {
      this.error = fmtErr(err).slice(0, 480);
      this.pushLog(`✗ ${this.error}`);
      this.pngUrl = null;
    } finally {
      clearInterval(this.timer!); this.timer = null; this.busy = false;
      if (!this.error) {
        this.stageIndex = 6; this.stageLabelZh = "done";
        this.pushLog(`✓ 完成，耗时 ${Math.round((Date.now() - t0) / 100) / 10}s`);
      }
    }
  }

  /** 继续打磨 — one more art-direction round on top of the current final
   * graph: critique what exists, revise it with the LLM, and refresh the
   * preview, exported script and final PNG. Repeatable. */
  async polish(): Promise<void> {
    if (this.busy || this.polishing || !this.graph || !this.envelope) return;
    const env = this.envelope;
    this.busy = true;
    this.polishing = true;
    this.polishRound = 0;
    this.error = "";
    this.graphStreamText = "";
    this.graphLiveBase = {
      width: env.ir.canvas.width,
      height: env.ir.canvas.height,
      seed: Number(env.meta?.seedUsed ?? 1),
      paletteHexes: paletteOf(env),
    };
    this.stageIndex = 3;
    this.stageLabelZh = "继续打磨…";
    try {
      const { critiqueGraph, graphToScript } =
        await import("artai/core");
      const seedUsed = Number(env.meta?.seedUsed ?? 1);
      const complaints = critiqueGraph(this.graph as any);
      this.logOpen = true;
      this.pushLog(`▶ 继续打磨 · 审计当前终稿：${complaints.length ? `${complaints.length} 项问题 — ${complaints.join("; ")}` : "无硬伤，执行提升级打磨"}`);
      const graph = await bpInstance().composeGraph({
        fullSpec: String(this.fullSpec ?? ""),
        paletteHexes: paletteOf(env),
        theme: this.theme.trim(),
        previousGraph: {
          graphJson: JSON.stringify({
            lightDeg: this.graph.lightDeg, layers: this.graph.layers,
          }),
          complaints,
        },
        onDelta: (chunk) => { this.graphStreamText += chunk; },
        onStatus: (label) => {
          // each polish round is a fresh draft — clear the stale stream
          this.graphStreamText = "";
          this.polishRound++;
          this.stageLabelZh = label;
          this.pushLog(label);
        },
      });
      this.graphStreamText = "";
      this.graphLiveBase = null;
      this.graph = graph;
      this.graphFailed = "";
      this.graphScript = graphToScript(graph, {
        width: env.ir.canvas.width,
        height: env.ir.canvas.height,
        seed: seedUsed,
      });
      this.renderCode = this.graphScript;
      // the final PNG follows the polished graph, same engine as the preview,
      // plus the shared typography overlay (标题/短句/microtext)
      const r = artai.renderGraphPoster(graph, env.ir, {
        width: env.ir.canvas.width,
        height: env.ir.canvas.height,
        seed: seedUsed,
      });
      this.pngUrl = r.dataUrl;
      this.rendererName = r.renderer;
      this.renderWarnings = r.warnings || [];
      this.pushLog(`✓ 打磨完成：${graph.layers.length} 层 · ${graph.layers.reduce((a: number, l: any) => a + (l.shapes?.length ?? 0), 0)} shapes · 海报已更新`);
      // keep the composition cache coherent with the improved version
      if (useCache.on) {
        const key = "graph." + await genHash(this.theme.trim(), "graph:v1");
        cacheSet(key, graph);
      }
    } catch (err) {
      this.error = fmtErr(err).slice(0, 480);
      this.pushLog(`✗ 打磨失败：${this.error}`);
    } finally {
      this.busy = false;
      this.polishing = false;
      this.stageIndex = 6;
      this.stageLabelZh = "done";
    }
  }
  fullSpec = $state<string | null>(null);
}

let env: any;

/** palette hexes handed to the LLM as the locked color set for the graph */
function paletteOf(env: any): string[] {
  const c = env?.recipe?.color ?? {};
  const hexes: string[] = [];
  for (const k of ["hue", "deep", "wash", "lift", "line", "hue2"]) {
    const v = c[k];
    if (typeof v === "string" && v.trim()) hexes.push(v.trim());
  }
  return hexes.length >= 3
    ? hexes
    : ["#d8412f", "#26241f", "#e9e0cc", "#fbf6ea", "#1B4FD8"];
}

function bpInstance() {
  const wk = resolveWireKind() as 'openai-compatible'|'anthropic';
  return new BrowserIntentProvider({ kind: wk, baseUrl: settings.baseUrl,
    apiKey: settings.apiKey, model: settings.model });
}
function fmtErr(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  const full = err instanceof Error ? err.message : String(err);
  if (name === "NoIntentProviderError") return full;
  if (name === "RenderCapabilityError")
    return `\u6e32\u67d3\u5931\u8d25\uff1a${full}\uff08\u53ef\u5207\u6362 prompt \u540e\u7aef\uff09`;
  if (name === "ProviderError")
    return `\u2717 \u670d\u52a1\u5546\u62d2\u7edd\u8bf7\u6c42\uff1a${full}`;
  if (name === "MotifSpecError") {
    let advice = "";
    if (/token ceiling|length/i.test(full))
      advice = "\n\u5efa\u8bae\uff1a\u6362\u7528\u975e\u601d\u8003\u578b\u53f7\u3002";
    else if (/usage metadata/i.test(full))
      advice = "\n\u5efa\u8bae\uff1a\u6838\u5bf9 BASE URL \u3002";
    return `\u25b3 \u6bcd\u9898\u8bbe\u8ba1\u5931\u8d25 \u2014 ${full}${advice}`;
  }
  if (name === "ProviderContractViolation") {
    let advice = "";
    if (/empty/i.test(full))
      advice = "\n建议：核对 BASE URL（不应带 /v1 后缀的 /messages）、模型名是否被代理支持；或临时切到 openai-compatible 预设。"
              + "\n也可能是代理网关的 system 字段未透传——已自动改用顶层 system。";
    return `\u25b3 \u683c\u5f0f\u4e0d\u53ef\u7528 \u2014 ${full}${advice}`.slice(0, 480);
  }
  return `\u2717 ${full.slice(0, 240)}`;
}

export const engine = new Engine();

if (typeof queueMicrotask === "function") {
  queueMicrotask(() => { engine.webgl2 = typeof WebGL2RenderingContext !== 'undefined' && !!document.createElement('canvas').getContext('webgl2'); });
}

export async function testConnection(): Promise<string> {
  const bp = bpInstance(); if (!bp) return "config incomplete";
  const t0 = Date.now();
  const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  try {
    // lightweight probe — a full intent parse can take minutes on thinking
    // models and burns the whole escalation ladder on hiccups
    if (typeof (bp as { ping?: unknown }).ping === "function") {
      await (bp as { ping(): Promise<{ ok: true; note: string }> }).ping();
      return `\u2713 ok \u00b7 ${secs()}${settings.model ? " \u00b7 " + settings.model : ""}`;
    }
    await bp.parse({ theme: "ping" });
    return `\u2713 ok \u00b7 ${secs()}`;
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const full = err instanceof Error ? err.message : String(err);
    const tail = ` (\u8017\u65f6 ${secs()})`;
    return name === "MotifSpecError"
      ? `\u25b3 reachable ${full.slice(0, 200)}${tail}`
      : `\u2717 ${full.slice(0, 240)}${tail}`;
  }
}
