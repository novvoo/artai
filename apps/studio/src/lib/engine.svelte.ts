// engine.svelte.ts — Svelte 5 runes over the artai public API
// Transaction semantics: UI commits only after all stages succeed.
import * as artai from "artai";
import { BrowserIntentProvider } from "artai/agent";
import {
  ACCENT_HUES,
  companionHue,
  shade,
  tint,
  compileStructuredPrompt,
  paletteFromPixels,
  paperToneHex,
} from "artai/core";
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

/* ============ palette presets (主题配色) ============ */
export interface PalettePreset {
  id: string;
  label: string;
  /** user-locked accent hex; omit = the model's mood steers chromatics */
  accent?: string;
  /** companion hue measured from an original image (display only) */
  accent2?: string;
  /** user-locked paper tone hex paired with the accent */
  paper?: string;
}
export const PALETTES: PalettePreset[] = [
  { id: "auto", label: "自动" },
  { id: "tomato", label: "番茄红", accent: "#D8412F", paper: "#F5F0E6" },
  { id: "cobalt", label: "钴蓝", accent: "#1B4FD8", paper: "#F5F0E6" },
  { id: "cyan", label: "青碧", accent: "#00A6C8", paper: "#EFE8D8" },
  { id: "violet", label: "紫罗兰", accent: "#6A4FC7", paper: "#E4E2DC" },
  { id: "magenta", label: "品红", accent: "#E23D81", paper: "#EFE8D8" },
  { id: "lemon", label: "柠檬黄", accent: "#F2C230", paper: "#E9DFC0" },
  { id: "pear", label: "橄榄绿", accent: "#9BB53C", paper: "#D9CFAF" },
  { id: "orange", label: "落日橙", accent: "#F26A21", paper: "#F5F0E6" },
  { id: "ultramarine", label: "群青", accent: "#2743C6", paper: "#E4E2DC" },
];
export const paletteSel = $state<{ id: string }>(
  ld("artai.palette.v1", { id: "auto" }),
);
export function setPalette(id: string): void {
  paletteSel.id = id;
  // an explicit preset click supersedes image-derived colors
  imagePaletteState.current = null;
  sv("artai.palette.v1", { id });
}
/** the locked preset, or undefined when 自動 lets the mood roll decide */
export function activePalette(): PalettePreset | undefined {
  if (imagePaletteState.current) return imagePaletteState.current;
  const p = PALETTES.find((x) => x.id === paletteSel.id);
  return p?.accent ? p : undefined;
}

/* ============ 原始图片输入模式（image-palette override） ============ */
/** Palette measured from a user-supplied original image (paletteFromPixels).
 * Takes priority over the 配色 preset until the user picks a preset again.
 * Object wrapper: module-level $state must be mutated in place, never
 * reassigned across the module boundary. */
export const imagePaletteState = $state<{ current: PalettePreset | null }>({
  current: null,
});
/** image:<accent>:<paper> tag — cache scope + history identity for a run
 * driven by an extracted palette (restore replays the hexes, no re-decode) */
function imagePaletteTag(p: PalettePreset): string {
  return `image:${p.accent}:${p.paper}`;
}

/** decode an uploaded original image → measured palette → locked override */
export async function applyImagePaletteFromFile(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(new Error("读取图片文件失败"));
    fr.readAsDataURL(file);
  });
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("图片解码失败（仅支持常见位图格式）"));
    img.src = dataUrl;
  });
  // downscale into a ≤220px sampling canvas — the palette only needs
  // statistics, and the demo contract is honored: pixels from the REAL image
  const maxSide = 220;
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Canvas2D 不可用，无法解析图片");
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  const pal = paletteFromPixels(data.data, w, h);
  imagePaletteState.current = {
    id: "image",
    label: "图片取色",
    accent: pal.accent,
    accent2: pal.accent2,
    paper: pal.paper,
  };
  return `accent ${pal.accent} · paper ${pal.paper} · 对比度 ${pal.stats.contrast.toFixed(2)}`;
}

