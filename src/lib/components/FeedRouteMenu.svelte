<script lang="ts">
  import { ChevronDown } from 'lucide-svelte';
  import type { FeedRecipe } from '$lib/types';

  type FeedOption = {
    name: string;
    label: string;
  };

  let {
    feedName,
    recipe,
    options,
  }: {
    feedName: string;
    recipe?: FeedRecipe;
    options: readonly FeedOption[];
  } = $props();

  const sortSummary = $derived(
    recipe
      ? recipe.listingSort === 'top' || recipe.listingSort === 'controversial'
        ? `${recipe.listingSort} / ${recipe.listingTime}`
        : recipe.listingSort
      : '...'
  );
</script>

<details class="viewer-top-menu feed-menu">
  <summary class="feed-route-chip" aria-label={`Current feed ${feedName}`}>
    <span>feed</span>
    <strong>{feedName}</strong>
    <ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
  </summary>

  <div class="viewer-top-panel feed-panel">
    <div class="viewer-menu-section">
      <span class="viewer-menu-label">feeds</span>
      <div class="feed-switcher" aria-label="Local feeds">
        {#each options as option}
          <a href="/feed/{option.name}" class:active={feedName === option.name}>{option.label}</a>
        {/each}
      </div>
    </div>

    <div class="viewer-menu-section">
      <span class="viewer-menu-label">recipe</span>
      <div class="recipe-grid">
        <span>mode</span>
        <strong>{recipe?.sourceMode ?? '...'}</strong>
        <span>sort</span>
        <strong>{sortSummary}</strong>
        <span>sources</span>
        <strong>{recipe?.sourceCount ?? '...'}</strong>
        <span>target</span>
        <strong>{recipe?.targetQueueSize ?? '...'}</strong>
      </div>
    </div>
  </div>
</details>

<style>
  :global(.viewer-top-panel.feed-panel) {
    width: min(420px, calc(100vw - 12px));
  }

  .feed-route-chip {
    gap: 6px;
    padding: 0 8px;
  }

  .feed-route-chip span {
    color: rgba(166, 178, 190, 0.86);
  }

  .feed-route-chip strong {
    color: rgba(154, 211, 247, 0.92);
  }

  .feed-switcher {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .feed-switcher a {
    min-height: 30px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.05);
    color: rgba(229, 241, 250, 0.86);
    font-size: 0.74rem;
    padding: 0 9px;
    text-decoration: none;
  }

  .feed-switcher a.active {
    background: rgba(140, 199, 239, 0.16);
    border-color: rgba(140, 199, 239, 0.3);
    color: #edf6ff;
  }

  .recipe-grid {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 7px 12px;
    padding: 8px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.04);
    color: rgba(166, 178, 190, 0.9);
    font-size: 0.72rem;
  }

  .recipe-grid strong {
    min-width: 0;
    overflow: hidden;
    color: #edf5fc;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
