<script lang="ts">
  import { engine, loadHistory, type HistoryEntry } from "../lib/engine.svelte.js";

  const fmt = (t: number): string => {
    const d = new Date(t);
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  let open = $state(false);
  // cap initial render at 20 entries; long histories (60+ cached runs) would
  // otherwise force the panel to lay out dozens of <img> thumbs on mobile
  let shown = $state(20);
  $effect(() => {
    if (engine.history.length <= 20) shown = engine.history.length;
  });
  const list = $derived(engine.history);

  function refresh(): void {
    engine.history = loadHistory();
    shown = Math.min(20, engine.history.length);
  }

  async function jump(entry: HistoryEntry): Promise<void> {
    open = false;
    await engine.restoreHistory(entry);
  }
</script>

<button
  class="hist-fab"
  onclick={() => { refresh(); open = !open; }}
  title="缓存的历史生成记录"
>
  ⏱ 历史{list.length ? ` ${list.length}` : ""}
</button>

{#if open}
  <div class="hist-panel">
    <header>
      <span>历史生成（缓存）</span>
      <button class="close" onclick={() => (open = false)} aria-label="关闭">✕</button>
    </header>
    {#if !list.length}
      <p class="empty">还没有历史记录 — 完成一次 GENERATE 后会出现在这里。</p>
    {:else}
      <ul>
        {#each list.slice(0, shown) as h (h.key + h.model)}
          <li>
            <button onclick={() => void jump(h)} disabled={engine.busy}
              title="点击恢复到这次生成的缓存状态">
              {#if h.thumb}
                <img src={h.thumb} alt="" />
              {:else}
                <span class="no-thumb">◌</span>
              {/if}
              <span class="meta">
                {#if h.prompt && h.prompt !== h.theme}
                  <b>{h.theme}</b>
                  <span class="prompt">{h.prompt}</span>
                {:else}
                  <span class="prompt strong">{h.prompt || h.theme}</span>
                {/if}
                {#if h.polishNotes.length}
                  <span class="notes">
                    {#each h.polishNotes as n}
                      <em title={n}>✦ {n}</em>
                    {/each}
                  </span>
                {/if}
                <small>{fmt(h.at)} · {h.layers} 层 · {h.shapes} shapes · {h.model}</small>
              </span>
            </button>
          </li>
        {/each}
      </ul>
      {#if list.length > shown}
        <button class="show-more" onclick={() => { shown = Math.min(shown + 20, list.length); }}>
          加载更早的 {Math.min(20, list.length - shown)} 条（共 {list.length}）
        </button>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .hist-fab {
    position: fixed;
    right: 18px;
    bottom: 64px;
    z-index: 80;
    padding: 7px 14px;
    border-radius: 999px;
    border: 1px solid rgba(26, 26, 26, 0.25);
    background: rgba(251, 247, 238, 0.9);
    backdrop-filter: blur(8px);
    box-shadow: 0 8px 22px rgba(26, 26, 26, 0.2);
    cursor: pointer;
    font-size: 12px;
    font-family: var(--mono);
  }
  .hist-fab:hover { border-color: var(--accent, #d8412f); }
  .hist-panel {
    position: fixed;
    right: 18px;
    bottom: 104px;
    z-index: 81;
    width: min(340px, calc(100vw - 24px));
    max-height: 62vh;
    overflow: auto;
    background: var(--paper, #fbf7ee);
    border: 1px solid rgba(26, 26, 26, 0.22);
    border-radius: 10px;
    box-shadow: 0 18px 48px rgba(26, 26, 26, 0.28);
  }
  header {
    position: sticky;
    top: 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    background: rgba(26, 26, 26, 0.05);
    border-bottom: 1px solid rgba(26, 26, 26, 0.12);
    font-size: 11px;
    letter-spacing: 0.14em;
    color: var(--ink-soft, #6b675e);
  }
  .close {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--ink-soft, #6b675e);
  }
  .close:hover { color: var(--accent, #d8412f); }
  .empty {
    padding: 18px 14px;
    font-size: 12px;
    color: var(--ink-soft, #6b675e);
  }
  ul { list-style: none; margin: 0; padding: 6px; }
  li button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 6px 8px;
    background: none;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
  }
  li button:hover:not(:disabled) { background: rgba(26, 26, 26, 0.06); }
  li button:disabled { opacity: 0.5; cursor: default; }
  li img, .no-thumb {
    width: 44px;
    height: 64px;
    object-fit: cover;
    border: 1px solid rgba(26, 26, 26, 0.15);
    border-radius: 4px;
    background: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ink-soft, #6b675e);
    flex: none;
  }
  .meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .meta b {
    font-size: 12.5px;
    color: var(--ink, #26241f);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta small {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--ink-soft, #6b675e);
  }
  .prompt {
    font-size: 11px;
    line-height: 1.5;
    color: var(--ink-soft, #6b675e);
    white-space: pre-wrap;
    word-break: break-word;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .prompt.strong { color: var(--ink, #26241f); font-weight: 600; }
  .notes { display: flex; flex-wrap: wrap; gap: 4px; }
  .notes em {
    font-style: normal;
    font-size: 10px;
    font-family: var(--mono);
    color: var(--accent, #d8412f);
    background: rgba(216, 65, 47, 0.07);
    border: 1px solid rgba(216, 65, 47, 0.25);
    border-radius: 999px;
    padding: 0 7px;
    max-width: 210px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .show-more {
    width: 100%;
    background: none;
    border: 1px dashed var(--hairline, rgba(26,26,26,.2));
    color: var(--ink-soft, #6b675e);
    font-size: 12px;
    padding: 10px;
    margin: 8px 12px 4px;
    cursor: pointer;
    /* breathing room from the FAB on mobile */
    width: calc(100% - 24px);
  }
  .show-more:hover { border-color: var(--accent, #d8412f); color: var(--accent, #d8412f); }
  /* mobile: history becomes a full-width sheet pinned to the bottom, with
   * extra padding so a finger hit on a row never collides with the FAB */
  @media (max-width: 520px) {
    .hist-panel {
      right: 8px;
      left: 8px;
      bottom: 92px;
      width: auto;
      max-height: 70vh;
      -webkit-overflow-scrolling: touch;
    }
    .hist-fab {
      width: 48px;
      height: 48px;
      font-size: 11px;
    }
    .row { padding: 10px 12px; }
    .row .meta { font-size: 11px; }
  }
</style>