/** re-apply an extracted palette from stored hexes (history restore) */
export function applyImagePaletteHexes(accent: string, paper: string): void {
  imagePaletteState.current = { id: "image", label: "图片取色", accent, paper };
}
export function clearImagePalette(): void { imagePaletteState.current = null; }

/* ============ cache module (three-phase gen cache) ============ */

/** scope folds the palette choice into cache keys: intent is palette-free,
 * but a composition graph authored against one 配色 must never be served
 * for another ("" scope = auto → legacy keys keep hitting) */
async function genHash(theme: string, kind: string, scope = ""): Promise<string> {
  const raw = [theme, scope, settings.model ?? "-", kind].join("\0");
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
  // the history panel is a DIRECTORY over these caches — an entry pointing at
  // a wiped cache key can no longer restore, so the index goes with them
  localStorage.removeItem(HISTORY_KEY);
  engine.history = [];
}
export function cacheCount(): number {
  let n = 0;
  for (let i = 0; i < localStorage.length; i++) {
    if (localStorage.key(i)?.startsWith("artai.gen.")) n++;
  }
  return n;
}

/* ============ run history (cached generations) ============ */

export interface HistoryEntry {
  /** cache key of the composition graph ("graph.<hash>") */
  key: string;
  theme: string;
  /** the FULL user prompt as typed into the THEME textarea (multi-line) */
  prompt: string;
  /** polish suggestions the user applied to this entry, in order */
  polishNotes: string[];
  model: string;
  /** epoch ms of the last write to this cache entry */
  at: number;
  layers: number;
  shapes: number;
  /** poster dataUrl thumbnail (downscaled, jpeg) for the list */
  thumb?: string | undefined;
  /** 配色 preset id the graph was authored against ("auto" = mood-driven) */
  palette?: string;
  /** the realize() input seed of the run — restore must replay THIS seed,
   * not a recomputed one, or the re-realized IR won't match the cached graph */
  seed?: number;
}

const HISTORY_KEY = "artai.history.v1";

export function loadHistory(): HistoryEntry[] {
  let stored: HistoryEntry[] = [];
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    stored = raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch { stored = []; }
  // indexes written by older builds predate prompt/polishNotes — fill
  // defaults so HistoryPanel can render every entry without crashing
  stored = stored.map((h) => ({
    ...h,
    prompt: h.prompt ?? "",
    polishNotes: Array.isArray(h.polishNotes) ? h.polishNotes : [],
  }));
  // the index is a DIRECTORY over the actual caches — entries written before
  // this feature existed (or on another tab) are rebuilt from localStorage
  try {
    const known = new Set(stored.map((h) => h.key));
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith("artai.gen.graph.")) continue;
      if (known.has(k.slice("artai.gen.".length))) continue;
      try {
        const g = JSON.parse(localStorage.getItem(k) ?? "null") as
          { layers?: Array<{ shapes?: unknown[] }>; lightDeg?: number };
        if (!Array.isArray(g?.layers) || g.layers.length < 6) continue;
        const shapes = g.layers.reduce(
          (a, l) => a + (Array.isArray(l.shapes) ? l.shapes.length : 0), 0);
        stored.push({
          key: k.slice("artai.gen.".length),
          theme: "(旧缓存 — 生成一次以补全信息)",
          prompt: "",
          polishNotes: [],
          model: "-",
          at: 0, // sorts to the bottom until refreshed by a real run
          layers: g.layers.length,
          shapes,
        });
      } catch { /* corrupt entry — skip */ }
    }
  } catch { /* localStorage unavailable */ }
  stored.sort((a, b) => b.at - a.at);
  return stored;
}

/** persist the index; on quota pressure retry without thumbnails (the size
 * bulk) and finally with fewer entries — a truncation beats a silent total
 * loss of the newest records */
