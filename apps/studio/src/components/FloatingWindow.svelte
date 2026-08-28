<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    title = "",
    open = $bindable(true),
    width = 440,
    anchor = "right",
    children,
  }: {
    title?: string;
    open?: boolean;
    width?: number;
    anchor?: "right" | "center";
    children?: Snippet;
  } = $props();

  let x = $state(0);
  let y = $state(0);
  let placed = $state(false);
  let dragging = $state(false);

  // place on first open — right-anchored panels hug the screen edge,
  // centered ones (lightbox) sit near the top like a classic dialog
  $effect(() => {
    if (open && !placed) {
      x = anchor === "right"
        ? Math.max(12, window.innerWidth - width - 24)
        : Math.max(12, Math.round((window.innerWidth - width) / 2));
      y = anchor === "center"
        ? Math.max(20, Math.round(window.innerHeight * 0.07))
        : 84;
      placed = true;
    }
    if (!open) placed = false;
  });

  function startDrag(e: PointerEvent): void {
    dragging = true;
    const sx = e.clientX - x;
    const sy = e.clientY - y;
    const move = (ev: PointerEvent): void => {
      if (!dragging) return;
      x = Math.max(-width + 90, Math.min(window.innerWidth - 70, ev.clientX - sx));
      y = Math.max(4, Math.min(window.innerHeight - 48, ev.clientY - sy));
    };
    const up = (): void => {
      dragging = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
</script>

{#if open}
  <section class="fwin" class:dragging style="left:{x}px;top:{y}px;width:{width}px">
    <header class="fwin-bar" role="toolbar" tabindex="0" aria-label="{title} — 拖动移动" onpointerdown={startDrag}>
      <span class="fwin-title">{title}</span>
      <button class="fwin-close" onclick={() => (open = false)} aria-label="关闭">✕</button>
    </header>
    <div class="fwin-body">{@render children?.()}</div>
  </section>
{/if}

<style>
  .fwin {
    position: fixed;
    z-index: 70;
    background: var(--paper, #fbf7ee);
    border: 1px solid rgba(26, 26, 26, 0.22);
    border-radius: 10px;
    box-shadow: 0 18px 48px rgba(26, 26, 26, 0.28);
    overflow: hidden;
  }
  .fwin-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 7px 12px;
    background: rgba(26, 26, 26, 0.05);
    border-bottom: 1px solid rgba(26, 26, 26, 0.12);
    cursor: grab;
    user-select: none;
  }
  .fwin.dragging .fwin-bar { cursor: grabbing; }
  .fwin-title {
    font-size: 11px;
    letter-spacing: 0.14em;
    color: var(--ink-soft, #6b675e);
  }
  .fwin-close {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 12px;
    color: var(--ink-soft, #6b675e);
    padding: 0 2px;
  }
  .fwin-close:hover { color: var(--accent, #d8412f); }
  .fwin-body {
    padding: 12px;
    max-height: 68vh;
    overflow: auto;
  }
</style>
