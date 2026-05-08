<script lang="ts">
  import { onMount } from 'svelte';
  import type { SubredditRecord } from '$lib/types';
  import { profileScanManager } from '$lib/discovery/profile-scan-manager.svelte.js';
  import { getAllSubreddits, getAdjacencyFrom, isSubredditUnavailable } from '$lib/db/store';
  import ProfileScanStatus from '$lib/components/ProfileScanStatus.svelte';

  let subreddits = $state<SubredditRecord[]>([]);
  let loading = $state(true);
  let scanMessage = $state('');
  let suggestions = $state<Array<{ name: string; reason: string; score: number; evidence?: string }>>([]);
  let sortedSubreddits = $derived([...subreddits].sort((a, b) => b.localRating - a.localRating));
  let scanning = $derived(profileScanManager.active);

  onMount(async () => {
    subreddits = await getAllSubreddits();
    suggestions = await buildSuggestions(subreddits);
    loading = false;
  });

  async function buildSuggestions(subs: SubredditRecord[]) {
    const scored = subs
      .filter(s => !s.isMuted && !isSubredditUnavailable(s))
      .sort((a, b) => b.localRating - a.localRating);

    const results: Array<{ name: string; reason: string; score: number; evidence?: string }> = [];
    const seen = new Set<string>();

    for (const sub of scored.filter(s => s.localRating > 0).slice(0, 5)) {
      if (!seen.has(sub.name)) {
        seen.add(sub.name);
        results.push({ name: sub.name, reason: `You rated posts here positively (${sub.localRating})`, score: sub.localRating });
      }
    }

    for (const sub of scored.filter(s => s.localRating > 0).slice(0, 5)) {
      const adj = await getAdjacencyFrom(sub.name);
      for (const link of adj.sort((a, b) => (b.weight ?? b.count ?? 1) - (a.weight ?? a.count ?? 1)).slice(0, 5)) {
        if (!seen.has(link.toSubreddit)) {
          const adjSub = subs.find(s => s.name === link.toSubreddit);
          if (!adjSub?.isMuted && !isSubredditUnavailable(adjSub)) {
            seen.add(link.toSubreddit);
            results.push({
              name: link.toSubreddit,
              reason: `Linked from r/${sub.name} (${link.source}, ${link.count ?? 1}x)`,
              score: 0.5 + (link.weight ?? link.count ?? 1) * 0.1,
              evidence: link.evidence,
            });
          }
        }
      }
    }

    for (const sub of scored.filter(s => s.localRating === 0).slice(0, 5)) {
      if (!seen.has(sub.name)) {
        seen.add(sub.name);
        results.push({ name: sub.name, reason: 'Discovered but not yet rated', score: 0 });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  async function refresh() {
    loading = true;
    subreddits = await getAllSubreddits();
    suggestions = await buildSuggestions(subreddits);
    loading = false;
  }

  async function scanNext() {
    scanMessage = '';
    try {
      await profileScanManager.scanNext(20);
      scanMessage = profileScanManager.lastMessage || profileScanManager.detailText;
      await refresh();
    } catch (error) {
      scanMessage = error instanceof Error ? error.message : String(error);
    }
  }

  async function scanOne(name: string) {
    scanMessage = '';
    await profileScanManager.scanOne(name);
    scanMessage = profileScanManager.lastMessage || profileScanManager.detailText;
    await refresh();
  }
</script>

<div class="discover-page">
  <nav class="topbar">
    <a href="/r/all" class="logo">SubGlass</a>
    <div class="nav-links">
      <a href="/r/all">all</a>
      <a href="/feed/random">feed</a>
      <a href="/roulette">roulette</a>
      <a href="/discover" class="active">discover</a>
      <a href="/admin">admin</a>
    </div>
  </nav>

  <main>
    <h1>Discover Subreddits</h1>
    <p class="subtitle">Based on local ratings, subreddit profile scans, and adjacency links</p>

    <div class="toolbar">
      <button class="refresh-btn" onclick={refresh}>Refresh</button>
      <button class="refresh-btn" onclick={scanNext} disabled={scanning}>{scanning ? 'Scanning…' : 'Scan next 20'}</button>
      <a href="/roulette" class="refresh-link">Roulette mode</a>
      <ProfileScanStatus />
    </div>
    {#if scanMessage}<p class="scan-message">{scanMessage}</p>{/if}

    {#if loading}
      <div class="loading">Loading…</div>
    {:else if suggestions.length === 0}
      <div class="empty">
        <p>No suggestions yet. Browse some subreddits and rate posts to get started.</p>
        <a href="/r/all">Browse /r/all</a>
      </div>
    {:else}
      <div class="suggestions">
        {#each suggestions as s}
          <div class="suggestion-card">
            <a href="/r/{s.name}" class="sub-name">r/{s.name}</a>
            <p class="reason">{s.reason}</p>
            {#if s.score > 0}
              <span class="score">⭐ {s.score.toFixed(1)}</span>
            {/if}
            {#if s.evidence}<p class="evidence">"{s.evidence}"</p>{/if}
          </div>
        {/each}
      </div>
    {/if}

    <section class="subreddit-list">
      <h2>All Known Subreddits ({subreddits.length})</h2>
      <div class="sub-table">
        {#each sortedSubreddits as sub}
          <div class="sub-row" class:muted={sub.isMuted}>
            <a href="/r/{sub.name}" class="sub-link">r/{sub.name}</a>
            <span class="rating" class:positive={sub.localRating > 0} class:negative={sub.localRating < 0}>
              {sub.localRating > 0 ? '+' : ''}{sub.localRating}
            </span>
            <span class="status">{sub.discoveryStatus ?? 'discovered'}</span>
            {#if sub.availabilityStatus && sub.availabilityStatus !== 'available'}
              <span class="status unavailable">{sub.availabilityStatus}</span>
            {/if}
            {#if sub.subscribers}<span class="meta">{sub.subscribers.toLocaleString()} subs</span>{/if}
            {#if sub.profileFetchedAt}<span class="meta">scanned {new Date(sub.profileFetchedAt).toLocaleDateString()}</span>{/if}
            {#if sub.isMuted}<span class="muted-label">muted</span>{/if}
            <button class="scan-one" onclick={() => scanOne(sub.name)} disabled={scanning}>scan</button>
          </div>
        {/each}
      </div>
    </section>
  </main>
</div>

<style>
  .discover-page { min-height: 100vh; background: #0a0a0a; }
  .topbar {
    display: flex; align-items: center; gap: 12px;
    padding: 8px 16px; background: #111;
    border-bottom: 1px solid #222;
  }
  .logo { font-weight: 700; font-size: 1.1rem; color: #6ab0de; }
  .nav-links { display: flex; gap: 12px; font-size: 0.85rem; }
  .nav-links a { color: #999; }
  .nav-links a:hover, .nav-links a.active { color: #e0e0e0; }
  main { max-width: 800px; margin: 0 auto; padding: 32px 16px; }
  h1 { font-size: 1.5rem; margin-bottom: 8px; }
  .subtitle { color: #888; margin-bottom: 24px; font-size: 0.9rem; }
  .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
  .refresh-btn {
    background: #2a4a6a; color: #e0e0e0; border: none;
    padding: 8px 16px; border-radius: 4px;
  }
  .refresh-btn:disabled, .scan-one:disabled { opacity: 0.5; cursor: not-allowed; }
  .refresh-link { color: #6ab0de; font-size: 0.86rem; }
  .scan-message { color: #8fbf9e; font-size: 0.84rem; margin-bottom: 20px; }
  .loading, .empty { color: #888; padding: 32px 0; }
  .empty a { color: #6ab0de; }
  .suggestions { display: grid; gap: 12px; margin-bottom: 48px; }
  .suggestion-card {
    background: #141414; border: 1px solid #222; border-radius: 8px;
    padding: 16px; display: flex; align-items: center; gap: 12px;
    flex-wrap: wrap;
  }
  .sub-name { font-weight: 600; color: #6ab0de; font-size: 1rem; }
  .reason { color: #888; font-size: 0.85rem; flex: 1; }
  .score { color: #f0c040; font-size: 0.85rem; }
  .evidence { flex-basis: 100%; color: #666; font-size: 0.78rem; font-style: italic; }
  h2 { font-size: 1.1rem; margin-bottom: 16px; color: #aaa; }
  .sub-table { display: flex; flex-direction: column; gap: 4px; }
  .sub-row { display: flex; align-items: center; gap: 12px; padding: 6px 8px; border-radius: 4px; }
  .sub-row:hover { background: #141414; }
  .sub-row.muted { opacity: 0.5; }
  .sub-link { color: #6ab0de; font-size: 0.9rem; flex: 1; }
  .rating { font-size: 0.85rem; color: #888; }
  .rating.positive { color: #6ab0de; }
  .rating.negative { color: #de6a6a; }
  .status, .meta { font-size: 0.74rem; color: #777; }
  .status.unavailable { color: #de6a6a; }
  .muted-label { font-size: 0.7rem; color: #666; }
  .scan-one {
    background: #1d2f42; color: #d8e5ef; border: 1px solid #2b4054;
    border-radius: 4px; padding: 4px 8px; font-size: 0.72rem;
  }
</style>
