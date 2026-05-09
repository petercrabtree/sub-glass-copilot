<script lang="ts">
  import { ArrowRight, Compass, Flame, Heart, Shuffle, Sparkles, TrendingUp } from 'lucide-svelte';
  import ViewerBrandMenu from '$lib/components/ViewerBrandMenu.svelte';
  import ViewerTopRail from '$lib/components/ViewerTopRail.svelte';
  import { getDefaultFeedRoutePath, getFeedRoutePath } from '$lib/feed/routes';
  import type { RedditListingSort, RedditListingTime } from '$lib/types';

  const feeds = [
    {
      name: 'random',
      label: 'Random mix',
      detail: 'Balanced local queue with fair source spread.',
      metric: 'fair spread',
    },
    {
      name: 'comfort',
      label: 'Comfort',
      detail: 'Higher weight for positively rated sources.',
      metric: 'liked sources',
    },
    {
      name: 'fresh',
      label: 'Fresh',
      detail: 'Newer local picks with quality checks.',
      metric: 'newer picks',
    },
    {
      name: 'explore',
      label: 'Explore',
      detail: 'More room for unrated and newly discovered sources.',
      metric: 'discovery',
    },
  ];

  const sourceLinks: Array<{
    label: string;
    listingSort: RedditListingSort;
    listingTime?: RedditListingTime;
  }> = [
    { label: 'top/month', listingSort: 'top', listingTime: 'month' },
    { label: 'hot', listingSort: 'hot' },
    { label: 'new', listingSort: 'new' },
    { label: 'rising', listingSort: 'rising' },
    { label: 'controversial/month', listingSort: 'controversial', listingTime: 'month' },
  ];
</script>

<svelte:head>
  <title>SubGlass Feeds</title>
</svelte:head>

