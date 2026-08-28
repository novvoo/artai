<script lang="ts">
  import { engine } from "../lib/engine.svelte.js";

  const label = $derived(
    engine.busy
      ? `${engine.stageLabelZh} · ${engine.elapsedSec}s`
      : engine.polishRound > 0
        ? `✓ 已打磨 ${engine.polishRound} 轮`
        : engine.pngUrl
          ? "✓ 海报就绪"
          : "待生成",
  );
</script>

<button
  class="capsule"
  class:busy={engine.busy}
  onclick={() => (engine.logOpen = !engine.logOpen)}
  title="点击展开/收起实时进展"
>
  <span class="dot" class:spin={engine.busy}>◌</span>
  <span class="label">{label}</span>
  {#if engine.log.length}
    <span class="count">{engine.log.length}</span>
  {/if}
</button>

<style>
  .capsule {
    position: fixed;
    right: 18px;
    bottom: 18px;
    z-index: 80;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 16px;
    border-radius: 999px;
    border: 1px solid rgba(26, 26, 26, 0.25);
    background: rgba(251, 247, 238, 0.9);
    backdrop-filter: blur(8px);
    box-shadow: 0 10px 30px rgba(26, 26, 26, 0.25);
    cursor: pointer;
    font-size: 12px;
    transition: border-color 0.15s, transform 0.15s;
  }
  .capsule:hover {
    border-color: var(--accent, #d8412f);
    transform: translateY(-1px);
  }
  .capsule.busy {
    border-color: var(--accent, #d8412f);
  }
  .dot {
    color: var(--accent, #d8412f);
    font-size: 13px;
    line-height: 1;
  }
  .dot.spin {
    display: inline-block;
    animation: rot 1.1s linear infinite;
  }
  @keyframes rot {
    to { transform: rotate(360deg); }
  }
  .label {
    font-family: var(--mono);
    color: var(--ink, #26241f);
    max-width: 250px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    font-family: var(--mono);
    font-size: 10px;
    background: rgba(26, 26, 26, 0.08);
    border-radius: 999px;
    padding: 1px 7px;
    color: var(--ink-soft, #6b675e);
  }
</style>
