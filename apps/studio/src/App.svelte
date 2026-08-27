<script lang="ts">
  import { engine, transportStatus } from "./lib/engine.svelte.js";
  import CreatePanel from "./components/CreatePanel.svelte";
  import ResultSheet from "./components/ResultSheet.svelte";
  import SettingsDrawer from "./components/SettingsDrawer.svelte";

  let showSettings = $state(false);
  const status = $derived(transportStatus());
  const statusLabel = $derived(
    status === "pi-bridge" ? "● pi-bridge"
    : status === "browser-key" ? "● browser-key"
    : "● offline",
  );
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
</style>
