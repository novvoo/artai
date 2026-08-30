<script lang="ts">
  import { engine } from "../lib/engine.svelte.js";
  import { irToScript, scanPartialGraph } from "artai/core";
  import { paintGraphOntoCanvas } from "artai/render";

  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

  function downloadPng(url: string): void {
    const a = document.createElement("a");
    a.href = url;
    a.download = `artai-poster-${engine.baseSeed}.png`;
    a.click();
  }

  const motifOf = (env: { ir: { ops: Array<Record<string, unknown>> } }): string =>
    String(env.ir?.ops?.find((o: any) => o.op === "motif")?.id ?? "");

  /* ── live composition preview, two phases ──
     Phase 1 STREAMING: while the model writes the graph JSON, completed
     layer objects are harvested from engine.graphStreamText and painted
     onto the canvas immediately.
     Phase 2 REVEAL: once the full graph lands we replay depth-ordered
     layers with per-layer captions. Both phases run through
     drawGraphToCtx — the same engine the exported script executes. */
  let liveCanvas: HTMLCanvasElement | null = $state(null);
  /** poster-area live canvas — shows the streaming draft in place of the
   * static PNG while a composition (first run or 继续打磨) is in flight */
  let posterLiveCanvas: HTMLCanvasElement | null = $state(null);
  let revealN = $state(0);
  let playing = $state(false);
  let replayTick = $state(0);
  let drawnLiveN = -1;

  /* ── preview video export (ffmpeg.wasm) ── */
  let exportingVideo = $state(false);
  let videoStage = $state("");

  async function downloadPreviewVideo(): Promise<void> {
    if (!engine.graph || exportingVideo) return;
    const env = engine.envelope;
    if (!env) return;
    exportingVideo = true;
    videoStage = "准备…";
    try {
      const { exportPreviewVideo } = await import("../lib/previewVideo.js");
      const blob = await exportPreviewVideo({
        graph: engine.graph,
        ir: env.ir,
        width: env.ir.canvas.width,
        height: env.ir.canvas.height,
        seed: Number(env.meta?.seedUsed ?? 1),
        paletteHexes: engine.graph.paletteLocked ?? [],
        onProgress: (stage, pct) => {
          videoStage = `${stage} ${Math.round(pct * 100)}%`;
        },
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `artai-preview-${engine.baseSeed}.mp4`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const hint = /Failed to fetch dynamically imported module/i.test(msg)
        ? "（dev 环境：请重启 dev server，让 Vite 预打包新安装的 ffmpeg 依赖）"
        : "";
      engine.error = `预览视频导出失败：${msg}${hint}`;
    } finally {
      exportingVideo = false;
      videoStage = "";
    }
  }

  const sortedLayers = $derived.by(() => {
    const g = engine.graph;
    if (!g) return [] as Array<{ id: string; label: string; depth: number; shapes: unknown[] }>;
    return [...g.layers].sort(
      (a: any, b: any) => Number(a.depth ?? 0) - Number(b.depth ?? 0),
    );
  });

  // incremental harvest of the in-flight stream (null when not streaming).
  // During 继续打磨 the old graph is still on file, so the polishing flag
  // explicitly opens the streaming phase — otherwise the canvas would sit
  // frozen on the previous version for the whole round.
  const livePartial = $derived.by(() => {
    if (!engine.graphStreamText || !engine.graphLiveBase) return null;
    if (engine.graph && !engine.polishing) return null;
    return scanPartialGraph(engine.graphStreamText);
  });

  function paint(target: HTMLCanvasElement | null, layers: unknown[], lightDeg: number | null): void {
    const c = target;
    const base = engine.graphLiveBase ?? {
      width: Number(engine.envelope?.ir?.canvas?.width ?? 1200),
      height: Number(engine.envelope?.ir?.canvas?.height ?? 2000),
      seed: Number(engine.envelope?.meta?.seedUsed ?? 1),
      paletteHexes: [] as string[],
    };
    if (!c || !layers.length) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    c.width = base.width;
    c.height = base.height;
    // graph pixels + the SAME typography overlay the exported poster gets —
    // the reveal's last frame and the final PNG are pixel-identical
    paintGraphOntoCanvas(ctx,
      { lightDeg: lightDeg ?? 145, layers, paletteLocked: base.paletteHexes } as any,
      engine.envelope?.ir ?? null,
      { width: base.width, height: base.height, seed: base.seed >>> 0 });
  }

  function startReveal(): void {
    if (!sortedLayers.length) return;
    revealN = 0;
    playing = true;
    const perLayer = Math.max(150, Math.round(2200 / Math.min(sortedLayers.length, 8)));
    const step = (): void => {
      if (revealN >= sortedLayers.length || !liveCanvas) {
        playing = false;
        return;
      }
      revealN++;
      paint(liveCanvas, sortedLayers.slice(0, revealN), engine.graph?.lightDeg ?? null);
      setTimeout(step, perLayer);
    };
    setTimeout(step, 80);
  }

  // phase 1 — while streaming, repaint whenever a new layer object completes;
  // during 继续打磨 the poster area mirrors the live draft so the user sees
  // the image changing in real time instead of waiting for the round to end
  $effect(() => {
    const p = livePartial;
    if (!p) { drawnLiveN = -1; return; }
    if (p.layers.length !== drawnLiveN) {
      drawnLiveN = p.layers.length;
      paint(liveCanvas, p.layers as unknown[], p.lightDeg);
      paint(posterLiveCanvas, p.layers as unknown[], p.lightDeg);
    }
  });



  // phase 2 — replay whenever a new graph lands (or the user hits 重播)
  $effect(() => {
    void replayTick;
    if (engine.graph && sortedLayers.length) startReveal();
  });
</script>

<section aria-label="result">
  {#if !engine.envelope}
    <p class="empty">生成结果将出现在这里 — 输入主题，按下 GENERATE。</p>
  {:else}
    {@const env = engine.envelope}
    <!-- poster image / live draft -->
    {#if livePartial}
      <figure class="poster-mat">
        <canvas bind:this={posterLiveCanvas}
          style:width={`${Math.round(env.ir.canvas.width / 2.4)}px`}></canvas>
        <figcaption class="mono">
          ✦ 实时构图{engine.polishing ? "（打磨中）" : ""} — 已落层 {livePartial.layers.length}
        </figcaption>
      </figure>
    {:else if engine.pngUrl}
      <figure class="poster-mat">
        <button class="poster-zoom" onclick={() => { engine.lightbox = engine.pngUrl; engine.lightboxOpen = true; }}
          title="点击查看全尺寸">
          <img src={engine.pngUrl} alt="generated zine poster"
            style:max-height="62vh" style:width="auto" />
        </button>
        <figcaption class="mono">
          {env.ir.canvas.width}×{env.ir.canvas.height}px · renderer:{engine.rendererName}
          {engine.renderWarnings.length ? ` · ${engine.renderWarnings.length} warnings` : ""}
          {engine.polishRound > 0 ? ` · ✦ 已打磨 ${engine.polishRound} 轮` : ""}
          <button onclick={() => engine.pngUrl && downloadPng(engine.pngUrl)}>download PNG</button>
        </figcaption>
      </figure>
    {:else if env.gate.pass}
      <p class="mono switch">当前为 prompt 后端 — 切到 render 后端可同时得到图片。</p>
    {/if}

    <!-- gate readout -->
    <div class="gate" class:failing={!env.gate.pass}>
      {#if env.gate.pass}
        ✓ gate · air {pct(env.gate.measured.negativeSpace)} · cluster
        {pct(env.gate.measured.clusterShare)} · accent ≈{pct(env.gate.measured.accentShareEstimate)}
        <span class="src">intent: {env.meta.intentSource}</span>
      {:else}
        ⚠ degraded ({env.meta.attempts} attempts):
        {#each env.gate.violations as v}<span class="chip">{v.code}</span>{/each}
      {/if}
    </div>

    <!-- recipe line -->
    <p class="recipe-line mono">
      [{env.recipe.layout.family} / {env.recipe.focal.form} / {env.recipe.type.mode} /
      {env.recipe.color.name} {env.recipe.color.hue} via {env.recipe.color.carrier} /
      {env.recipe.texture.mode} / {env.recipe.mood}] seed={env.meta.seedUsed}
      <span class="chip">motif: {motifOf(env)}</span>
      <span class="chip">metaphor: {env.recipe.metaphor.subject}</span>
      intent: <b>{env.meta.intentSource}</b>
    </p>

    <!-- tabs -->
    <details open>
      <summary>
        LLM 增强代码（GRAPH → Canvas-2D）
        {#if engine.graph}· {engine.graph.layers.length} 层 · <span class="ok">实时预览</span>{/if}
        {#if livePartial}· <span class="streaming">✦ 流式接收中 {livePartial.layers.length} 层</span>{/if}
      </summary>
      {#if engine.graphFailed}
        <p class="warn">⚠ 构图失败（已回退到 RAW 基线代码）：{engine.graphFailed}</p>
      {/if}
      {#if engine.graphScript || livePartial}
        <div class="graph-preview-row">
          <figure class="graph-preview">
            <figcaption>
              {#if livePartial}
                ✦ 模型正在构图 — 已落层 {livePartial.layers.length}
              {:else if playing}
                ▦ 逐层绘制中 {revealN}/{sortedLayers.length}
              {:else if sortedLayers.length}
                ✓ 完成 · 与复制代码同引擎
              {:else}
                GRAPH 渲染预览
              {/if}
              {#if livePartial && livePartial.layers.length}
                <br />{String((livePartial.layers[livePartial.layers.length - 1] as any)?.id ?? "")}：
                {String((livePartial.layers[livePartial.layers.length - 1] as any)?.label ?? "")}
              {:else if revealN > 0 && sortedLayers[revealN - 1]}
                <br />d{sortedLayers[revealN - 1]!.depth} ·
                {sortedLayers[revealN - 1]!.id}：
                {sortedLayers[revealN - 1]!.label}
              {/if}
            </figcaption>
            <canvas bind:this={liveCanvas} style:width="150px"></canvas>
            {#if !playing && !livePartial && sortedLayers.length > 1}
              <button class="replay" onclick={() => replayTick++}>重播</button>
            {/if}
            {#if sortedLayers.length}
              <button class="replay" onclick={() => void downloadPreviewVideo()} disabled={exportingVideo}
                title="把逐层实时预览录制并编码为 MP4（本地 ffmpeg.wasm，无需联网）">
                {exportingVideo ? `⏺ ${videoStage}` : "⬇ 导出预览视频 MP4"}
              </button>
            {/if}
          </figure>
          <div class="graph-meta mono">
            {#if engine.graph && !livePartial}
              <p>lightDeg: <b>{engine.graph.lightDeg}</b></p>
              <p>paletteLocked: <span class="chips">
                {#each engine.graph.paletteLocked as hx}<span class="swatch" style:background={hx} title={hx}></span>{/each}
              </span></p>
              <p>layers:</p>
              <ul>
                {#each engine.graph.layers as l}
                  <li>d{l.depth} · {l.id} · {l.shapes.length} shapes</li>
                {/each}
              </ul>
            {:else if livePartial}
              <p>✦ 增量接收（流式）：</p>
              <ul>
                {#each livePartial.layers as l, i}
                  <li>{i + 1}. {String(l.id ?? "?")} · {Array.isArray(l.shapes) ? l.shapes.length : "?"} shapes</li>
                {/each}
              </ul>
            {/if}
          </div>
        </div>
        {#if engine.graphScript}<pre class="mono sheet">{engine.graphScript}</pre>{/if}
      {/if}
    </details>

    <details><summary>RAW 基线代码（Canvas-2D · 确定性引擎）</summary>
      <pre class="mono sheet">{(typeof irToScript === 'function') ? irToScript(env.ir) : '(loading)'}</pre>
    </details>

    <details><summary>PROMPT · 全规格（30+ 段）</summary>
      <pre class="mono sheet">{engine.fullSpec ?? ''}</pre>
    </details>

    <details><summary>PROMPT · 精简四段 ● AI润色后</summary>
      <pre class="mono sheet">{env.prompt}</pre>
    </details>

    <details><summary>SCENE IR JSON</summary>
      <pre class="mono sheet">{JSON.stringify(env.ir, null, 2)}</pre>
    </details>

    <details><summary>RECIPE JSON</summary>
      <pre class="mono sheet">{JSON.stringify(env.recipe, null, 2)}</pre>
    </details>

    <div class="actions hairline-top">
      {#if engine.graph && !engine.graphFailed}
        <input
          class="polish-note"
          placeholder="打磨建议（可选）：例如「把主体移到左下」「加一只猫」"
          bind:value={engine.polishNote}
          onkeydown={(e) => { if (e.key === "Enter" && !engine.busy) void engine.polish(); }}
        />
        <button
          class="polish"
          onclick={() => void engine.polish()}
          disabled={engine.busy}
          title="以当前终稿为基础：艺术总监批评 → 模型修订 → 刷新预览与成图。可反复点击持续提升"
        >
          {engine.busy && engine.polishing
            ? `✦ 打磨中… 第${Math.max(1, engine.polishRound)}轮`
            : engine.polishRound > 0
              ? `✦ 继续打磨（已打磨 ${engine.polishRound} 轮）`
              : "✦ 继续打磨（以终稿为基础）"}
        </button>
      {/if}
      {#if engine.graphScript}
        <button onclick={() => engine.graphScript && navigator.clipboard.writeText(engine.graphScript)}>copy 增强代码（GRAPH）</button>
      {/if}
      <button onclick={() => navigator.clipboard.writeText(env.prompt)}>copy prompt</button>
      <button onclick={() => navigator.clipboard.writeText(JSON.stringify(env.recipe))}>copy recipe</button>
    </div>
  {/if}
</section>

<style>
section { min-height: 420px; }
.empty { color: var(--ink-soft); border: 1px dashed var(--hairline); padding: 48px 24px; text-align: center; }
.poster-mat {
  margin: 0 0 16px;
  padding: 14px;
  background: #ffffff;
  border: 1px solid var(--hairline);
  box-shadow: 0 1px 0 rgba(26,26,26,.08);
  /* poster must FILL the column on mobile (no tiny inline thumbnail) while
   * preserving its 3:5 ratio — width set by container, height derives */
  width: 100%;
  max-width: 100%;
}
.poster-mat img {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 3 / 5;
  object-fit: contain;
  border: 1px solid rgba(26,26,26,.12); border-radius: 8px;
  cursor: zoom-in; transition: box-shadow .18s, transform .18s;
}
.poster-mat .poster-zoom {
  display: block; padding: 0; border: none; background: none; cursor: zoom-in;
  width: 100%;
}
.poster-mat .poster-zoom:hover img {
  box-shadow: 0 14px 36px rgba(26,26,26,.22);
  transform: translateY(-2px);
}
.poster-mat canvas {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 3 / 5;
  border-radius: 8px;
}
.poster-mat figcaption { margin-top: 8px; font-size: 11px; color: var(--ink-soft); display: flex; gap: 10px; align-items: center; }
.poster-mat button { background: none; border: 1px solid var(--hairline); padding: 3px 10px; cursor: pointer; font-size: 11px; }
.poster-mat button:hover { border-color: var(--accent); }
.gate { font-family: var(--mono); font-size: 12px; padding: 8px 10px; background: var(--paper-raised); border-left: 3px solid #3e6b34; margin-bottom: 10px; }
.gate.failing { border-left-color: #a33c1d; }
.chip { display: inline-block; background: var(--paper); border: 1px solid var(--hairline); padding: 1px 6px; margin-left: 4px; }
.src { float: right; color: var(--ink-soft); }
.recipe-line { font-size: 11.5px; color: var(--ink-soft); margin: 0 0 6px; }
.sheet { white-space: pre-wrap; background: var(--paper-raised); border: 1px solid var(--hairline); padding: 14px; font-size: 12.5px; line-height: 1.65; max-height: 320px; overflow: auto; -webkit-overflow-scrolling: touch; }
.mono { font-family: var(--mono); }
.actions { padding-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
.actions button { background: none; border: 1px solid var(--hairline); padding: 7px 14px; cursor: pointer; letter-spacing: .08em; }
.actions button:hover { border-color: var(--accent); }
  .polish-note {
    flex: 1 1 240px;
    border: 1px solid var(--hairline);
    background: none;
    padding: 7px 12px;
    font-size: 12px;
    color: var(--ink, #26241f);
  }
  .polish-note:focus { outline: none; border-color: var(--accent, #d8412f); }
  .actions .polish { border-color: var(--accent); color: var(--accent); }
.actions .polish:hover { background: rgba(216,65,47,.06); }
.actions button:disabled { opacity: .5; cursor: default; }
.actions button:disabled:hover { border-color: var(--hairline); }
.actions .polish:disabled:hover { border-color: var(--accent); background: none; }
.switch { font-size: 12px; color: var(--ink-soft); background: var(--paper-raised); border: 1px solid var(--hairline); padding: 8px 12px; margin-bottom: 12px; }
.warn { font-size: 12px; color: #a33c1d; background: rgba(163,60,29,.06); border: 1px solid rgba(163,60,29,.3); padding: 8px 12px; margin-bottom: 10px; }
.ok { color: #3e6b34; }
.streaming { color: var(--accent); }
.graph-preview-row { display: flex; gap: 16px; margin-bottom: 10px; align-items: flex-start; }
.graph-preview { margin: 0; padding: 8px; background: #fff; border: 1px solid var(--hairline); }
.graph-preview canvas { display: block; border: 1px solid rgba(26,26,26,.12); image-rendering: auto; }
.graph-preview figcaption { margin-top: 6px; font-size: 10.5px; color: var(--ink-soft); line-height: 1.5; }
.graph-preview .replay {
  margin-top: 6px; width: 100%; background: none;
  border: 1px solid var(--hairline); color: var(--ink-soft);
  font-size: 10.5px; padding: 3px 0; cursor: pointer; letter-spacing: .08em;
}
.graph-preview .replay:hover { border-color: var(--accent); color: var(--ink); }
.graph-meta { font-size: 11.5px; color: var(--ink-soft); }
.graph-meta p { margin: 0 0 4px; }
.graph-meta ul { margin: 2px 0 0; padding-left: 16px; }
.graph-meta li { margin: 1px 0; }
.chips { display: inline-flex; gap: 4px; vertical-align: middle; }
.swatch { display: inline-block; width: 12px; height: 12px; border: 1px solid rgba(26,26,26,.25); }
details { margin-bottom: 8px; }
summary { cursor: pointer; font-size: 11px; letter-spacing: .18em; color: var(--ink-soft); }
</style>
