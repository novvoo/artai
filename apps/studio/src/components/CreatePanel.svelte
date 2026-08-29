<script lang="ts">
  import {
    engine,
    liveMotif,
    setLiveMotif,
    settings,
    providerLabel,
    transportStatus,
    imageCapable,
    detail as detailState,
    setDetailLevel,
    useCache,
    setUseCache,
    clearGenerationCache,
    cacheCount,
    PALETTES,
    paletteSel,
    setPalette,
    activePalette,
    imagePaletteState,
    applyImagePaletteFromFile,
    clearImagePalette,
  } from "../lib/engine.svelte.js";
  import { shade } from "artai/core";

  let cacheN = $state(cacheCount());
  let imgNote = $state("");
  function toggleCache(on: boolean): void {
    setUseCache(on);
    if (on) cacheN = cacheCount();
  }
  function wipeCache(): void {
    clearGenerationCache();
    cacheN = 0;
  }

  async function pickImage(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // allow re-picking the same file
    if (!file) return;
    imgNote = "解析中…";
    try {
      imgNote = await applyImagePaletteFromFile(file);
    } catch (err) {
      imgNote = err instanceof Error ? err.message : String(err);
    }
  }

  function rollSeed(): void {
    engine.baseSeed = Math.floor(Math.random() * 1_000_000);
  }
</script>

