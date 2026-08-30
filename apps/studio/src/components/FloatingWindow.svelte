<script lang="ts">
  import type { Snippet } from "svelte";
  import { onMount } from "svelte";

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

  // background scroll lock while the panel is up — mobile touch would
  // otherwise scroll the page beneath the fullbleed panel and break the
  // "tap to dismiss / stay focused" contract.
  $effect(() => {
    if (typeof document === "undefined") return;
    const id = "__artai_fwin_lock";
    if (open) {
      if (document.getElementById(id)) return;
      const style = document.createElement("style");
      style.id = id;
      style.textContent = "html,body{overflow:hidden!important;touch-action:none;overscroll-behavior:contain}";
      document.head.appendChild(style);
    } else {
      document.getElementById(id)?.remove();
    }
  });
  onMount(() => () => {
    if (typeof document !== "undefined") document.getElementById("__artai_fwin_lock")?.remove();
  });
  /** clamped on resize so a desktop-sized width dragged on a phone stays
   * usable; never expands past the viewport edge */
  let effectiveWidth = $state(width);

  // place on first open — right-anchored panels hug the screen edge,
  // centered ones (lightbox) sit near the top like a classic dialog
  $effect(() => {
    if (open && !placed) {
      effectiveWidth = Math.min(width, Math.max(280, window.innerWidth - 24));
      x = anchor === "right"
        ? Math.max(12, window.innerWidth - effectiveWidth - 12)
        : Math.max(12, Math.round((window.innerWidth - effectiveWidth) / 2));
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
      const maxX = Math.max(8, window.innerWidth - effectiveWidth - 8);
      x = Math.max(8, Math.min(maxX, ev.clientX - sx));
      const maxY = Math.max(4, window.innerHeight - 80);
      y = Math.max(4, Math.min(maxY, ev.clientY - sy));
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
  <section class="fwin" class:dragging class:fullbleed={(typeof window !== "undefined") && window.innerWidth < 520}
    style="left:{x}px;top:{y}px;width:{effectiveWidth}px">
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
    -webkit-overflow-scrolling: touch;
  }
  /* mobile: stretch the window to the screen so a finger hit on the
   * lightbox image / log doesn't punch through transparent margins */
  @media (max-width: 520px) {
    .fwin.fullbleed {
      left: 6px !important;
      top: 64px !important;
      width: calc(100vw - 12px) !important;
      max-height: 80vh;
    }
    .fwin-bar { padding: 10px 14px; }
    .fwin-bar,
    .fwin-close { font-size: 13px; }
  }
</style>
