<script lang="ts">
  import { ChevronDown } from 'lucide-svelte';
  import { getFeedRoutePath, type FeedRouteSpec } from '$lib/feed/routes';
  import {
    REDDIT_LISTING_SORTS,
    REDDIT_LISTING_TIMES,
    formatRedditListingSummary,
    redditListingSortUsesTime,
  } from '$lib/reddit/listing';
  import type { FeedRecipe } from '$lib/types';

  type FeedOption = {
    name: string;
    label: string;
  };

  let {
    routeSpec,
    recipe,
    options,
  }: {
    routeSpec: FeedRouteSpec;
    recipe?: FeedRecipe;
    options: readonly FeedOption[];
  } = $props();

  const feedName = $derived(routeSpec.feedName);
  const sortSummary = $derived(recipe ? routeSpec.sourceSummary : '...');
  const sourceUsesTime = $derived(redditListingSortUsesTime(routeSpec.listingSort));

  function getFeedPath(name: string): string {
    return getFeedRoutePath({
      feedName: name,
      listingSort: routeSpec.listingSort,
      listingTime: routeSpec.listingTime,
    });
  }

  function getSortPath(sort: FeedRouteSpec['listingSort']): string {
    return getFeedRoutePath({
      feedName,
      listingSort: sort,
      listingTime: routeSpec.listingTime,
    });
  }

  function getTimePath(time: FeedRouteSpec['listingTime']): string {
    return getFeedRoutePath({
      feedName,
      listingSort: routeSpec.listingSort,
      listingTime: time,
    });
  }
</script>

<details class="viewer-top-menu feed-menu">
  <summary class="feed-route-chip" aria-label={`Current feed ${feedName} ${routeSpec.sourceSummary}`}>
    <span>feed</span>
    <strong>{feedName}</strong>
    <em>{routeSpec.sourceSummary}</em>
    <ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
  </summary>

  <div class="viewer-top-panel feed-panel">
    <div class="viewer-menu-section">
      <span class="viewer-menu-label">feeds</span>
      <div class="feed-switcher" aria-label="Local feeds">
        {#each options as option}
          <a href={getFeedPath(option.name)} class:active={feedName === option.name}>{option.label}</a>
        {/each}
      </div>
    </div>

    <div class="viewer-menu-section">
      <span class="viewer-menu-label">source</span>
      <div class="feed-switcher" aria-label="Source listing">
        {#each REDDIT_LISTING_SORTS as sort}
          <a href={getSortPath(sort)} class:active={routeSpec.listingSort === sort}>
            {formatRedditListingSummary(sort, routeSpec.listingTime)}
          </a>
        {/each}
      </div>
      {#if sourceUsesTime}
        <div class="feed-switcher time-switcher" aria-label="Source time window">
          {#each REDDIT_LISTING_TIMES as time}
            <a href={getTimePath(time)} class:active={routeSpec.listingTime === time}>{time}</a>
          {/each}
        </div>
      {/if}
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

  .feed-route-chip em {
    color: rgba(202, 215, 225, 0.72);
    font-size: 0.7rem;
    font-style: normal;
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

  .time-switcher a {
    min-height: 26px;
    padding: 0 8px;
    font-size: 0.7rem;
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
