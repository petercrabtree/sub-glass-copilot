<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    ariaLabel = 'Viewer controls',
    left,
    right,
  }: {
    ariaLabel?: string;
    left: Snippet;
    right?: Snippet;
  } = $props();
</script>

<nav class="viewer-top-rail" aria-label={ariaLabel}>
  <div class="viewer-top-rail__group viewer-top-rail__group--left">
    {@render left()}
  </div>

  {#if right}
    <div class="viewer-top-rail__group viewer-top-rail__group--right">
      {@render right()}
    </div>
  {/if}
</nav>

<style>
  .viewer-top-rail {
    position: fixed;
    z-index: 40;
    top: 0;
    left: 0;
    right: 0;
    display: flex;
    min-height: 38px;
    align-items: stretch;
    justify-content: space-between;
    gap: 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.07);
    background: rgba(8, 11, 15, 0.62);
    backdrop-filter: blur(20px) saturate(1.05);
    box-shadow: 0 16px 36px rgba(0, 0, 0, 0.22);
  }

  .viewer-top-rail__group {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 4px;
    padding: 4px 6px;
  }

  .viewer-top-rail__group--left {
    flex: 1 1 auto;
  }

  .viewer-top-rail__group--right {
    flex: 0 1 auto;
    justify-content: flex-end;
    max-width: min(64vw, 760px);
    border-left: 1px solid rgba(255, 255, 255, 0.07);
    overflow: visible;
  }

  .viewer-top-rail :global(.viewer-top-chip),
  .viewer-top-rail :global(.viewer-top-menu > summary) {
    display: inline-flex;
    min-height: 28px;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    background: rgba(255, 255, 255, 0.045);
    color: rgba(229, 241, 250, 0.86);
    font-size: 0.72rem;
    line-height: 1;
    white-space: nowrap;
  }

  .viewer-top-rail :global(.viewer-top-menu) {
    position: relative;
    min-width: 0;
  }

  .viewer-top-rail :global(.viewer-top-menu > summary) {
    list-style: none;
    cursor: pointer;
  }

  :global(.viewer-top-menu > summary::-webkit-details-marker) {
    display: none;
  }

  .viewer-top-rail :global(.viewer-top-menu[open] > summary),
  .viewer-top-rail :global(.viewer-top-menu > summary:hover),
  .viewer-top-rail :global(.viewer-top-menu > summary:focus-visible) {
    background: rgba(140, 199, 239, 0.14);
    border-color: rgba(140, 199, 239, 0.24);
    color: #edf6ff;
  }

  .viewer-top-rail :global(.viewer-top-panel) {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    display: grid;
    gap: 12px;
    width: min(360px, calc(100vw - 12px));
    padding: 10px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0 0 16px 0;
    background: rgba(8, 11, 15, 0.9);
    backdrop-filter: blur(22px) saturate(1.08);
    box-shadow: 0 24px 58px rgba(0, 0, 0, 0.36);
  }

  .viewer-top-rail :global(.viewer-menu-section) {
    min-width: 0;
    display: grid;
    gap: 8px;
  }

  .viewer-top-rail :global(.viewer-menu-label) {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    color: rgba(166, 178, 190, 0.86);
    font-size: 0.64rem;
    text-transform: uppercase;
  }

  @media (max-width: 760px) {
    .viewer-top-rail {
      display: grid;
      align-items: stretch;
    }

    .viewer-top-rail__group {
      width: 100%;
      max-width: none;
      overflow-x: auto;
    }

    .viewer-top-rail__group--right {
      border-left: 0;
      border-top: 1px solid rgba(255, 255, 255, 0.07);
      justify-content: flex-start;
    }

    .viewer-top-rail :global(.viewer-top-panel) {
      width: min(100vw, 380px);
    }

    .viewer-top-rail :global(.feed-scan-status) {
      display: none;
    }
  }
</style>