<section aria-label="create">
  <label for="theme">THEME</label>
  <textarea id="theme" rows="3" bind:value={engine.theme}></textarea>

  <span id="palette-label">PALETTE</span>
  <div class="img-palette-row">
    <label class="img-btn">
      <input type="file" accept="image/*" onchange={pickImage} />
      原始图片取色…
    </label>
    {#if imagePaletteState.current}
      <span class="chip" title={`从图片实测：accent ${imagePaletteState.current.accent} · paper ${imagePaletteState.current.paper}`}>
        <i style={`background:${shade(imagePaletteState.current.accent, 0.38)}`}></i>
        <i class="wide" style={`background:${imagePaletteState.current.accent}`}></i>
        <i style={`background:${imagePaletteState.current.paper}`}></i>
      </span>
      <span class="img-note">{imgNote || `${imagePaletteState.current.accent} · ${imagePaletteState.current.paper}`}</span>
      <button class="img-clear" onclick={() => { clearImagePalette(); imgNote = ""; }}
        title="清除图片取色，回到配色预设">✕</button>
    {/if}
  </div>
  <div class="palette-grid" role="radiogroup" aria-labelledby="palette-label">
    {#each PALETTES as p (p.id)}
      <button
        class="swatch"
        class:on={paletteSel.id === p.id}
        role="radio"
        aria-checked={paletteSel.id === p.id}
        onclick={() => setPalette(p.id)}
        title={p.accent ? `${p.label} · ${p.accent}` : "跟随模型情绪决策"}
      >
        {#if p.accent}
          <span class="chip">
            <i style={`background:${shade(p.accent, 0.38)}`}></i>
            <i class="wide" style={`background:${p.accent}`}></i>
            <i style={`background:${p.paper ?? "#F5F0E6"}`}></i>
          </span>
        {:else}
          <span class="chip auto"></span>
        {/if}
        <span class="pname">{p.label}</span>
      </button>
    {/each}
  </div>

  <div class="row">
    <label for="seed">SEED</label>
    <input id="seed" type="number" bind:value={engine.baseSeed} />
    <button onclick={rollSeed} title="随机基础种子">⟳</button>
    <select bind:value={engine.backend}>
      <option value="image" disabled={!imageCapable()}
        >AI 图像{imageCapable() ? "" : "（未配置图像模型）"}</option
      >
      <option value="render" disabled={!engine.webgl2}
        >render 预览{engine.webgl2 ? "" : "（无 WebGL2）"}</option
      >
      <option value="prompt">prompt 纯文本</option>
    </select>
  </div>

  <p class="intent-note" class:live={transportStatus() === "browser-key"}>
    {#if transportStatus() === "browser-key"}
      意图来源：<b>{providerLabel()}</b> — 模型负责主题解读与配色/情绪决策；同种子可复现，
      再次点击会派生新种子生成不同海报{#if activePalette()} · 配色已锁定：<b>{activePalette()!.label}</b>{/if}
    {:else}
      <b>尚未配置模型</b> — Web 版需要模型参与主题解读。请打开「⚙ 模型设置」完成配置。
    {/if}
  </p>

  <label class="llm">
    <input type="checkbox" checked={liveMotif.on}
      onchange={(e) => setLiveMotif((e.currentTarget as HTMLInputElement).checked)} />
    实时生成母题（LLM 绘制主体几何 · 关闭则使用内置画家）
  </label>

  <div class="cache-row">
    <label class="llm">
      <input type="checkbox" checked={useCache.on}
        onchange={(e) => toggleCache((e.currentTarget as HTMLInputElement).checked)} />
      使用生成缓存{cacheN > 0 ? ` · 已存 ${cacheN} 条` : ""}
    </label>
    {#if cacheN > 0}
      <button class="wipe" onclick={wipeCache} title="清空全部阶段结果（意图/母题/构图/prompt）">
        清空
      </button>
    {/if}
  </div>

  <div class="gen-row">
    <button class="generate" onclick={() => engine.generate()} disabled={engine.busy}>
      {engine.busy
        ? `… ${engine.stageLabelZh} · ${engine.elapsedSec}s`
        : "GENERATE"}
    </button>
    {#if engine.busy}
      <button class="stop" onclick={() => engine.stopRun()} disabled={engine.stopping}
        title="中断当前生成（已完成的阶段结果会保留）">
        {engine.stopping ? "停止中…" : "■ 停止"}
      </button>
    {/if}
  </div>
</section>

<style>
  .intent-note {
    font-size: 12px;
    line-height: 1.6;
    color: var(--ink-soft);
    background: var(--paper-raised);
    border-left: 3px solid var(--hairline);
    padding: 8px 10px;
    margin: 0;
  }
  .intent-note.live {
    border-left-color: var(--accent);
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  label {
    font-size: 11px;
    letter-spacing: 0.18em;
    color: var(--ink-soft);
  }
  textarea,
  input[type="number"] {
    background: var(--paper-raised);
    border: 1px solid var(--hairline);
    padding: 10px;
    resize: vertical;
  }
  .img-palette-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: -6px;
  }
  .img-btn {
    font-size: 11px;
    letter-spacing: 0.08em;
    color: var(--ink-soft);
    border: 1px dashed var(--hairline);
    padding: 4px 10px;
    cursor: pointer;
  }
  .img-btn:hover {
    border-color: var(--ink-soft);
    color: var(--ink);
  }
  .img-btn input {
    display: none;
  }
  .img-note {
    font-size: 10px;
    color: var(--ink-soft);
    font-family: var(--mono);
  }
  .img-clear {
    background: none;
    border: 1px solid var(--hairline);
    color: var(--ink-soft);
    font-size: 11px;
    padding: 1px 7px;
    cursor: pointer;
  }
  .img-clear:hover {
    border-color: #a33c1d;
    color: #a33c1d;
  }
  .palette-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .swatch {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    width: 62px;
    padding: 4px 3px 3px;
    background: none;
    border: 1px solid var(--hairline);
    border-radius: 2px;
    cursor: pointer;
  }
  .swatch:hover {
    border-color: var(--ink-soft);
  }
  .swatch.on {
    border-color: var(--ink);
    box-shadow: inset 0 0 0 1px var(--ink);
  }
  .chip {
    display: flex;
    width: 100%;
    height: 16px;
    border: 1px solid var(--hairline);
  }
  .chip i {
    flex: 1;
  }
  .chip i.wide {
    flex: 2;
  }
  .chip.auto {
    background: conic-gradient(
      from 210deg,
      #d8412f,
      #f2c230,
      #9bb53c,
      #00a6c8,
      #1b4fd8,
      #6a4fc7,
      #e23d81,
      #d8412f
    );
  }
  .pname {
    font-size: 10px;
    color: var(--ink-soft);
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .swatch.on .pname {
    color: var(--ink);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .row label {
    margin-top: 6px;
  }
  .row input {
    width: 110px;
    font-family: var(--mono);
  }
  select {
    background: none;
    border: 1px solid var(--hairline);
    padding: 6px 8px;
    color: var(--ink-soft);
  }
  .gen-row { display: flex; gap: 8px; }
  .gen-row .generate { flex: 1; }
  .stop {
    border: 1px solid rgba(163, 60, 29, 0.55);
    background: rgba(163, 60, 29, 0.08);
    color: #8a1f12;
    padding: 0 16px;
    cursor: pointer;
    letter-spacing: 0.08em;
    font-size: 12px;
  }
  .stop:hover:not(:disabled) { background: rgba(163, 60, 29, 0.16); }
  .stop:disabled { opacity: 0.5; cursor: default; }
  .generate {
    margin-top: 4px;
    padding: 12px;
    background: var(--ink);
    color: var(--paper);
    border: none;
    letter-spacing: 0.28em;
    cursor: pointer;
    transition:
      background 140ms ease,
      transform 120ms ease;
  }
  .generate:hover:not(:disabled) {
    background: var(--accent);
  }
  .generate:disabled {
    opacity: 0.55;
    cursor: wait;
  }
  .cache-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .cache-row .wipe {
    background: none;
    border: 1px solid var(--hairline);
    color: var(--ink-soft);
    font-size: 11px;
    padding: 3px 10px;
    cursor: pointer;
    letter-spacing: 0.08em;
  }
  .cache-row .wipe:hover {
    border-color: #a33c1d;
    color: #a33c1d;
  }
</style>
