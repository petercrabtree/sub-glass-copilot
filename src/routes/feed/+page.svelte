<script lang="ts">
  import { getDefaultFeedRoutePath, getFeedRoutePath } from '$lib/feed/routes';
  import type { RedditListingSort, RedditListingTime } from '$lib/types';

  const feeds = [
    { name: 'random', label: 'Random mix', detail: 'Balanced local queue with fair source spread.' },
    { name: 'comfort', label: 'Comfort', detail: 'Higher weight for positively rated sources.' },
    { name: 'fresh', label: 'Fresh', detail: 'Newer local picks with quality checks.' },
    { name: 'explore', label: 'Explore', detail: 'More room for unrated and newly discovered sources.' },
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
  <nav>
    <a href="/r/all">viewer</a>
    <a href="/roulette">roulette</a>
    <a href="/discover">discover</a>
    <a href="/admin">admin</a>
  </nav>

  <section>
    <h1>Feeds</h1>
    <div class="feed-list">
      {#each feeds as feed}
        <div class="feed-link">
          <a href={getDefaultFeedRoutePath(feed.name)} class="feed-primary">
            <strong>{feed.label}</strong>
            <span>{getDefaultFeedRoutePath(feed.name)}</span>
          </a>
          <p>{feed.detail}</p>
          <div class="source-links">
            {#each sourceLinks as source}
              <a href={getFeedRoutePath({ feedName: feed.name, listingSort: source.listingSort, listingTime: source.listingTime })}>
                {source.label}
              </a>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  </section>
</main>

<style>
  .feed-index {
    min-height: 100vh;
    background: #08090a;
    color: #eef5fb;
    padding: 24px;
  }
  nav {
    display: flex;
    gap: 12px;
    margin-bottom: 40px;
  }
  nav a,
  .feed-link,
  .feed-primary,
  .source-links a {
    color: inherit;
    text-decoration: none;
  }
  nav a {
    color: #a9bdca;
    font-size: 0.82rem;
  }
  section {
    max-width: 760px;
    margin: 0 auto;
  }
  h1 {
    margin: 0 0 18px;
    font-size: clamp(2rem, 7vw, 4rem);
  }
  .feed-list {
    display: grid;
    gap: 10px;
  }
  .feed-link {
    display: grid;
    gap: 5px;
    padding: 14px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.045);
  }
  .feed-primary {
    display: grid;
    gap: 5px;
  }
  .feed-primary span {
    color: #8fb6d0;
    font-size: 0.78rem;
  }
  .feed-link p {
    margin: 0;
    color: #aebdc8;
    font-size: 0.86rem;
  }
  .source-links {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }
  .source-links a {
    min-height: 28px;
    display: inline-flex;
    align-items: center;
    border: 1px solid rgba(143, 182, 208, 0.2);
    border-radius: 8px;
    background: rgba(143, 182, 208, 0.08);
    color: #b8d4e6;
    font-size: 0.74rem;
    padding: 0 8px;
  }
</style>
