<script lang="ts">
  import { dev } from '$app/environment';
  import { page } from '$app/stores';
  import { onMount, onDestroy } from 'svelte';
  import type { PostRecord } from '$lib/types';
  import { fetchListing, readRedditDebugState } from '$lib/transport/reddit';
  import type { RedditDebugState, RedditRequestError } from '$lib/transport/reddit';
  import { normalizeListingResponse } from '$lib/normalize/posts';
  import {
    upsertPost, upsertSubreddit, upsertMedia, upsertAdjacency,
    markPostSeen, setPostRating, getPost, getSeenPostIds, addEvent,
    getSubreddit, updateSubredditRating,
  } from '$lib/db/store';
  import { extractLinksFromPost } from '$lib/adjacency/extract';
  import MediaViewer from '$lib/components/MediaViewer.svelte';
  import PostOverlay from '$lib/components/PostOverlay.svelte';

  // State
  let posts = $state<PostRecord[]>([]);
  let currentIndex = $state(0);
  let galleryIndex = $state(0);
  let loading = $state(false);
  let error = $state<RedditRequestError | null>(null);
  let seenIds = $state(new Set<string>());
  let afterCursor = $state<string | null>(null);
  let loadingMore = $state(false);
  let subredditParam = $state('');
  let pathInput = $state('');
  let redditDebug = $state<RedditDebugState | null>(null);
  let listingTime = $state<string | undefined>(undefined);

  function formatErrorJson(error: RedditRequestError): string {
    return JSON.stringify(error, null, 2);
  }

  function formatCurlCommand(url: string): string {
    return `curl -i -A 'Mozilla/5.0' -H 'Accept: application/json' '${url}'`;
  }

  function syncRedditDebug() {
    redditDebug = readRedditDebugState();
  }

  function formatTimestamp(ts: number): string {
    return new Date(ts).toLocaleTimeString();
  }

  const feedStatus = $derived(
    error ? `error:${error.kind}` : loading ? 'loading' : posts.length > 0 ? 'ready' : 'idle'
  );

  $effect(() => {
    const sub = $page.params.subreddit || 'all';
    const time = $page.url.searchParams.get('t') || undefined;
    subredditParam = sub;
    listingTime = time;
    pathInput = time ? `/r/${sub}?t=${time}` : `/r/${sub}`;
    loadFeed(sub, time);
  });

  $effect(() => {
    if (!dev || typeof document === 'undefined') return;
    const suffix =
      error ? `ERR ${error.kind}` :
      loading ? 'LOADING' :
      posts.length > 0 ? 'READY' :
      'IDLE';
    document.title = `SubGlass [${suffix}]`;
  });

  function extractSubreddits(sub: string) {
    return sub.split('/')[0]?.split('+') ?? [];
  }

  async function loadFeed(sub: string, time: string | undefined = listingTime) {
    loading = true;
    error = null;
    posts = [];
    currentIndex = 0;
    galleryIndex = 0;
    afterCursor = null;
    seenIds = await getSeenPostIds();

    const spec = { path: `/r/${sub}`, subreddits: extractSubreddits(sub), time };
    const result = await fetchListing(spec, 25);
    syncRedditDebug();
    if (!result.ok) {
      console.error('Failed to load feed', result.error);
      error = result.error;
      loading = false;
      return;
    }

    afterCursor = result.data.data.after || null;
    const normalized = normalizeListingResponse(result.data.data.children);
    const mediaPosts = normalized.filter(p => p.media);

    await Promise.all(mediaPosts.map(async (p) => {
      await upsertPost(p);
      if (p.media) await upsertMedia(p.media);
      await ensureSubreddit(p.subreddit);
      const links = extractLinksFromPost(p.title, '', p.subreddit, undefined);
      for (const link of links) {
        await upsertAdjacency(link);
        await ensureSubreddit(link.toSubreddit);
      }
    }));

    posts = mediaPosts;
    loading = false;

    if (mediaPosts.length > 0) {
      await recordEvent('impression', mediaPosts[0]);
    }
  }

  async function loadMore() {
    if (loadingMore || !afterCursor) return;
    loadingMore = true;
    const spec = {
      path: `/r/${subredditParam}`,
      subreddits: extractSubreddits(subredditParam),
      after: afterCursor,
      time: listingTime
    };
    const result = await fetchListing(spec, 25);
    syncRedditDebug();
    if (result.ok) {
      afterCursor = result.data.data.after || null;
      const normalized = normalizeListingResponse(result.data.data.children);
      const mediaPosts = normalized.filter(p => p.media);
      await Promise.all(mediaPosts.map(async (p) => {
        await upsertPost(p);
        if (p.media) await upsertMedia(p.media);
        await ensureSubreddit(p.subreddit);
      }));
      posts = [...posts, ...mediaPosts];
    } else {
      console.error('Failed to load more posts', result.error);
    }
    loadingMore = false;
  }

  async function ensureSubreddit(name: string) {
    const existing = await getSubreddit(name);
    if (!existing) {
      await upsertSubreddit({
        name: name.toLowerCase(),
        prefixedName: `r/${name.toLowerCase()}`,
        firstSeenAt: Date.now(),
        localRating: 0,
        isMuted: false,
      });
    }
  }

  const currentPost = $derived(posts[currentIndex]);
  const currentMedia = $derived(currentPost?.media);
  const currentItem = $derived(currentMedia?.items?.[galleryIndex]);
  const totalItems = $derived(currentMedia?.items?.length ?? 0);
  const isSeen = $derived(currentPost ? seenIds.has(currentPost.id) : false);

  async function recordEvent(type: string, post: PostRecord | undefined) {
    if (!post) return;
    await addEvent({
      type: type as Parameters<typeof addEvent>[0]['type'],
      postId: post.id,
      mediaId: post.media?.id,
      subreddit: post.subreddit,
      ts: Date.now(),
    });
  }

  async function advance() {
    if (!currentPost) return;
    await markPostSeen(currentPost.id);
    seenIds = new Set([...seenIds, currentPost.id]);
    await recordEvent('advance_next', currentPost);
    await recordEvent('view_end', currentPost);

    if (currentIndex < posts.length - 1) {
      currentIndex++;
      galleryIndex = 0;
      await recordEvent('impression', posts[currentIndex]);
      await recordEvent('view_start', posts[currentIndex]);

      if (currentIndex >= posts.length - 5) loadMore();
    }
  }

  async function retreat() {
    if (currentIndex > 0) {
      await recordEvent('view_end', currentPost);
      currentIndex--;
      galleryIndex = 0;
      await recordEvent('impression', posts[currentIndex]);
    }
  }

  async function advanceGallery() {
    if (!currentMedia) return;
    if (galleryIndex < currentMedia.items.length - 1) {
      galleryIndex++;
      await recordEvent('advance_gallery', currentPost);
    } else {
      await advance();
    }
  }

  async function retreatGallery() {
    if (galleryIndex > 0) {
      galleryIndex--;
    } else {
      await retreat();
    }
  }

  async function rateUp() {
    if (!currentPost) return;
    const existing = await getPost(currentPost.id);
    const newRating: 1 | undefined = existing?.localRating === 1 ? undefined : 1;
    await setPostRating(currentPost.id, newRating);
    posts = posts.map(p => p.id === currentPost.id ? { ...p, localRating: newRating } : p);
    await recordEvent('rating_explicit', currentPost);
    if (newRating === 1) await updateSubredditRating(currentPost.subreddit, 1);
    else if (existing?.localRating === 1) await updateSubredditRating(currentPost.subreddit, -1);
  }

  async function rateDown() {
    if (!currentPost) return;
    const existing = await getPost(currentPost.id);
    const newRating: -1 | undefined = existing?.localRating === -1 ? undefined : -1;
    await setPostRating(currentPost.id, newRating);
    posts = posts.map(p => p.id === currentPost.id ? { ...p, localRating: newRating } : p);
    await recordEvent('rating_explicit', currentPost);
    if (newRating === -1) await updateSubredditRating(currentPost.subreddit, -1);
    else if (existing?.localRating === -1) await updateSubredditRating(currentPost.subreddit, 1);
  }

  async function openReddit() {
    if (!currentPost) return;
    window.open(`https://reddit.com${currentPost.permalink}`, '_blank');
    await recordEvent('open_reddit', currentPost);
  }

  async function openMedia() {
    if (!currentItem) return;
    window.open(currentItem.url, '_blank');
    await recordEvent('open_media', currentPost);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    switch (e.key) {
      case 'ArrowDown':
      case 'j':
        e.preventDefault();
        if (currentMedia?.kind === 'gallery') advanceGallery();
        else advance();
        break;
      case 'ArrowUp':
      case 'k':
        e.preventDefault();
        if (currentMedia?.kind === 'gallery') retreatGallery();
        else retreat();
        break;
      case 'ArrowRight':
      case 'l':
        e.preventDefault();
        if (currentMedia?.kind === 'gallery') advanceGallery();
        else advance();
        break;
      case 'ArrowLeft':
      case 'h':
        e.preventDefault();
        if (currentMedia?.kind === 'gallery') retreatGallery();
        else retreat();
        break;
      case ' ':
        e.preventDefault();
        advance();
        break;
      case 'r':
      case 'R':
        openReddit();
        break;
      case 'o':
        openMedia();
        break;
      case 'u':
        rateUp();
        break;
      case 'd':
        rateDown();
        break;
    }
  }

  onMount(() => {
    syncRedditDebug();
    window.addEventListener('keydown', handleKeydown);
  });

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeydown);
  });

  async function navigate() {
    const normalized = pathInput.trim().startsWith('/') ? pathInput.trim() : `/${pathInput.trim()}`;
    if (normalized.startsWith('/r/')) {
      const { goto } = await import('$app/navigation');
      goto(normalized);
    }
  }
