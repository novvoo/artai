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
  } from "../lib/engine.svelte.js";

  let cacheN = $state(cacheCount());
  function toggleCache(on: boolean): void {
    setUseCache(on);
    if (on) cacheN = cacheCount();
  }
  function wipeCache(): void {
    clearGenerationCache();
    cacheN = 0;
  }

  function rollSeed(): void {
    engine.baseSeed = Math.floor(Math.random() * 1_000_000);
  }
</script>

<section aria-label="create">
  <label for="theme">THEME</label>
  <textarea id="theme" rows="3" bind:value={engine.theme}></textarea>

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
      再次点击会派生新种子生成不同海报
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
