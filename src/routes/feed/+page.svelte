<script lang="ts">
  const feeds = [
    { name: 'random', label: 'Random mix', detail: 'Balanced local queue with fair source spread.' },
    { name: 'comfort', label: 'Comfort', detail: 'Higher weight for positively rated sources.' },
    { name: 'fresh', label: 'Fresh', detail: 'Newer source pulls with local quality checks.' },
    { name: 'explore', label: 'Explore', detail: 'More room for unrated and newly discovered sources.' },
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
        <a href="/feed/{feed.name}" class="feed-link">
          <strong>{feed.label}</strong>
          <span>/feed/{feed.name}</span>
          <p>{feed.detail}</p>
        </a>
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
  .feed-link {
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
  .feed-link span {
    color: #8fb6d0;
    font-size: 0.78rem;
  }
  .feed-link p {
    margin: 0;
    color: #aebdc8;
    font-size: 0.86rem;
  }
</style>