function saveHistory(list: HistoryEntry[]): void {
  const trimmed = list.slice(0, 60);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
    return;
  } catch { /* fall through to degradation */ }
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(
      trimmed.map(({ thumb: _t, ...rest }) => rest)));
    return;
  } catch { /* still too big — keep halving */ }
  let half = trimmed;
  while (half.length > 1) {
    half = half.slice(0, Math.ceil(half.length / 2));
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(
        half.map(({ thumb: _t, ...rest }) => rest)));
      return;
    } catch { /* keep halving */ }
  }
}

/** downscale a poster dataUrl into a tiny jpeg thumbnail for the list */
function makeThumb(dataUrl: string): Promise<string | undefined> {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const w = 72;
      const h = Math.max(1, Math.round((img.height / img.width) * w));
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d")?.drawImage(img, 0, 0, w, h);
      try { res(c.toDataURL("image/jpeg", 0.7)); } catch { res(undefined); }
    };
    img.onerror = () => res(undefined);
    img.src = dataUrl;
  });
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
  /** true after the user pressed 停止 and the run is unwinding */
  stopping = $state(false);
  private runCtrl: AbortController | null = null;
  /** user's own polish suggestion (继续打磨的附加 prompt) */
  polishNote = $state("");
  /** cached-run history index (most recent first) for the 历史记录 window */
  history = $state<HistoryEntry[]>([]);
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
  /** realize() input seed of the most recent generate() — recorded into history */
  private lastSeed = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** abort the in-flight run: fetches die mid-flight, checkpoints unwind.
   * Hard-deadline backstop: if the run hasn't unwound within 3s (a missed
   * signal path or a stuck await), force-release the UI anyway — the stop
   * button must never stick in "停止中…". */
  stopRun(): void {
    if (!this.busy || this.stopping) return;
    this.stopping = true;
    this.runCtrl?.abort();
    this.pushLog("■ 收到停止请求，正在中断当前阶段…");
    setTimeout(() => {
      if (this.stopping) {
        this.stopping = false;
        this.busy = false;
        this.runCtrl = null; // zombies die at the next chk() checkpoint
        this.pushLog("■ 已强制停止");
      }
    }, 3000);
  }

  /** checkpoint between async stages — throws when the run was stopped.
   * A detached runCtrl (force-stop) also throws, so stale runs that later
   * resolve can never resume and clobber the UI. */
  private chk(): void {
    if (!this.runCtrl || this.runCtrl.signal.aborted)
      throw new DOMException("stopped by user", "AbortError");
  }

  /** the graph cache key for the current theme + palette selection */
  private async graphCacheKey(): Promise<string> {
    const pal = activePalette();
    // image-derived palettes scope by their measured hexes: two different
    // source images must never share a cached composition
    const scope = pal
      ? (pal.id === "image" ? imagePaletteTag(pal) : pal.id)
      : "";
    return "graph." + await genHash(this.theme.trim(), "graph:v1", scope);
  }

  /** upsert a run into the history index after a successful poster render.
   * Returns false (and logs) instead of silently vanishing — a cache entry
   * without its history record is exactly the bug users report. */
  async recordHistory(): Promise<boolean> {
    // prompt-backend runs legitimately produce no poster — stay quiet there;
    // a render run without a final poster is the anomaly worth surfacing
    if (this.backend === "prompt") return false;
    if (!this.graph || !this.envelope || !this.pngUrl) {
      this.pushLog("⚠ 未写入历史：本次运行没有可记录的最终海报（构图或渲染未完成）");
      return false;
    }
    const model = String(settings.model ?? "-");
    const theme = this.theme.trim();
    const graphKey = await this.graphCacheKey();
    const prev = loadHistory().find((h) => h.key === graphKey);
    const note = this.polishNote.trim();
    const notes = note && !prev?.polishNotes.includes(note)
      ? [...(prev?.polishNotes ?? []), note] : (prev?.polishNotes ?? []);
    const entry: HistoryEntry = {
      key: graphKey,
      theme,
      prompt: theme,
      polishNotes: notes,
      model,
      at: Date.now(),
      palette: paletteTagForHistory(),
      seed: this.lastSeed,
      layers: this.graph.layers.length,
      shapes: this.graph.layers.reduce(
        (a: number, l: any) => a + (l.shapes?.length ?? 0), 0),
      thumb: await makeThumb(this.pngUrl),
    };
    const list = loadHistory().filter(
      (h) => !(h.key === entry.key && h.model === entry.model));
    list.unshift(entry);
    try {
      saveHistory(list);
    } catch (err) {
      this.pushLog(`✗ 历史记录写入失败：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    this.history = list;
    return true;
  }

  /** restore a cached run: theme + seed back into the panel, graph/poster
   * re-rendered from the cached composition (no LLM round-trip) */
  async restoreHistory(entry: HistoryEntry): Promise<void> {
    if (this.busy) return;
    const hit = cacheGet<any>(entry.key);
    if (!hit || !Array.isArray(hit.layers) || hit.layers.length < 6) {
      this.error = `该历史记录的缓存已不存在（${entry.theme}）`;
      return;
    }
    const theme = entry.theme;
    if (theme.startsWith("(旧缓存")) {
      this.busy = false;
      this.error = "这是历史功能上线前的旧缓存 — 主题信息缺失，重新 GENERATE 一次该主题即可补全";
      return;
    }
    this.theme = theme;
    this.lastTheme = theme;
    // re-lock the 配色 the graph was authored against so the re-realized
    // IR (paper tone, accent panels) matches the cached composition.
    // image:<accent>:<paper> tags replay the measured hexes without a re-decode
    const tag = entry.palette ?? "auto";
    if (tag.startsWith("image:")) {
      const [, accent, paper] = tag.split(":");
      if (accent && paper) applyImagePaletteHexes(accent, paper);
      else { clearImagePalette(); setPalette("auto"); }
    } else {
      clearImagePalette();
      setPalette(tag);
    }
    this.busy = true;
    this.error = "";
    this.stageIndex = 6;
    this.stageLabelZh = "恢复历史…";
    this.pushLog(`⏪ 恢复历史：${theme}（${hit.layers.length} 层）`);
    try {
      const { graphToScript } = await import("artai/core");
      // replay the EXACT seed the run used (falls back to the salt=0 formula
      // for entries recorded before seeds were tracked)
      const seed = entry.seed ?? (((this.baseSeed + 1) * 7919) >>> 0);
      this.lastSeed = seed;

      // rebuild a minimal envelope: reuse the live intent/realize caches so
      // the palette/IR/chrome come back exactly as they were
      const draftKey = await genHash(theme, "intent:v1");
      let draft: IntentDraft | null = useCache.on
        ? cacheGet<IntentDraft>("intent." + draftKey) : null;
      if (!draft) {
        this.busy = false;
        this.error = "该主题的意图缓存已过期 — 请重新 GENERATE 一次以重建";
        return;
      }
      artai.setDefaultProvider(bpInstance());
      env = await artai.realize(draft, {
        seed,
        backend: this.backend === "render" ? "render" : "prompt",
        ...realizeOverrides(),
      });
      env.prompt = artai.compilePrompt(env.recipe, env.plan, env.ir);
      this.fullSpec = compileStructuredPrompt(env.recipe, env.plan, env.ir);
      this.envelope = env;
      document.documentElement.style.setProperty("--accent",
        String(env.recipe.color.hue));

      const seedUsed = Number(env.meta?.seedUsed ?? seed);
      const { normalizeLayerOrder } = await import("artai/core");
      const graph = { ...hit, layers: normalizeLayerOrder(hit.layers) };
      this.graph = graph;
      this.graphScript = graphToScript(graph, {
        width: env.ir.canvas.width,
        height: env.ir.canvas.height,
        seed: seedUsed,
      });
      this.renderCode = this.graphScript;
      this.graphFailed = "";
      const poster = artai.renderGraphPoster(graph, env.ir, {
        width: env.ir.canvas.width,
        height: env.ir.canvas.height,
        seed: seedUsed,
      });
      this.pngUrl = poster.dataUrl;
      this.rendererName = poster.renderer;
      this.renderWarnings = poster.warnings || [];
      this.polishRound = 0;
      this.pushLog(`✓ 已恢复：${graph.layers.length} 层 · ${graph.layers.reduce((a: number, l: any) => a + (l.shapes?.length ?? 0), 0)} shapes`);
    } catch (err) {
      this.error = fmtErr(err).slice(0, 480);
      this.pushLog(`✗ 恢复失败：${this.error}`);
    } finally {
      this.busy = false;
      this.stageLabelZh = "done";
    }
  }

  /** append one timestamped line to the live activity log */
  pushLog(msg: string): void {
    const t = new Date();
    const stamp = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
    this.log = [...this.log.slice(-199), `[${stamp}] ${msg}`];
  }

  /** LLM-authored composition graph, cached under the cache toggle */
  private async composeGraphCached(
    env: any, fullSpec: string, onDelta?: (chunk: string) => void,
    onStatus?: (label: string) => void, signal?: AbortSignal,
  ) {
    const key = await this.graphCacheKey();
    if (useCache.on) {
      const hit = cacheGet<any>(key);
      // floor 6 matches composeGraph's lenient acceptance so polished
      // salvaged versions (6–7 layers) still round-trip through the cache
      if (hit && Array.isArray(hit.layers) && hit.layers.length >= 6) {
        // stale cached graphs predate the layer-order gate — normalize
        // deterministically (paper bottom, focal high, finishers top)
        const { normalizeLayerOrder } = await import("artai/core");
        const fixed = { ...hit, layers: normalizeLayerOrder(hit.layers) };
        this.pushLog(`③ 构图命中缓存（${fixed.layers.length} 层，已规范化层序）`);
        return fixed;
      }
    }
    const graph = await bpInstance().composeGraph({
      fullSpec,
      paletteHexes: paletteOf(env),
      theme: this.theme.trim(),
      ...(onDelta ? { onDelta } : {}),
      ...(onStatus ? { onStatus } : {}),
      ...(signal ? { signal } : {}),
    });
    if (useCache.on) cacheSet(key, graph);
    return graph;
  }

  async generate(): Promise<void> {
    if (this.busy) return; // re-entry guard: no second pipeline on a stray click
    // guard: provider exists
    artai.setDefaultProvider(bpInstance());

    const t = this.theme.trim();
    if (t !== this.lastTheme) { this.salt = 0; this.lastTheme = t; }

    this.busy = true; this.stopping = false; this.error = ""; this.pngUrl = null;
    this.graph = null; this.graphScript = null;
    this.graphStreamText = ""; this.graphLiveBase = null; this.graphFailed = "";
    const runCtrl = new AbortController();
    this.runCtrl = runCtrl;
    const signal = runCtrl.signal;
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
      this.lastSeed = seed;

      const draftKey = await genHash(t, "intent:v1");
      let draft: IntentDraft;
      const intentHit = useCache.on ? cacheGet<IntentDraft>("intent." + draftKey) : null;
      if (intentHit) {
        draft = intentHit;
        this.pushLog("\u2460 \u4e3b\u9898\u89e3\u8bfb\u547d\u4e2d\u7f13\u5b58");
      } else {
        this.pushLog("\u2460 \u89e3\u8bfb\u4e3b\u9898\u2026\uff08LLM \u8c03\u7528\uff0c\u53ef\u80fd\u591a\u8f6e\uff09");
        draft = await bpInstance().parse({ theme: t, signal });
        if (useCache.on) cacheSet("intent." + draftKey, draft);
      }
      this.chk();
      this.pushLog(`\u2713 \u4e3b\u9898\u89e3\u8bfb\uff1a\u201c${draft.thesis}\u201d \u00b7 mood=${draft.mood} \u00b7 motif=${draft.motifHint ?? "-"} \u00b7 lang=${draft.lang}`);
      artai.setDefaultProvider(bpInstance());

      this.pushLog("\u2461 \u914d\u65b9\u00b7\u7248\u5f0f\u00b7\u95e8\u7981\uff08\u672c\u5730\u786e\u5b9a\u6027\u7ba1\u7ebf\uff09\u2026");
      env = await artai.realize(draft, {
        seed,
        backend: this.backend === "render" ? "render" : "prompt",
        ...realizeOverrides(),
      });
      const pal = activePalette();
      this.pushLog(`\u2713 \u914d\u65b9\u5c31\u7eea\uff1alayout=${env.recipe.layout.family} \u00b7 focal=${env.recipe.focal.form} \u00b7 hue=${env.recipe.color.hue}${pal ? ` \u00b7 \u914d\u8272=${pal.label}` : ""} \u00b7 \u95e8\u7981 ${env.gate.pass ? "pass" : "degraded"}`);
      this.chk();

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
            signal,
          );
          this.graphStreamText = "";   // switch preview to the finished graph
          this.graphLiveBase = null;
          this.graph = graph;
          this.pushLog(`✓ 构图完成：${graph.layers.length} 层 · ${graph.layers.reduce((a: number, l: any) => a + (l.shapes?.length ?? 0), 0)} shapes · lightDeg=${graph.lightDeg}`);
          this.chk();

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
          // yield to the event loop FIRST: the render is synchronous and
          // can take seconds — a queued 停止 click must be processed (and
          // the run unwound) instead of freezing the UI mid-render
          await new Promise((r) => setTimeout(r, 0));
          this.chk();
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
      this.chk();

      if (this.backend === "render" && !this.graph) {
        // only the graph-failure fallback still renders here; the success
        // path already produced the final PNG straight from the graph
        this.stageLabelZh = "render...";
        await new Promise((r) => setTimeout(r, 0));
        this.chk();
        const r = await artai.renderPoster(env.ir, { seed: env.meta.seedUsed });
        this.pngUrl = r.dataUrl;
        this.rendererName = r.renderer;
        this.renderWarnings = r.warnings || [];
      }
    } catch (err) {
      if (signal.aborted) {
        // user stop — not an error: keep whatever already rendered visible
        this.pushLog("■ 已停止");
        this.stageLabelZh = "已停止";
      } else {
        this.error = fmtErr(err).slice(0, 480);
        this.pushLog(`✗ ${this.error}`);
        this.pngUrl = null;
      }
    } finally {
      clearInterval(this.timer!); this.timer = null;
      this.busy = false;
      this.stopping = false;
      this.runCtrl = null;
      // success-only: a completed run never enters catch, so the done-label
      // and history record can only happen here
      if (!this.error && !signal.aborted) {
        this.stageIndex = 6; this.stageLabelZh = "done";
        this.pushLog(`✓ 完成，耗时 ${Math.round((Date.now() - t0) / 100) / 10}s`);
        await this.recordHistory().catch((err) =>
          this.pushLog(`✗ 历史记录写入失败：${err instanceof Error ? err.message : String(err)}`));
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
    this.stopping = false;
    this.polishing = true;
    this.polishRound = 0;
    this.error = "";
    const runCtrl = new AbortController();
    this.runCtrl = runCtrl;
    const signal = runCtrl.signal;
    this.graphStreamText = "";
    this.graphLiveBase = {
      width: env.ir.canvas.width,
      height: env.ir.canvas.height,
      seed: Number(env.meta?.seedUsed ?? 1),
      paletteHexes: paletteOf(env),
    };
    this.stageIndex = 3;
    this.stageLabelZh = "继续打磨…";
    const t0 = Date.now();
    this.timer && clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.elapsedSec = Math.round((Date.now() - t0) / 1000);
    }, 1000);
    try {
      const { critiqueGraph, graphToScript } =
        await import("artai/core");
      const seedUsed = Number(env.meta?.seedUsed ?? 1);
      const complaints = critiqueGraph(this.graph as any);
      this.logOpen = true;
      this.pushLog(`▶ 继续打磨 · 审计当前终稿：${complaints.length ? `${complaints.length} 项问题 — ${complaints.join("; ")}` : "无硬伤，执行提升级打磨"}${this.polishNote.trim() ? ` · 用户建议：「${this.polishNote.trim()}」` : ""}`);
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
        ...(this.polishNote.trim()
          ? { userNote: this.polishNote.trim() }
          : {}),
        onDelta: (chunk) => { this.graphStreamText += chunk; },
        onStatus: (label) => {
          // each polish round is a fresh draft — clear the stale stream
          this.graphStreamText = "";
          this.polishRound++;
          this.stageLabelZh = label;
          this.pushLog(label);
        },
        signal,
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
      await new Promise((r) => setTimeout(r, 0));
      this.chk();
      const r = artai.renderGraphPoster(graph, env.ir, {
        width: env.ir.canvas.width,
        height: env.ir.canvas.height,
        seed: seedUsed,
      });
      this.pngUrl = r.dataUrl;
      this.rendererName = r.renderer;
      this.renderWarnings = r.warnings || [];
      this.chk();
      this.pushLog(`✓ 打磨完成：${graph.layers.length} 层 · ${graph.layers.reduce((a: number, l: any) => a + (l.shapes?.length ?? 0), 0)} shapes · 海报已更新`);
      await this.recordHistory().catch((err) =>
        this.pushLog(`✗ 历史记录写入失败：${err instanceof Error ? err.message : String(err)}`));
      // keep the composition cache coherent with the improved version
      if (useCache.on) {
        const key = await this.graphCacheKey();
        cacheSet(key, graph);
      }
    } catch (err) {
      if (signal.aborted) {
        this.pushLog("■ 已停止（保留上一版海报）");
      } else {
        this.error = fmtErr(err).slice(0, 480);
        this.pushLog(`✗ 打磨失败：${this.error}`);
      }
    } finally {
      clearInterval(this.timer!); this.timer = null;
      this.busy = false;
      this.stopping = false;
      this.polishing = false;
      this.runCtrl = null;
      this.stageIndex = 6;
      this.stageLabelZh = "done";
    }
  }
  fullSpec = $state<string | null>(null);
}

let env: any;

/** realize() overrides for the user-locked 配色 preset (empty = 自动) */
function realizeOverrides(): { accent?: string; paperTone?: string } {
  const p = activePalette();
  if (!p?.accent) return {};
  return p.paper ? { accent: p.accent, paperTone: p.paper } : { accent: p.accent };
}

/** history identity of the active palette: preset id, or the measured
 * image:<accent>:<paper> tag so a restore can re-lock the exact hexes */
function paletteTagForHistory(): string {
  const p = activePalette();
  if (!p) return "auto";
  return p.id === "image" ? imagePaletteTag(p) : p.id;
}

/** palette hexes handed to the LLM as the locked color set for the graph */
function paletteOf(env: any): string[] {
  const c = env?.recipe?.color ?? {};
  const hexes: string[] = [];
  for (const k of ["hue", "deep", "wash", "lift", "line", "hue2"]) {
    const v = c[k];
    if (typeof v === "string" && v.trim()) hexes.push(v.trim());
  }
  if (hexes.length >= 3) return hexes;
  // recipe.color carries only the accent — derive the full locked set from
  // the same math the deterministic IR uses, so the graph's palette matches
  // what will actually be painted (paper tone + shaded deep + washed panels
  // + the mood's companion hue for two-ink motifs)
  const accent = String(c.hue ?? "#d8412f");
  const paper = String(paperToneHex(String(env?.recipe?.canvas?.paperTone ?? "")));
  const companion = String(
    ACCENT_HUES[companionHue(String(env?.recipe?.mood ?? ""), String(c.name ?? ""))] ?? "#1B4FD8");
  return [accent, shade(accent, 0.38), tint(accent, 0.74), paper, companion];
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
engine.history = loadHistory();

// another tab wrote history/caches — refresh the panel so a run generated
// elsewhere shows up without a manual reload
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === null || e.key === HISTORY_KEY) engine.history = loadHistory();
  });
}

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
