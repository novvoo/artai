<script lang="ts">
  import { engine, transportStatus } from "./lib/engine.svelte.js";
  import CreatePanel from "./components/CreatePanel.svelte";
  import ResultSheet from "./components/ResultSheet.svelte";
  import SettingsDrawer from "./components/SettingsDrawer.svelte";
  import FloatingWindow from "./components/FloatingWindow.svelte";
  import StatusCapsule from "./components/StatusCapsule.svelte";

  let showSettings = $state(false);
  let logBox: HTMLDivElement | null = $state(null);
  const status = $derived(transportStatus());
  const statusLabel = $derived(
    status === "pi-bridge" ? "● pi-bridge"
    : status === "browser-key" ? "● browser-key"
    : "● offline",
  );

  // keep the newest activity line in view
  $effect(() => {
    void engine.log.length;
    if (logBox) logBox.scrollTop = logBox.scrollHeight;
  });
</script>

<div class="frame">
  <header>
    <span class="brand">artai <em>◌</em> studio</span>
    <nav class="hairline-top">
      <button class="tab" class:active={!showSettings} onclick={() => (showSettings = false)}>
        Create
      </button>
      <button
        class="tab"
        class:active={showSettings}
        onclick={() => (showSettings = true)}
      >
        ⚙ 模型设置
      </button>
      <span
        class="transport"
        title="LLM 传输状态：offline=未配置 · browser-key=浏览器直连 · pi-bridge=经本地 pi 协议桥（全 provider 目录）"
      >
        {statusLabel}
      </span>
    </nav>
  </header>

  {#if showSettings}
    <SettingsDrawer />
  {:else}
    <main>
      <CreatePanel />
      <ResultSheet />
    </main>
    {#if engine.error}
      <footer class="error">✗ {engine.error}</footer>
    {/if}
  {/if}

  <!-- floating capsule: always-on pipeline status, click toggles the log -->
  <StatusCapsule />

  {#if engine.logOpen}
    <FloatingWindow title="实时进展" bind:open={engine.logOpen} width={470} anchor="right">
      <div class="log" bind:this={logBox}>
        {#each engine.log as line}
          <div>{line}</div>
        {/each}
      </div>
    </FloatingWindow>
  {/if}

  {#if engine.lightbox}
    <FloatingWindow title="海报 · 全尺寸预览" bind:open={engine.lightboxOpen} width={680} anchor="center">
      <img class="lightbox-img" src={engine.lightbox} alt="generated zine poster full size" />
      <div class="lightbox-actions">
        <a class="lb-btn" href={engine.lightbox} download={`artai-poster-${engine.baseSeed}.png`}>download PNG</a>
      </div>
    </FloatingWindow>
  {/if}
</div>

<style>
  .frame {
    max-width: 980px;
    margin: 0 auto;
    padding: 24px;
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--hairline);
  }
  .brand {
    letter-spacing: 0.14em;
    font-size: 15px;
  }
  .brand em {
    color: var(--accent);
    font-style: normal;
  }
  nav {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .tab {
    background: none;
    border: none;
    padding: 6px 10px;
    cursor: pointer;
    color: var(--ink-soft);
    border-bottom: 2px solid transparent;
  }
  .tab.active {
    color: var(--ink);
    border-bottom-color: var(--accent);
  }
  .transport {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-soft);
    margin-left: 12px;
  }
  main {
    display: grid;
    grid-template-columns: minmax(300px, 380px) 1fr;
    gap: 32px;
    margin-top: 22px;
  }
  @media (max-width: 760px) {
    main {
      grid-template-columns: 1fr;
    }
  }
  .error {
    margin-top: 16px;
    color: #8a1f12;
    font-family: var(--mono);
    font-size: 12px;
  }
  .log {
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.7;
    color: var(--ink-soft, #6b675e);
    white-space: pre-wrap;
  }
  .lightbox-img {
    display: block;
    width: 100%;
    height: auto;
    border-radius: 6px;
    border: 1px solid rgba(26, 26, 26, 0.12);
  }
  .lightbox-actions {
    margin-top: 10px;
    display: flex;
    justify-content: flex-end;
  }
  .lb-btn {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink, #26241f);
    text-decoration: none;
    border: 1px solid var(--hairline, rgba(26,26,26,.2));
    padding: 4px 10px;
    border-radius: 4px;
  }
  .lb-btn:hover { border-color: var(--accent, #d8412f); }
</style>
