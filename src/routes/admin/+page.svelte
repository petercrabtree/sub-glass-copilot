<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getAllSubreddits, getAllPosts, getAllMedia, getAllEvents, getAllAdjacency,
    exportAllData, importAllData, getAllFeedSnapshots,
    setSubredditMuted, setSubredditRating, clearSubredditProfileFailure,
    isSubredditUnavailable,
  } from '$lib/db/store';
  import { profileScanManager } from '$lib/discovery/profile-scan-manager.svelte.js';
  import {
    clearMediaCache,
    getMediaCacheDiagnostics,
    subscribeToMediaCacheUpdates,
    unregisterMediaServiceWorker,
    updateMediaServiceWorker,
    type MediaCacheDiagnostics,
  } from '$lib/service-worker/media-cache';
  import { registerServiceWorker } from '$lib/service-worker/register';
  import ProfileScanStatus from '$lib/components/ProfileScanStatus.svelte';
  import type { SubredditRecord, PostRecord, SignalEvent, AdjacencyLink, FeedSnapshot } from '$lib/types';

  let stats = $state({ subreddits: 0, posts: 0, media: 0, events: 0, adjacency: 0, snapshots: 0 });
  let subreddits = $state<SubredditRecord[]>([]);
  let posts = $state<PostRecord[]>([]);
  let events = $state<SignalEvent[]>([]);
  let adjacency = $state<AdjacencyLink[]>([]);
  let snapshots = $state<FeedSnapshot[]>([]);
  let mediaCache = $state<MediaCacheDiagnostics | null>(null);
  let activeTab = $state<'overview' | 'cache' | 'discovery' | 'subreddits' | 'posts' | 'events' | 'adjacency'>('overview');
  let importText = $state('');
  let importError = $state('');
  let importSuccess = $state(false);
  let cacheMessage = $state('');
  let cacheError = $state('');
  let cacheBusyAction = $state<string | null>(null);
  let scanMessage = $state('');
  let loading = $state(true);
  let sortedSubreddits = $derived([...subreddits].sort((a, b) => b.localRating - a.localRating));
  let editableSubreddits = $derived(
    [...subreddits].sort((a, b) => {
      const aUnavailable = isSubredditUnavailable(a) ? 0 : 1;
      const bUnavailable = isSubredditUnavailable(b) ? 0 : 1;
      if (aUnavailable !== bUnavailable) return aUnavailable - bUnavailable;
      const aUnscanned = a.profileFetchedAt ? 1 : 0;
      const bUnscanned = b.profileFetchedAt ? 1 : 0;
      if (aUnscanned !== bUnscanned) return aUnscanned - bUnscanned;
      return b.localRating - a.localRating;
    })
  );
  let scanBusy = $derived(profileScanManager.active);
  let discoveryStats = $derived({
    verified: subreddits.filter((sub) => sub.profileFetchedAt && !sub.isMuted && !isSubredditUnavailable(sub)).length,
    unscanned: subreddits.filter((sub) => !sub.profileFetchedAt && !sub.isMuted && !isSubredditUnavailable(sub) && sub.name !== 'all').length,
    failed: subreddits.filter((sub) => !isSubredditUnavailable(sub) && (sub.discoveryStatus === 'failed' || sub.profileFetchError)).length,
    banned: subreddits.filter((sub) => sub.availabilityStatus === 'banned').length,
    unavailable: subreddits.filter((sub) => isSubredditUnavailable(sub)).length,
    muted: subreddits.filter((sub) => sub.isMuted || sub.discoveryStatus === 'muted').length,
  });

  onMount(() => {
    void Promise.all([loadData(), loadMediaCache()]).then(() => {
      loading = false;
    });

    const unsubscribeFromMediaCache = subscribeToMediaCacheUpdates(() => {
      void loadMediaCache();
    });
    const handleControllerChange = () => {
      void loadMediaCache();
    };

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);
    }

    return () => {
      unsubscribeFromMediaCache();
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
      }
    };
  });

  async function loadData() {
    const [subs, ps, ms, evs, adj, snaps] = await Promise.all([
      getAllSubreddits(),
      getAllPosts(),
      getAllMedia(),
      getAllEvents(),
      getAllAdjacency(),
      getAllFeedSnapshots(),
    ]);
    stats = { subreddits: subs.length, posts: ps.length, media: ms.length, events: evs.length, adjacency: adj.length, snapshots: snaps.length };
    subreddits = subs;
    posts = ps;
    events = evs.slice(-100).reverse();
    adjacency = adj.slice(0, 100);
    snapshots = snaps.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
  }

  async function loadMediaCache() {
    mediaCache = await getMediaCacheDiagnostics();
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

  async function runCacheAction(action: string, task: () => Promise<string>) {
    cacheBusyAction = action;
    cacheMessage = '';
    cacheError = '';

    try {
      cacheMessage = await task();
      await loadMediaCache();
    } catch (error) {
      cacheError = String(error);
    } finally {
      cacheBusyAction = null;
    }
  }

  async function refreshCacheStatus() {
    await runCacheAction('refresh', async () => {
      await loadMediaCache();
      return 'Cache status refreshed.';
    });
  }

  async function clearImageCache() {
    await runCacheAction('clear', async () => {
      const cleared = await clearMediaCache();
      return cleared ? 'Image cache cleared.' : 'Image cache was already empty or unavailable.';
    });
  }

  async function updateImageWorker() {
    await runCacheAction('update', async () => {
      const updated = await updateMediaServiceWorker();
      if (updated) return 'Service worker update requested.';

      const registration = await registerServiceWorker();
      return registration
        ? 'Service worker registered.'
        : 'Service worker registration is unavailable in this browser.';
    });
  }

  async function unregisterImageWorker() {
    await runCacheAction('unregister', async () => {
      const unregistered = await unregisterMediaServiceWorker();
      return unregistered
        ? 'Service worker unregistered. Reload the page to fully detach it from this tab.'
        : 'No service worker registration was present.';
    });
  }

  async function runDiscoveryAction(task: () => Promise<void>) {
    scanMessage = '';
    try {
      await task();
      scanMessage = profileScanManager.lastMessage || profileScanManager.detailText;
      await loadData();
    } catch (error) {
      scanMessage = error instanceof Error ? error.message : String(error);
    }
  }

  async function scanNextProfiles() {
    await runDiscoveryAction(() => profileScanManager.scanNext(20));
  }

  async function scanAllDueProfiles() {
    await runDiscoveryAction(() => profileScanManager.scanAllDue());
  }

  async function scanFailedProfiles() {
    await runDiscoveryAction(() => profileScanManager.scanFailed());
  }

  async function scanUnavailableProfiles() {
    await runDiscoveryAction(() => profileScanManager.scanUnavailable());
  }

  async function rescanAllProfiles() {
    if (!window.confirm('Rescan every unmuted subreddit profile? This can issue many Reddit requests.')) return;
    await runDiscoveryAction(() => profileScanManager.rescanAll());
  }

  async function scanOneProfile(name: string) {
    await runDiscoveryAction(() => profileScanManager.scanOne(name));
  }

  async function updateSubredditRatingFromInput(sub: SubredditRecord, event: Event) {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;

    await setSubredditRating(sub.name, Math.round(value));
    await loadData();
  }

  async function toggleSubredditMuted(sub: SubredditRecord, event: Event) {
    await setSubredditMuted(sub.name, (event.currentTarget as HTMLInputElement).checked);
    await loadData();
  }

  async function clearSubredditFailure(sub: SubredditRecord) {
    await clearSubredditProfileFailure(sub.name);
    await loadData();
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

  function formatCacheSampleUrl(url: string) {
    try {
      const parsed = new URL(url);
      const path = `${parsed.hostname}${parsed.pathname}`;
      return path.length > 72 ? `${path.slice(0, 72)}…` : path;
    } catch {
      return url;
    }
  }
</script>

<div class="admin-page">
  <nav class="topbar">
    <a href="/r/all" class="logo">SubGlass</a>
    <div class="nav-links">
      <a href="/r/all">viewer</a>
      <a href="/roulette">roulette</a>
      <a href="/discover">discover</a>
      <a href="/admin" class="active">admin</a>
    </div>
  </nav>

  <main>
    <h1>Admin / Debug</h1>

    {#if loading}
      <div class="loading">Loading data…</div>
    {:else}
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
        <div class="stat-card">
          <div class="stat-value">{stats.snapshots}</div>
          <div class="stat-label">Feed Snapshots</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{mediaCache?.entryCount ?? '—'}</div>
          <div class="stat-label">Cached Images</div>
        </div>
      </div>

      <div class="tabs">
        {#each (['overview', 'cache', 'discovery', 'subreddits', 'posts', 'events', 'adjacency'] as const) as tab}
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
            <section>
              <h2>Image Cache</h2>
              <p>Inspect and reset the service worker image cache used by the viewer.</p>
              <div class="cache-summary-grid">
                <span class="field">cache api: <strong>{mediaCache?.cacheSupported ? 'yes' : 'no'}</strong></span>
                <span class="field">worker api: <strong>{mediaCache?.serviceWorkerSupported ? 'yes' : 'no'}</strong></span>
                <span class="field">registered: <strong>{mediaCache?.registrationActive ? 'yes' : 'no'}</strong></span>
                <span class="field">controlling page: <strong>{mediaCache?.pageControlled ? 'yes' : 'no'}</strong></span>
              </div>
              <div class="cache-actions">
                <button class="action-btn" onclick={refreshCacheStatus} disabled={cacheBusyAction !== null}>Refresh</button>
                <button class="action-btn" onclick={clearImageCache} disabled={cacheBusyAction !== null}>Clear Cache</button>
                <button class="action-btn" onclick={updateImageWorker} disabled={cacheBusyAction !== null}>Register / Update Worker</button>
                <button class="action-btn action-btn--danger" onclick={unregisterImageWorker} disabled={cacheBusyAction !== null}>Unregister Worker</button>
              </div>
              {#if cacheMessage}<p class="success">{cacheMessage}</p>{/if}
              {#if cacheError}<p class="error">{cacheError}</p>{/if}
            </section>
            <section>
              <h2>Discovery Scan</h2>
              <p>Fetch due subreddit profiles, extract linked subreddits, and update adjacency weights.</p>
              <div class="cache-actions">
                <ProfileScanStatus />
                <button class="action-btn" onclick={scanNextProfiles} disabled={scanBusy}>{scanBusy ? 'Scanning…' : 'Scan next 20'}</button>
                <button class="action-btn" onclick={() => { activeTab = 'discovery'; }}>Controls</button>
              </div>
              {#if scanMessage}<p class="success">{scanMessage}</p>{/if}
            </section>
          </div>

        {:else if activeTab === 'cache'}
          <section class="cache-panel">
            <div class="cache-panel-header">
              <div>
                <h2>Image Cache / Service Worker</h2>
                <p>
                  Live cache diagnostics for this browser profile. Clear the image cache, update the worker, or unregister it here.
                </p>
              </div>
              <div class="cache-actions">
                <button class="action-btn" onclick={refreshCacheStatus} disabled={cacheBusyAction !== null}>Refresh</button>
                <button class="action-btn" onclick={clearImageCache} disabled={cacheBusyAction !== null}>Clear Cache</button>
                <button class="action-btn" onclick={updateImageWorker} disabled={cacheBusyAction !== null}>Register / Update Worker</button>
                <button class="action-btn action-btn--danger" onclick={unregisterImageWorker} disabled={cacheBusyAction !== null}>Unregister Worker</button>
              </div>
            </div>

            {#if cacheMessage}<p class="success">{cacheMessage}</p>{/if}
            {#if cacheError}<p class="error">{cacheError}</p>{/if}

            <div class="stats-grid cache-stats-grid">
              <div class="stat-card">
                <div class="stat-value">{mediaCache?.entryCount ?? 0}</div>
                <div class="stat-label">Cached Images</div>
              </div>
              <div class="stat-card">
                <div class="stat-value">{mediaCache?.registrationActive ? 'yes' : 'no'}</div>
                <div class="stat-label">Worker Registered</div>
              </div>
              <div class="stat-card">
                <div class="stat-value">{mediaCache?.pageControlled ? 'yes' : 'no'}</div>
                <div class="stat-label">Controlling Page</div>
              </div>
            </div>

            <div class="cache-detail-grid">
              <div class="cache-detail-card">
                <h3>Runtime</h3>
                <div class="data-table">
                  <div class="data-row"><span class="field">Cache Storage</span><span class="field"><strong>{mediaCache?.cacheSupported ? 'available' : 'unavailable'}</strong></span></div>
                  <div class="data-row"><span class="field">Service Worker API</span><span class="field"><strong>{mediaCache?.serviceWorkerSupported ? 'available' : 'unavailable'}</strong></span></div>
                  <div class="data-row"><span class="field">Registration</span><span class="field"><strong>{mediaCache?.registrationActive ? 'active' : 'missing'}</strong></span></div>
                  <div class="data-row"><span class="field">Current tab</span><span class="field"><strong>{mediaCache?.pageControlled ? 'controlled' : 'not controlled'}</strong></span></div>
                </div>
              </div>
              <div class="cache-detail-card">
                <h3>Registration</h3>
                <div class="data-table">
                  <div class="data-row"><span class="field">Scope</span><span class="field meta">{mediaCache?.registrationScope ?? 'n/a'}</span></div>
                  <div class="data-row"><span class="field">Script</span><span class="field meta">{mediaCache?.registrationScriptUrl ?? 'n/a'}</span></div>
                </div>
              </div>
            </div>

            <div class="cache-detail-card">
              <h3>Cached Requests</h3>
              {#if mediaCache && mediaCache.sampleUrls.length > 0}
                <div class="data-table">
                  {#each mediaCache.sampleUrls as url}
                    <div class="data-row">
                      <span class="field meta">{formatCacheSampleUrl(url)}</span>
                    </div>
                  {/each}
                </div>
              {:else}
                <p class="cache-meta">No cached image requests yet.</p>
              {/if}
            </div>
          </section>

        {:else if activeTab === 'discovery'}
          <section class="discovery-panel">
            <div class="cache-panel-header">
              <div>
                <h2>Subreddit Discovery</h2>
                <p>Background profile scans enrich subreddit metadata and adjacency links without leaving the client.</p>
              </div>
              <ProfileScanStatus />
            </div>

            <div class="stats-grid cache-stats-grid">
              <div class="stat-card">
                <div class="stat-value">{discoveryStats.verified}</div>
                <div class="stat-label">Verified</div>
              </div>
              <div class="stat-card">
                <div class="stat-value">{discoveryStats.unscanned}</div>
                <div class="stat-label">Unscanned</div>
              </div>
              <div class="stat-card">
                <div class="stat-value">{profileScanManager.queuedCount}</div>
                <div class="stat-label">Queued</div>
              </div>
              <div class="stat-card">
                <div class="stat-value">{discoveryStats.failed}</div>
                <div class="stat-label">Failed</div>
              </div>
              <div class="stat-card">
                <div class="stat-value">{discoveryStats.banned}</div>
                <div class="stat-label">Banned</div>
              </div>
              <div class="stat-card">
                <div class="stat-value">{discoveryStats.unavailable}</div>
                <div class="stat-label">Unavailable</div>
              </div>
              <div class="stat-card">
                <div class="stat-value">{discoveryStats.muted}</div>
                <div class="stat-label">Muted</div>
              </div>
              <div class="stat-card">
                <div class="stat-value">{profileScanManager.progressPercent ?? '—'}</div>
                <div class="stat-label">Progress %</div>
              </div>
            </div>

            <div class="discovery-controls">
              <label class="toggle-row" title={profileScanManager.detailText}>
                <input
                  type="checkbox"
                  checked={profileScanManager.autoEnabled}
                  onchange={(event) => profileScanManager.setAutoEnabled((event.currentTarget as HTMLInputElement).checked)}
                />
                <span>Auto scan newly discovered subreddits</span>
              </label>
              <div class="cache-actions">
                <button class="action-btn" onclick={scanNextProfiles} disabled={scanBusy}>{scanBusy ? 'Scanning…' : 'Scan next 20'}</button>
                <button class="action-btn" onclick={scanAllDueProfiles} disabled={scanBusy}>Full due scan</button>
                <button class="action-btn" onclick={scanFailedProfiles} disabled={scanBusy}>Rescan failed</button>
                <button class="action-btn" onclick={scanUnavailableProfiles} disabled={scanBusy}>Recheck unavailable</button>
                <button class="action-btn action-btn--danger" onclick={rescanAllProfiles} disabled={scanBusy}>Force rescan all</button>
                {#if profileScanManager.paused}
                  <button class="action-btn" onclick={() => profileScanManager.resume()}>Resume</button>
                {:else}
                  <button class="action-btn" onclick={() => profileScanManager.pause()} disabled={!scanBusy && profileScanManager.queuedCount === 0}>Pause</button>
                {/if}
              </div>
              {#if profileScanManager.fixedTotalProgress}
                <div class="scan-progress" title={profileScanManager.detailText}>
                  <span style={`width:${profileScanManager.progressPercent ?? 0}%`}></span>
                </div>
              {/if}
              <p class="scan-detail" title={profileScanManager.detailText}>{profileScanManager.detailText}</p>
              {#if scanMessage}<p class="success">{scanMessage}</p>{/if}
            </div>

            <div class="data-table discovery-table">
              {#each editableSubreddits as sub}
                <div class="data-row discovery-row" class:muted-row={sub.isMuted}>
                  <a href="/r/{sub.name}" class="sub-link">r/{sub.name}</a>
                  <input
                    class="rating-input"
                    type="number"
                    value={sub.localRating}
                    title="Local rating"
                    onchange={(event) => updateSubredditRatingFromInput(sub, event)}
                  />
                  <span class="field">{sub.discoveryStatus ?? 'discovered'}</span>
                  {#if sub.availabilityStatus && sub.availabilityStatus !== 'available'}
                    <span class="field" class:error={isSubredditUnavailable(sub)}>
                      {sub.availabilityStatus}
                    </span>
                  {/if}
                  {#if sub.profileFetchedAt}
                    <span class="field meta">profile: {new Date(sub.profileFetchedAt).toLocaleString()}</span>
                  {:else}
                    <span class="field meta">profile: unscanned</span>
                  {/if}
                  {#if sub.availabilityCheckedAt}
                    <span class="field meta">availability: {new Date(sub.availabilityCheckedAt).toLocaleString()}</span>
                  {/if}
                  {#if sub.availabilityDetail}<span class="field error">{sub.availabilityDetail}</span>{/if}
                  {#if sub.profileFetchError}<span class="field error">{sub.profileFetchError}</span>{/if}
                  <label class="row-toggle">
                    <input
                      type="checkbox"
                      checked={sub.isMuted}
                      onchange={(event) => toggleSubredditMuted(sub, event)}
                    />
                    <span>muted</span>
                  </label>
                  <button class="row-action" onclick={() => scanOneProfile(sub.name)} disabled={scanBusy}>
                    {isSubredditUnavailable(sub) ? 'recheck' : 'scan'}
                  </button>
                  {#if sub.profileFetchError}
                    <button class="row-action" onclick={() => clearSubredditFailure(sub)}>clear fail</button>
                  {/if}
                </div>
              {/each}
            </div>
          </section>

        {:else if activeTab === 'subreddits'}
          <div class="data-table">
            {#each sortedSubreddits as sub}
              <div class="data-row">
                <a href="/r/{sub.name}" class="sub-link">r/{sub.name}</a>
                <span class="field">rating: <strong>{sub.localRating}</strong></span>
                <span class="field">{sub.discoveryStatus ?? 'discovered'}</span>
                {#if sub.availabilityStatus && sub.availabilityStatus !== 'available'}
                  <span class="field error">{sub.availabilityStatus}</span>
                {/if}
                <span class="field">{sub.isMuted ? 'muted' : ''}</span>
                {#if sub.subscribers}<span class="field meta">{sub.subscribers.toLocaleString()} subscribers</span>{/if}
                {#if sub.profileFetchedAt}<span class="field meta">profile: {new Date(sub.profileFetchedAt).toLocaleString()}</span>{/if}
                {#if sub.profileFetchError}<span class="field error">{sub.profileFetchError}</span>{/if}
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
                <span class="field">count: <strong>{link.count ?? 1}</strong></span>
                <span class="field">weight: <strong>{(link.weight ?? 1).toFixed(1)}</strong></span>
                {#if link.evidence}<span class="field meta evidence">"{link.evidence.slice(0, 40)}"</span>{/if}
              </div>
            {/each}
          </div>
          <h2 class="snapshot-heading">Recent Feed Snapshots</h2>
          <div class="data-table">
            {#each snapshots as snapshot}
              <div class="data-row">
                <a href={snapshot.path} class="sub-link">{snapshot.path}</a>
                <span class="field">{snapshot.postIds.length} posts</span>
                <span class="field">index {snapshot.currentIndex + 1}</span>
                <span class="field meta">{new Date(snapshot.updatedAt).toLocaleString()}</span>
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
  main { max-width: 960px; margin: 0 auto; padding: 32px 16px; }
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
  .tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid #222; flex-wrap: wrap; }
  .tab {
    background: none; border: none; color: #888; padding: 8px 16px;
    font-size: 0.9rem; cursor: pointer; border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .tab:hover { color: #e0e0e0; }
  .tab.active { color: #6ab0de; border-bottom-color: #6ab0de; }
  .tab-content { min-height: 300px; }
  .export-import { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 24px; }
  .cache-panel { display: flex; flex-direction: column; gap: 20px; }
  .discovery-panel { display: flex; flex-direction: column; gap: 18px; }
  .cache-panel-header {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .cache-summary-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 12px;
    margin-bottom: 12px;
  }
  .cache-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 12px;
  }
  .cache-stats-grid { margin-bottom: 0; }
  .cache-detail-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 16px;
  }
  .cache-detail-card {
    background: #111;
    border: 1px solid #222;
    border-radius: 8px;
    padding: 16px;
  }
  .cache-detail-card h3 {
    margin: 0 0 12px;
    font-size: 1rem;
  }
  .cache-meta {
    color: #666;
    font-size: 0.8rem;
    word-break: break-all;
  }
  section p { color: #888; font-size: 0.85rem; margin-bottom: 12px; }
  .action-btn {
    background: #2a4a6a; color: #e0e0e0; border: none;
    padding: 8px 16px; border-radius: 4px; font-size: 0.9rem;
  }
  .action-btn--danger { background: #6a3030; }
  .action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .discovery-controls {
    display: grid;
    gap: 10px;
    padding: 14px;
    background: #101010;
    border: 1px solid #222;
    border-radius: 8px;
  }
  .toggle-row,
  .row-toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: #aaa;
    font-size: 0.84rem;
  }
  .scan-progress {
    height: 7px;
    overflow: hidden;
    background: #181818;
    border: 1px solid #262626;
    border-radius: 999px;
  }
  .scan-progress span {
    display: block;
    height: 100%;
    background: #6ade8a;
    transition: width 180ms ease;
  }
  .scan-detail {
    color: #888;
    font-size: 0.78rem;
    line-height: 1.4;
  }
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
  .discovery-row { gap: 10px; }
  .discovery-row.muted-row { opacity: 0.58; }
  .rating-input {
    width: 64px;
    background: #151515;
    color: #e0e0e0;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 5px 6px;
    font-size: 0.78rem;
  }
  .row-action {
    background: #1d2f42;
    color: #d8e5ef;
    border: 1px solid #2b4054;
    border-radius: 4px;
    padding: 5px 8px;
    font-size: 0.72rem;
  }
  .row-action:disabled { opacity: 0.5; cursor: not-allowed; }
  .sub-link { color: #6ab0de; }
  .field { color: #888; }
  .meta { color: #555; font-size: 0.75rem; }
  .event-type { color: #aaa; font-weight: 500; min-width: 120px; }
  .arrow { color: #555; }
  .evidence { font-style: italic; }
  .snapshot-heading { margin-top: 24px; }

  @media (max-width: 1100px) {
    .export-import {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 860px) {
    .export-import { grid-template-columns: 1fr; }
    .cache-summary-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
