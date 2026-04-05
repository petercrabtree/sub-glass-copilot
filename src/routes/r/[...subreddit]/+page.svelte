<script lang="ts">
  import { page } from '$app/stores';
  import { onMount, onDestroy } from 'svelte';
  import type { PostRecord } from '$lib/types';
  import { fetchListing } from '$lib/transport/reddit';
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
  let error = $state<string | null>(null);
  let seenIds = $state(new Set<string>());
  let afterCursor = $state<string | null>(null);
  let loadingMore = $state(false);
  let subredditParam = $state('');
  let pathInput = $state('');

  $effect(() => {
    const sub = $page.params.subreddit || 'all';
    subredditParam = sub;
    pathInput = `/r/${sub}`;
    loadFeed(sub);
  });

  async function loadFeed(sub: string) {
    loading = true;
    error = null;
    posts = [];
    currentIndex = 0;
    galleryIndex = 0;
    afterCursor = null;
    seenIds = await getSeenPostIds();

    const spec = { path: `/r/${sub}`, subreddits: sub.split('+') };
    const result = await fetchListing(spec, 25);
    if (!result) {
      error = 'Failed to fetch feed. Reddit may be blocking this request.';
      loading = false;
      return;
    }

    afterCursor = result.data.after || null;
    const normalized = normalizeListingResponse(result.data.children);
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
    const spec = { path: `/r/${subredditParam}`, subreddits: subredditParam.split('+'), after: afterCursor };
    const result = await fetchListing(spec, 25);
    if (result) {
      afterCursor = result.data.after || null;
      const normalized = normalizeListingResponse(result.data.children);
      const mediaPosts = normalized.filter(p => p.media);
      await Promise.all(mediaPosts.map(async (p) => {
        await upsertPost(p);
        if (p.media) await upsertMedia(p.media);
        await ensureSubreddit(p.subreddit);
      }));
      posts = [...posts, ...mediaPosts];
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
    const newRating = existing?.localRating === 1 ? undefined : (1 as 1);
    await setPostRating(currentPost.id, newRating as 1 | -1 | undefined);
    posts = posts.map(p => p.id === currentPost.id ? { ...p, localRating: newRating as 1 | -1 | undefined } : p);
    await recordEvent('rating_explicit', currentPost);
    if (newRating === 1) await updateSubredditRating(currentPost.subreddit, 1);
    else if (existing?.localRating === 1) await updateSubredditRating(currentPost.subreddit, -1);
  }

  async function rateDown() {
    if (!currentPost) return;
    const existing = await getPost(currentPost.id);
    const newRating = existing?.localRating === -1 ? undefined : (-1 as -1);
    await setPostRating(currentPost.id, newRating as 1 | -1 | undefined);
    posts = posts.map(p => p.id === currentPost.id ? { ...p, localRating: newRating as 1 | -1 | undefined } : p);
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
    window.addEventListener('keydown', handleKeydown);
  });

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeydown);
  });

  async function navigate() {
    const match = pathInput.match(/^\/?(r\/[^?#]+)/);
    if (match) {
      const { goto } = await import('$app/navigation');
      goto(`/${match[1]}`);
    }
  }
</script>

<div class="viewer-page">
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

  {#if loading}
    <div class="loading">Loading feed…</div>
  {:else if error}
    <div class="error">
      <p>{error}</p>
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
</style>