</script>

<div class="viewer-page" data-feed-status={feedStatus}>
  <nav class="topbar">
    <a href="/r/all" class="logo">SubGlass</a>
    <form onsubmit={(e) => { e.preventDefault(); navigate(); }} class="path-form">
      <input
        type="text"
        bind:value={pathInput}
        placeholder="/r/subreddit"
        class="path-input"
        aria-label="Subreddit path"
      />
      <button type="submit">Go</button>
    </form>
    <div class="nav-links">
      <a href="/r/all">all</a>
      <a href="/r/pics">pics</a>
      <a href="/r/videos">videos</a>
      <a href="/discover">discover</a>
      <a href="/admin">admin</a>
    </div>
  </nav>

  {#if dev}
    <details class="debug-tray" open={!!error}>
      <summary>
        <span>Feed Debug</span>
        <span class:error-state={!!error} class:loading-state={loading} class:ready-state={!error && !loading && posts.length > 0} class="debug-state">
          {feedStatus}
        </span>
      </summary>
      {#if redditDebug?.lastEntry}
        <div class="debug-grid">
          <div><strong>Scope:</strong> <code>{redditDebug.lastEntry.scope}</code></div>
          <div><strong>Fetched:</strong> <code>{formatTimestamp(redditDebug.lastEntry.fetchedAt)}</code></div>
          <div><strong>Duration:</strong> <code>{redditDebug.lastEntry.durationMs}ms</code></div>
          <div><strong>Status:</strong> <code>{redditDebug.lastEntry.status ?? 'n/a'} {redditDebug.lastEntry.statusText ?? ''}</code></div>
          <div class="debug-span"><strong>URL:</strong> <code>{redditDebug.lastEntry.url}</code></div>
        </div>
        <details class="debug-block" open={!!error}>
          <summary>Last Request</summary>
          <pre>{JSON.stringify(redditDebug.lastEntry, null, 2)}</pre>
        </details>
        <details class="debug-block">
          <summary>Repro</summary>
          <pre>{formatCurlCommand(redditDebug.lastEntry.url)}</pre>
        </details>
      {:else}
        <p class="debug-empty">No Reddit request captured yet.</p>
      {/if}
    </details>
  {/if}

  {#if loading}
    <div class="loading">Loading feed…</div>
  {:else if error}
    <div class="error">
      <div class="error-header">
        <p class="error-title">Feed fetch failed</p>
        <code class="error-badge">{error.kind}</code>
      </div>
      <p class="error-summary">{error.message}</p>
      <details class="error-details" open>
        <summary>Request</summary>
        <div class="error-meta">
          <div><strong>URL:</strong> <code>{error.url}</code></div>
          {#if error.status !== undefined}
            <div><strong>Status:</strong> <code>{error.status} {error.statusText}</code></div>
          {/if}
          {#if error.contentType}
            <div><strong>Content-Type:</strong> <code>{error.contentType}</code></div>
          {/if}
          {#if error.cause}
            <div><strong>Cause:</strong> <code>{error.cause}</code></div>
          {/if}
          {#if error.responseSnippet}
            <div class="error-body">
              <strong>Response preview:</strong>
              <pre>{error.responseSnippet}</pre>
            </div>
          {/if}
        </div>
      </details>
      <details class="error-details" open>
        <summary>Repro</summary>
        <pre class="error-pre">{formatCurlCommand(error.url)}</pre>
      </details>
      <details class="error-details">
        <summary>Raw Error</summary>
        <pre class="error-pre">{formatErrorJson(error)}</pre>
      </details>
      <button onclick={() => loadFeed(subredditParam)}>Retry</button>
    </div>
  {:else if posts.length === 0}
    <div class="empty">No media posts found in /r/{subredditParam}</div>
  {:else}
    <div class="feed">
      {#if currentPost && currentMedia}
        <MediaViewer
          media={currentMedia}
          itemIndex={galleryIndex}
          onevent={(detail) => addEvent({ ...detail, ts: Date.now(), type: detail.type as Parameters<typeof addEvent>[0]['type'] })}
        />
        <PostOverlay
          post={currentPost}
          mediaIndex={galleryIndex}
          totalMedia={totalItems}
          postIndex={currentIndex}
          totalPosts={posts.length}
          isSeen={isSeen}
          onadvance={advance}
          onretreat={retreat}
          onrateUp={rateUp}
          onrateDown={rateDown}
          onopenReddit={openReddit}
          onopenMedia={openMedia}
        />
      {/if}
    </div>
  {/if}
</div>

<style>
  .viewer-page {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
    background: #0a0a0a;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    background: #111;
    border-bottom: 1px solid #222;
    flex-shrink: 0;
    z-index: 100;
  }
  .logo {
    font-weight: 700;
    font-size: 1.1rem;
    color: #6ab0de;
    white-space: nowrap;
  }
  .path-form {
    display: flex;
    gap: 4px;
    flex: 1;
    max-width: 300px;
  }
  .path-input {
    background: #1a1a1a;
    border: 1px solid #333;
    color: #e0e0e0;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 0.85rem;
    flex: 1;
  }
  .path-form button {
    background: #2a4a6a;
    color: #e0e0e0;
    border: none;
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 0.85rem;
  }
  .nav-links {
    display: flex;
    gap: 12px;
    font-size: 0.85rem;
  }
  .nav-links a { color: #999; }
  .nav-links a:hover { color: #e0e0e0; }
  .feed {
    flex: 1;
    position: relative;
    overflow: hidden;
  }
  .debug-tray {
    background: #0f0f0f;
    border-bottom: 1px solid #242424;
    padding: 10px 16px;
  }
  .debug-tray summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
    color: #d7d7d7;
    font-size: 0.9rem;
  }
  .debug-state {
    border-radius: 999px;
    border: 1px solid #3a3a3a;
    padding: 2px 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.78rem;
  }
  .error-state {
    color: #f1b3b3;
    border-color: #6a3232;
    background: #261414;
  }
  .loading-state {
    color: #e0d29a;
    border-color: #655a2e;
    background: #241f10;
  }
  .ready-state {
    color: #a7dfb0;
    border-color: #2c6136;
    background: #122015;
  }
  .debug-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px 16px;
    margin-top: 12px;
    color: #bcbcbc;
    font-size: 0.9rem;
  }
  .debug-span {
    grid-column: 1 / -1;
  }
  .debug-grid code,
  .debug-block pre {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  .debug-grid code {
    color: #ebebeb;
    word-break: break-all;
  }
  .debug-block {
    margin-top: 10px;
    background: #141414;
    border: 1px solid #272727;
    border-radius: 8px;
    padding: 10px 12px;
  }
  .debug-block summary {
    cursor: pointer;
    color: #d7d7d7;
  }
  .debug-block pre {
    margin: 10px 0 0;
    white-space: pre-wrap;
    word-break: break-word;
    background: #0d0d0d;
    border: 1px solid #252525;
    border-radius: 6px;
    padding: 10px;
    color: #cfcfcf;
  }
  .debug-empty {
    margin: 12px 0 0;
    color: #8f8f8f;
  }
  .loading,
  .error,
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: calc(100vh - 48px);
    color: #888;
    gap: 16px;
  }
  .error button {
    background: #2a4a6a;
    color: #e0e0e0;
    border: none;
    padding: 8px 16px;
    border-radius: 4px;
  }
  .error {
    padding: 24px;
    text-align: left;
    max-width: 900px;
    margin: 0 auto;
  }
  .error-title {
    color: #f1b3b3;
    font-weight: 600;
    margin: 0;
  }
  .error-header {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .error-badge {
    padding: 4px 8px;
    border-radius: 999px;
    border: 1px solid #3a3a3a;
    background: #161616;
    color: #d7d7d7;
    font-size: 0.8rem;
    text-transform: lowercase;
  }
  .error-summary {
    width: 100%;
    margin: 0;
    color: #d7d7d7;
  }
  .error-details {
    width: 100%;
    background: #141414;
    border: 1px solid #2b2b2b;
    border-radius: 8px;
    padding: 12px 14px;
  }
  .error-details summary {
    cursor: pointer;
    color: #d0d0d0;
  }
  .error-meta {
    display: grid;
    gap: 10px;
    margin-top: 12px;
    color: #b8b8b8;
    font-size: 0.92rem;
  }
  .error-meta code,
  .error-body pre,
  .error-pre {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  .error-meta code {
    word-break: break-all;
    color: #e8e8e8;
  }
  .error-body {
    display: grid;
    gap: 6px;
  }
  .error-body pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    background: #0d0d0d;
    border: 1px solid #252525;
    border-radius: 6px;
    padding: 10px;
    color: #cfcfcf;
  }
  .error-pre {
    margin: 10px 0 0;
    width: 100%;
    white-space: pre-wrap;
    word-break: break-word;
    background: #0d0d0d;
    border: 1px solid #252525;
    border-radius: 6px;
    padding: 10px;
    color: #cfcfcf;
  }
</style>