<main class="feed-index">
  <ViewerTopRail ariaLabel="Feed index navigation">
    {#snippet left()}
      <ViewerBrandMenu />
      <span class="viewer-top-chip feed-chip">feeds</span>
    {/snippet}

    {#snippet right()}
      <a class="rail-link" href="/r/all">viewer</a>
      <a class="rail-link" href="/roulette">roulette</a>
      <a class="rail-link" href="/discover">discover</a>
      <a class="rail-link" href="/admin">admin</a>
    {/snippet}
  </ViewerTopRail>

  <section class="feed-shell" aria-labelledby="feed-index-title">
    <header class="feed-header">
      <div>
        <p class="section-kicker">local queues</p>
        <h1 id="feed-index-title">Feeds</h1>
      </div>

      <a href={getDefaultFeedRoutePath('random')} class="start-link">
        <span>Start random</span>
        <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
      </a>
    </header>

    <div class="feed-grid" aria-label="Feed presets">
      {#each feeds as feed}
        <article class="feed-card" data-feed={feed.name}>
          <a href={getDefaultFeedRoutePath(feed.name)} class="feed-primary">
            <span class="feed-icon" aria-hidden="true">
              {#if feed.name === 'random'}
                <Shuffle size={18} strokeWidth={2} />
              {:else if feed.name === 'comfort'}
                <Heart size={18} strokeWidth={2} />
              {:else if feed.name === 'fresh'}
                <Sparkles size={18} strokeWidth={2} />
              {:else}
                <Compass size={18} strokeWidth={2} />
              {/if}
            </span>

            <span class="feed-copy">
              <strong>{feed.label}</strong>
              <span>{getDefaultFeedRoutePath(feed.name)}</span>
            </span>

            <span class="feed-arrow">
              <ArrowRight size={15} strokeWidth={2} aria-hidden="true" />
            </span>
          </a>

          <p>{feed.detail}</p>

          <div class="feed-meta" aria-label={`${feed.label} summary`}>
            <span>{feed.metric}</span>
            <span>{sourceLinks.length} sources</span>
          </div>

          <div class="source-links">
            {#each sourceLinks as source}
              <a href={getFeedRoutePath({ feedName: feed.name, listingSort: source.listingSort, listingTime: source.listingTime })}>
                {#if source.listingSort === 'hot'}
                  <Flame size={13} strokeWidth={2} aria-hidden="true" />
                {:else if source.listingSort === 'rising'}
                  <TrendingUp size={13} strokeWidth={2} aria-hidden="true" />
                {/if}
                {source.label}
              </a>
            {/each}
          </div>
        </article>
      {/each}
    </div>
  </section>
</main>

<style>
  .feed-index {
    min-height: 100vh;
    background:
      radial-gradient(circle at 18% 8%, rgba(140, 199, 239, 0.13), transparent 30%),
      radial-gradient(circle at 84% 20%, rgba(142, 226, 174, 0.08), transparent 26%),
      linear-gradient(180deg, #07090d 0%, #050608 52%, #030305 100%);
    color: #eef5fb;
    padding: 78px 18px 34px;
    overflow-x: hidden;
  }

  :global(.viewer-top-chip.feed-chip),
  .rail-link {
    padding: 0 9px;
    text-decoration: none;
  }

  :global(.viewer-top-chip.feed-chip) {
    color: rgba(154, 211, 247, 0.92);
    font-weight: 700;
  }

  .rail-link {
    min-height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    background: rgba(255, 255, 255, 0.04);
    color: rgba(213, 225, 235, 0.82);
    font-size: 0.72rem;
    line-height: 1;
  }

  .rail-link:hover,
  .rail-link:focus-visible {
    border-color: rgba(140, 199, 239, 0.24);
    background: rgba(140, 199, 239, 0.12);
    color: #edf6ff;
  }

  .feed-shell {
    width: min(980px, 100%);
    margin: 0 auto;
  }

  .feed-header {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 18px;
    margin-bottom: 18px;
  }

  .section-kicker {
    margin: 0 0 6px;
    color: rgba(154, 211, 247, 0.76);
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    color: #f2f8fd;
    font-size: clamp(2.1rem, 6vw, 3.4rem);
    line-height: 0.92;
  }

  .start-link,
  .feed-primary,
  .source-links a {
    color: inherit;
    text-decoration: none;
  }

  .start-link {
    min-height: 34px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    border-radius: 8px;
    border: 1px solid rgba(140, 199, 239, 0.28);
    background: rgba(140, 199, 239, 0.13);
    color: #dff2ff;
    font-size: 0.78rem;
    font-weight: 700;
    white-space: nowrap;
  }

  .start-link:hover,
  .start-link:focus-visible {
    border-color: rgba(140, 199, 239, 0.42);
    background: rgba(140, 199, 239, 0.19);
  }

  .feed-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .feed-card {
    --feed-accent: rgba(140, 199, 239, 0.86);
    --feed-accent-soft: rgba(140, 199, 239, 0.12);
    display: grid;
    align-content: start;
    gap: 11px;
    min-height: 188px;
    padding: 12px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.085);
    background:
      linear-gradient(135deg, var(--feed-accent-soft), transparent 42%),
      rgba(11, 14, 18, 0.78);
    box-shadow: 0 18px 40px rgba(0, 0, 0, 0.22);
  }

  .feed-card[data-feed='comfort'] {
    --feed-accent: rgba(142, 226, 174, 0.88);
    --feed-accent-soft: rgba(142, 226, 174, 0.1);
  }

  .feed-card[data-feed='fresh'] {
    --feed-accent: rgba(224, 196, 137, 0.9);
    --feed-accent-soft: rgba(224, 196, 137, 0.1);
  }

  .feed-card[data-feed='explore'] {
    --feed-accent: rgba(212, 165, 232, 0.88);
    --feed-accent-soft: rgba(212, 165, 232, 0.1);
  }

  .feed-card:hover {
    border-color: color-mix(in srgb, var(--feed-accent) 36%, rgba(255, 255, 255, 0.08));
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--feed-accent-soft) 72%, transparent), transparent 46%),
      rgba(14, 18, 23, 0.86);
  }

  .feed-primary {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 10px;
    padding-bottom: 1px;
  }

  .feed-primary:hover .feed-arrow,
  .feed-primary:focus-visible .feed-arrow {
    opacity: 1;
    transform: translateX(0);
  }

  .feed-icon,
  .feed-arrow {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--feed-accent);
  }

  .feed-icon {
    width: 34px;
    height: 34px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--feed-accent) 28%, rgba(255, 255, 255, 0.08));
    background: rgba(255, 255, 255, 0.04);
  }

  .feed-copy {
    min-width: 0;
    display: grid;
    gap: 4px;
  }

  .feed-primary strong {
    color: #f2f7fb;
    font-size: 1rem;
    line-height: 1.05;
  }

  .feed-primary span {
    min-width: 0;
  }

  .feed-copy span {
    color: #8fb6d0;
    font-size: 0.78rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .feed-arrow {
    margin-left: auto;
    opacity: 0.42;
    transform: translateX(-2px);
    transition:
      opacity 0.16s ease,
      transform 0.16s ease;
  }

  .feed-card p {
    margin: 0;
    min-height: 38px;
    color: rgba(190, 204, 216, 0.88);
    font-size: 0.82rem;
    line-height: 1.35;
  }

  .feed-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .feed-meta span {
    min-height: 24px;
    display: inline-flex;
    align-items: center;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    background: rgba(255, 255, 255, 0.04);
    color: rgba(212, 223, 232, 0.78);
    font-size: 0.68rem;
    padding: 0 8px;
  }

  .source-links {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .source-links a {
    min-height: 27px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border-radius: 8px;
    border: 1px solid rgba(143, 182, 208, 0.16);
    background: rgba(143, 182, 208, 0.07);
    color: rgba(203, 224, 238, 0.9);
    font-size: 0.74rem;
    padding: 0 8px;
  }

  .source-links a:hover,
  .source-links a:focus-visible {
    border-color: color-mix(in srgb, var(--feed-accent) 34%, rgba(143, 182, 208, 0.16));
    background: color-mix(in srgb, var(--feed-accent-soft) 62%, rgba(143, 182, 208, 0.07));
    color: #f1f8fd;
  }

  .start-link:focus-visible,
  .rail-link:focus-visible,
  .feed-primary:focus-visible,
  .source-links a:focus-visible {
    outline: 2px solid rgba(140, 199, 239, 0.78);
    outline-offset: 2px;
  }

  @media (max-width: 760px) {
    .feed-index {
      padding-top: 118px;
    }

    .feed-header {
      align-items: start;
      flex-direction: column;
    }

    .feed-grid {
      grid-template-columns: 1fr;
    }

    .feed-card {
      min-height: 0;
    }
  }

  @media (max-width: 480px) {
    .feed-index {
      padding-right: 12px;
      padding-left: 12px;
    }

    .source-links a {
      flex: 1 1 calc(50% - 6px);
      justify-content: center;
    }
  }
</style>
