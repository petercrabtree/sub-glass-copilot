<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getAllSubreddits, getAllPosts, getAllMedia, getAllEvents, getAllAdjacency,
    exportAllData, importAllData,
  } from '$lib/db/store';
  import type { SubredditRecord, PostRecord, SignalEvent, AdjacencyLink } from '$lib/types';

  let stats = $state({ subreddits: 0, posts: 0, media: 0, events: 0, adjacency: 0 });
  let subreddits = $state<SubredditRecord[]>([]);
  let posts = $state<PostRecord[]>([]);
  let events = $state<SignalEvent[]>([]);
  let adjacency = $state<AdjacencyLink[]>([]);
  let activeTab = $state<'overview' | 'subreddits' | 'posts' | 'events' | 'adjacency'>('overview');
  let importText = $state('');
  let importError = $state('');
  let importSuccess = $state(false);
  let loading = $state(true);

  onMount(async () => {
    await loadData();
    loading = false;
  });

  async function loadData() {
    const [subs, ps, ms, evs, adj] = await Promise.all([
      getAllSubreddits(),
      getAllPosts(),
      getAllMedia(),
      getAllEvents(),
      getAllAdjacency(),
    ]);
    stats = { subreddits: subs.length, posts: ps.length, media: ms.length, events: evs.length, adjacency: adj.length };
    subreddits = subs;
    posts = ps;
    events = evs.slice(-100).reverse();
    adjacency = adj.slice(0, 100);
  }

  async function doExport() {
    const data = await exportAllData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `subglass-export-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function doImport() {
    importError = '';
    importSuccess = false;
    try {
      const data = JSON.parse(importText);
      await importAllData(data);
      importSuccess = true;
      importText = '';
      await loadData();
    } catch (e) {
      importError = String(e);
    }
  }

  function handleFileImport(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      importText = ev.target?.result as string || '';
    };
    reader.readAsText(file);
  }
</script>

<div class="admin-page">
  <nav class="topbar">
    <a href="/r/all" class="logo">SubGlass</a>
    <div class="nav-links">
      <a href="/r/all">viewer</a>
      <a href="/discover">discover</a>
      <a href="/admin" class="active">admin</a>
    </div>
  </nav>

  <main>
    <h1>Admin / Debug</h1>

    {#if loading}
      <div class="loading">Loading data…</div>
    {:else}
      <!-- Stats Overview -->
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-value">{stats.subreddits}</div>
          <div class="stat-label">Subreddits</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{stats.posts}</div>
          <div class="stat-label">Posts</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{stats.media}</div>
          <div class="stat-label">Media Groups</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{stats.events}</div>
          <div class="stat-label">Events</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{stats.adjacency}</div>
          <div class="stat-label">Adjacency Links</div>
        </div>
      </div>

      <!-- Tabs -->
      <div class="tabs">
        {#each (['overview', 'subreddits', 'posts', 'events', 'adjacency'] as const) as tab}
          <button
            class="tab"
            class:active={activeTab === tab}
            onclick={() => { activeTab = tab; }}
          >{tab}</button>
        {/each}
      </div>

      <div class="tab-content">
        {#if activeTab === 'overview'}
          <div class="export-import">
            <section>
              <h2>Export</h2>
              <p>Download all local state as JSON.</p>
              <button class="action-btn" onclick={doExport}>⬇️ Export JSON</button>
            </section>
            <section>
              <h2>Import</h2>
              <p>Overwrite all local state from a JSON export.</p>
              <input type="file" accept=".json" onchange={handleFileImport} class="file-input" />
              <textarea
                bind:value={importText}
                placeholder="Or paste JSON here…"
                class="import-textarea"
                rows={6}
              ></textarea>
              {#if importError}<p class="error">{importError}</p>{/if}
              {#if importSuccess}<p class="success">Import successful!</p>{/if}
              <button class="action-btn" onclick={doImport} disabled={!importText}>⬆️ Import JSON</button>
            </section>
          </div>

        {:else if activeTab === 'subreddits'}
          <div class="data-table">
            {#each subreddits.sort((a, b) => b.localRating - a.localRating) as sub}
              <div class="data-row">
                <a href="/r/{sub.name}" class="sub-link">r/{sub.name}</a>
                <span class="field">rating: <strong>{sub.localRating}</strong></span>
                <span class="field">{sub.isMuted ? '🔇 muted' : ''}</span>
                <span class="field meta">seen: {new Date(sub.firstSeenAt).toLocaleDateString()}</span>
              </div>
            {/each}
          </div>

        {:else if activeTab === 'posts'}
          <div class="data-table">
            {#each posts.slice(0, 100) as post}
              <div class="data-row">
                <a href="https://reddit.com{post.permalink}" target="_blank" class="sub-link">
                  {post.title.slice(0, 60)}{post.title.length > 60 ? '…' : ''}
                </a>
                <span class="field">r/{post.subreddit}</span>
                <span class="field">{post.media?.kind ?? 'no media'}</span>
                {#if post.seenAt}<span class="field meta">✓ seen</span>{/if}
                {#if post.localRating}<span class="field">{post.localRating === 1 ? '👍' : '👎'}</span>{/if}
              </div>
            {/each}
          </div>

        {:else if activeTab === 'events'}
          <div class="data-table">
            {#each events as ev}
              <div class="data-row">
                <span class="field event-type">{ev.type}</span>
                {#if ev.postId}<span class="field meta">{ev.postId}</span>{/if}
                {#if ev.subreddit}<span class="field">r/{ev.subreddit}</span>{/if}
                <span class="field meta">{new Date(ev.ts).toLocaleString()}</span>
              </div>
            {/each}
          </div>

        {:else if activeTab === 'adjacency'}
          <div class="data-table">
            {#each adjacency as link}
              <div class="data-row">
                <a href="/r/{link.fromSubreddit}" class="sub-link">r/{link.fromSubreddit}</a>
                <span class="arrow">→</span>
                <a href="/r/{link.toSubreddit}" class="sub-link">r/{link.toSubreddit}</a>
                <span class="field">{link.source}</span>
                {#if link.evidence}<span class="field meta evidence">"{link.evidence.slice(0, 40)}"</span>{/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </main>
</div>

<style>
  .admin-page { min-height: 100vh; background: #0a0a0a; }
  .topbar {
    display: flex; align-items: center; gap: 12px;
    padding: 8px 16px; background: #111;
    border-bottom: 1px solid #222;
  }
  .logo { font-weight: 700; font-size: 1.1rem; color: #6ab0de; }
  .nav-links { display: flex; gap: 12px; font-size: 0.85rem; }
  .nav-links a { color: #999; }
  .nav-links a:hover, .nav-links a.active { color: #e0e0e0; }
  main { max-width: 900px; margin: 0 auto; padding: 32px 16px; }
  h1 { font-size: 1.5rem; margin-bottom: 24px; }
  h2 { font-size: 1.1rem; margin-bottom: 8px; }
  .loading { color: #888; padding: 32px 0; }
  .stats-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 12px; margin-bottom: 32px;
  }
  .stat-card {
    background: #141414; border: 1px solid #222; border-radius: 8px;
    padding: 16px; text-align: center;
  }
  .stat-value { font-size: 1.8rem; font-weight: 700; color: #6ab0de; }
  .stat-label { font-size: 0.75rem; color: #888; margin-top: 4px; }
  .tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid #222; }
  .tab {
    background: none; border: none; color: #888; padding: 8px 16px;
    font-size: 0.9rem; cursor: pointer; border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .tab:hover { color: #e0e0e0; }
  .tab.active { color: #6ab0de; border-bottom-color: #6ab0de; }
  .tab-content { min-height: 300px; }
  .export-import { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
  section p { color: #888; font-size: 0.85rem; margin-bottom: 12px; }
  .action-btn {
    background: #2a4a6a; color: #e0e0e0; border: none;
    padding: 8px 16px; border-radius: 4px; font-size: 0.9rem;
  }
  .action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .file-input { color: #888; font-size: 0.85rem; margin-bottom: 8px; display: block; }
  .import-textarea {
    width: 100%; background: #141414; border: 1px solid #333; color: #e0e0e0;
    padding: 8px; border-radius: 4px; font-size: 0.75rem; margin-bottom: 8px;
    font-family: monospace; resize: vertical;
  }
  .error { color: #de6a6a; font-size: 0.85rem; margin-bottom: 8px; }
  .success { color: #6ade8a; font-size: 0.85rem; margin-bottom: 8px; }
  .data-table { display: flex; flex-direction: column; gap: 4px; }
  .data-row {
    display: flex; align-items: center; gap: 12px; padding: 6px 8px;
    background: #111; border-radius: 4px; flex-wrap: wrap; font-size: 0.85rem;
  }
  .sub-link { color: #6ab0de; }
  .field { color: #888; }
  .meta { color: #555; font-size: 0.75rem; }
  .event-type { color: #aaa; font-weight: 500; min-width: 120px; }
  .arrow { color: #555; }
  .evidence { font-style: italic; }
</style>
