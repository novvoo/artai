<script lang="ts">
  import {
    settings,
    saveSettings,
    clearKeys,
    presetDefaults,
    testConnection,
    resolveWireKind,
    imageGen,
    saveImageGen,
    type StoredModelConfig,
  } from "../lib/engine.svelte.js";

  const PRESETS = ["openrouter", "openai", "anthropic", "pi-node", "custom"] as const;

  let status = $state("");
  let testing = $state(false);

  let wireKind = $derived(
    settings.preset === "" ? null : settings.preset === "custom" ? (settings.wireKind ?? "auto") : resolveWireKind(),
  );

  function onPresetChange(): void {
    if (settings.preset !== "custom") {
      const d = presetDefaults(settings.preset);
      settings.baseUrl = d.baseUrl;
      settings.model = d.model;
      settings.wireKind = "auto";
    }
    status = "";
    saveSettings();
  }

  function setWire(v: string): void {
    if (v === "auto") {
      delete (settings as { wireKind?: string }).wireKind;
    } else {
      (settings as { wireKind: string | undefined }).wireKind = v;
    }
    status = "";
    saveSettings();
  }

  async function runTest(): Promise<void> {
    testing = true;
    status = "… 测试中";
    try {
      status = await testConnection();
    } finally {
      testing = false;
    }
  }
</script>

<section aria-label="model settings">
  <h2>模型配置 <small>BYOK · 密钥只保存在本机 localStorage，请求由浏览器直连所选服务商</small></h2>

  <div class="grid">
    <label for="preset">PRESET</label>
    <select id="preset" bind:value={settings.preset} onchange={onPresetChange}>
      <option value="">— 未配置 —</option>
      {#each PRESETS as p}
        <option value={p}>{p}</option>
      {/each}
    </select>

    <label for="baseurl">BASE URL</label>
    <input id="baseurl" class="mono" bind:value={settings.baseUrl} placeholder="https://…/v1" />

    <label for="apikey">API KEY</label>
    {#if settings.preset === "pi-node"}
      <input id="apikey" disabled placeholder="由本机 pi 管理认证 — pi /login 或环境变量，此处留空" />
      <span class="hint">bridge 会把每个请求路由给本机 pi 的 provider 目录（含订阅复用）。MODEL ID 填 provider/model 形式。</span>
    {:else}
      <input id="apikey" type="password" bind:value={settings.apiKey} autocomplete="off" />
    {/if}

    <label for="model">MODEL ID</label>
    <input id="model" class="mono" bind:value={settings.model} placeholder="provider/model" />

    {#if wireKind}
      <label for="wire">WIRE FORMAT</label>
      <div class="wire">
        {#if settings.preset === "custom"}
          <select
            id="wire"
            value={settings.wireKind ?? "auto"}
            onchange={(e) => setWire((e.currentTarget as HTMLSelectElement).value)}
          >
            <option value="auto">auto（按 URL 嗅探）</option>
            <option value="openai-compatible">openai-compatible · /chat/completions</option>
            <option value="anthropic">anthropic 原生 · /messages + x-api-key</option>
          </select>
        {:else}
          <code class="mono fixed">{wireKind}</code>
          {#if wireKind === "anthropic"}
            <span class="hint">Anthropic /messages · assistant 预填 {"{"} 强制 JSON 开头</span>
          {:else}
            <span class="hint">/chat/completions · Bearer（openrouter 路由 Claude 模型也走此格式）</span>
          {/if}
        {/if}
      </div>

    <label for="imgmodel">IMAGE MODEL</label>
    {#if resolveWireKind() === "anthropic"}
      <input id="imgmodel" disabled placeholder="不可用 — anthropic 无图像接口" />
    {:else}
      <input
        id="imgmodel"
        class="mono"
        bind:value={imageGen.model}
        placeholder="gpt-image-1（留空使用默认）"
        onblur={saveImageGen}
      />
    {/if}
    {/if}
  </div>

  <p class="note">
    anthropic preset 会自动携带
浏览器直连所需的 CORS 头；OpenRouter 对浏览器调用最友好。
    分享链接与导出的 recipe/envelope 按构造不含密钥。
  </p>

  <p class="note pi-node">
    「pi-node」已接入：<code>npm run dev</code> 会自动随 Studio 启动本地桥
    （@earendil-works/pi-coding-agent，端口 8787）。认证用 pi 自带的 <code>pi /login</code>
    或环境变量 API key；也可单独运行 <code>npm run bridge</code>。十余家 provider 与订阅复用即刻可用。
  </p>

  <div class="row">
    <button onclick={() => { saveSettings(); status = "已保存到本地。"; }}>保存到本机</button>
    <button onclick={runTest} disabled={testing}>{testing ? "…" : "测试连接"}</button>
    <button class="danger" onclick={() => { clearKeys(); status = "密钥已清除。"; }}>
      清除密钥
    </button>
  </div>

  {#if status}
    <p class="status mono">{status}</p>
  {/if}
</section>

<style>
  section {
    max-width: 640px;
    margin-top: 20px;
  }
  h2 {
    font-size: 17px;
    letter-spacing: 0.06em;
    margin: 0 0 4px;
  }
  h2 small {
    display: block;
    font-weight: normal;
    color: var(--ink-soft);
    font-size: 12px;
    line-height: 1.6;
    margin-top: 5px;
    letter-spacing: 0;
  }
  .grid {
    display: grid;
    grid-template-columns: 118px 1fr;
    gap: 12px 16px;
    align-items: center;
    margin: 18px 0;
  }
  label {
    font-size: 10.5px;
    letter-spacing: 0.14em;
    color: var(--ink-soft);
  }
  input,
  select {
    background: var(--paper-raised);
    border: 1px solid var(--hairline);
    padding: 9px 12px;
    font-size: 13.5px;
    width: 100%;
  }
  input::placeholder {
    color: rgba(85, 82, 75, 0.55);
    font-size: 12.5px;
  }
  input:focus,
  select:focus {
    outline: none;
    border-color: var(--accent);
  }
  /* hints sit under their input, aligned to the value column */
  .grid .hint,
  .grid span.hint {
    grid-column: 2;
    justify-self: start;
    display: inline-block;
    margin-top: -7px;
  }
  .hint {
    font-size: 11.5px;
    line-height: 1.55;
    color: var(--ink-soft);
  }
  .wire {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .wire select {
    min-width: 260px;
    width: auto;
  }
  .wire .fixed {
    font-family: var(--mono);
    font-size: 12.5px;
    color: var(--accent);
  }
  .mono {
    font-family: var(--mono);
  }
  input.mono {
    font-family: var(--mono);
    font-size: 13px;
  }
  .row {
    display: flex;
    gap: 10px;
    margin: 16px 0;
  }
  button {
    background: none;
    border: 1px solid var(--hairline);
    padding: 8px 18px;
    cursor: pointer;
    font-size: 13px;
    letter-spacing: 0.05em;
  }
  button:hover {
    border-color: var(--accent);
  }
  .danger:hover {
    border-color: #a33c1d;
    color: #8a1f12;
  }
  .note {
    color: var(--ink-soft);
    font-size: 12px;
    line-height: 1.75;
  }
  .note code {
    font-family: var(--mono);
    font-size: 11.5px;
    background: var(--paper-raised);
    border: 1px solid var(--hairline);
    padding: 1px 5px;
  }
  .pi-node {
    margin-top: 22px;
    border-top: 1px solid var(--hairline);
    padding-top: 14px;
  }
  .status {
    background: var(--paper-raised);
    border: 1px solid var(--hairline);
    padding: 10px 12px;
    font-size: 12.5px;
    line-height: 1.65;
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
