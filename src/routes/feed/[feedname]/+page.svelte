<script lang="ts">
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { getPost, markPostSeen, setPostRating, updateSubredditRating, addEvent } from '$lib/db/store';
  import {
    buildFeedRun,
    loadFeedRun,
    refillFeedSources,
    setFeedRunIndex,
    setFeedRunLocked,
    type FeedRunState,
  } from '$lib/feed/engine';
  import { normalizeFeedName } from '$lib/feed/recipes';
  import MediaViewer from '$lib/components/MediaViewer.svelte';
  import PostOverlay from '$lib/components/PostOverlay.svelte';
  import type {
    FeedRun,
    FeedRunItem,
    FeedScoreDetail,
    MediaGroup,
    MediaKind,
    PostRecord,
    SignalEventType,
  } from '$lib/types';
  import type { MediaCacheRuntimeState, MediaCacheState } from '$lib/service-worker/media-cache';
  import type { VideoPreloadState } from '$lib/media/video-preload';
  import { getViewerActionForKey } from '$lib/viewer/keyboard';

  type LoadedMediaStatus = 'queued' | 'seen' | 'loading' | 'ready' | 'error';
  type LoadedVideoPreloadState = VideoPreloadState | 'skipped' | 'not-planned' | 'visible';
  type LoadedMediaQueueItem = {
    id: string;
    index: number;
    kind: MediaKind | 'unknown';
    title: string;
    itemCount: number;
    rating?: 1 | -1;
    status: LoadedMediaStatus;
    previewUrl?: string;
    cacheUrl?: string;
    cacheState: MediaCacheState;
    videoPreloadState: LoadedVideoPreloadState;
    sourceLabel?: string;
    slot?: string;
    score?: number;
    reason?: string;
  };
  type WhyPostDetail = {
    label: string;
    value: string;
    tone?: 'positive' | 'negative' | 'warning' | 'muted';
  };
  type WhyPostInfo = {
    summary: string;
    details: WhyPostDetail[];
  };

  let feedName = $state('random');
  let feedState = $state<FeedRunState | null>(null);
  let posts = $state<PostRecord[]>([]);
  let items = $state<FeedRunItem[]>([]);
  let run = $state<FeedRun | null>(null);
  let currentIndex = $state(0);
  let galleryIndex = $state(0);
  let loading = $state(true);
  let refilling = $state(false);
  let refreshingTail = $state(false);
  let error = $state('');
  let message = $state('');
  let currentMediaLoadState = $state<'loading' | 'ready' | 'error'>('loading');

  const currentPost = $derived(posts[currentIndex]);
  const currentRunItem = $derived(items[currentIndex]);
  const currentMedia = $derived(currentPost?.media);
  const currentItem = $derived(currentMedia?.items?.[galleryIndex] ?? currentMedia?.items?.[0]);
  const totalItems = $derived(currentMedia?.items?.length ?? 0);
  const imageCacheMode = $derived<MediaCacheRuntimeState>('inactive');
  const queueHealth = $derived(formatQueueHealth());
  const loadedMediaStates = $derived<LoadedMediaQueueItem[]>(
    posts.map((post, index) => {
      const item = items[index];
      return {
        id: post.id,
        index,
        kind: post.media?.kind ?? 'unknown',
        title: post.title,
        itemCount: post.media?.items.length ?? 0,
        rating: post.localRating,
        status: index === currentIndex ? currentMediaLoadState : index < currentIndex ? 'seen' : 'queued',
        previewUrl: getLoadedMediaPreviewUrl(post.media, index === currentIndex ? galleryIndex : 0),
        cacheState: 'skipped',
        videoPreloadState: post.media?.kind === 'video'
          ? index === currentIndex ? 'visible' : 'not-planned'
          : 'skipped',
        sourceLabel: item?.sourceLabel,
        slot: item?.committed ? 'committed' : item?.slot,
        score: item?.score,
        reason: item?.scoreDetails?.[0]?.label,
      };
    })
  );
  const currentWhyPost = $derived(buildWhyPostInfo(currentPost, currentRunItem));

  $effect(() => {
    const nextFeedName = normalizeFeedName($page.params.feedname);
    if (nextFeedName === feedName && feedState) return;
    feedName = nextFeedName;
    void loadFeed(nextFeedName);
  });

  function applyState(nextState: FeedRunState) {
    feedState = nextState;
    run = nextState.run;
    items = nextState.items;
    posts = nextState.posts;
    currentIndex = Math.min(nextState.run.currentIndex, Math.max(0, nextState.posts.length - 1));
    galleryIndex = 0;
    resetMediaState();
  }

  async function loadFeed(name: string) {
    loading = true;
    error = '';
    message = '';
    try {
      const initial = await buildFeedRun(name);
      if (initial.posts.length < 8) {
        refilling = true;
        const refill = await refillFeedSources(name);
        message = `refill ${refill.ok}/${refill.attempted} sources · ${refill.mediaPosts} media`;
        applyState(await buildFeedRun(name, { refreshTail: true }));
      } else {
        applyState(initial);
      }
    } catch (loadError) {
      error = loadError instanceof Error ? loadError.message : String(loadError);
    } finally {
      refilling = false;
      loading = false;
    }
  }

  function resetMediaState() {
    currentMediaLoadState = currentMedia ? 'loading' : 'error';
  }

  function getLoadedMediaPreviewUrl(media: MediaGroup | undefined, selectedItemIndex = 0): string | undefined {
    if (!media) return undefined;
    const selectedItem = media.items[selectedItemIndex] ?? media.items[0];
    if (media.kind === 'video') return media.thumbnailUrl;
    if (media.kind === 'external_video') return media.thumbnailUrl ?? selectedItem?.url;
    return selectedItem?.url ?? media.thumbnailUrl;
  }

  function formatQueueHealth() {
    if (!feedState) return 'no feed';
    const ahead = Math.max(0, posts.length - currentIndex - 1);
    const committed = items.filter((item) => item.committed).length;
    const sources = new Set(items.map((item) => item.sourceKey).filter(Boolean)).size;
    return `${ahead} ahead · ${committed} committed · ${sources} sources`;
  }

  function formatScoreDetail(detail: FeedScoreDetail): WhyPostDetail {
    return {
      label: detail.label,
      value: `${detail.value} (${detail.contribution > 0 ? '+' : ''}${detail.contribution.toFixed(1)})`,
      tone: detail.tone,
    };
  }

  function buildWhyPostInfo(post: PostRecord | undefined, item: FeedRunItem | undefined): WhyPostInfo | undefined {
    if (!post || !item) return undefined;
    const details: WhyPostDetail[] = [
      { label: 'feed', value: `${feedName} · ${item.committed ? 'committed' : 'tail'}` },
      { label: 'source', value: item.sourceLabel ?? post.fetchedInRoute ?? 'local db' },
      { label: 'slot', value: item.slot },
      { label: 'score', value: item.score.toFixed(2), tone: item.score >= 0 ? 'positive' : 'negative' },
      { label: 'position', value: `${currentIndex + 1}/${posts.length}` },
      { label: 'media', value: `${post.media?.kind?.replaceAll('_', ' ') ?? 'unknown'} · ${post.score} pts` },
      ...item.scoreDetails.map(formatScoreDetail),
    ];

    return {
      summary: `${feedName} · score ${item.score.toFixed(1)} · ${item.sourceLabel ?? `r/${post.subreddit}`}`,
      details: details.slice(0, 10),
    };
  }

  async function recordEvent(type: SignalEventType, post: PostRecord | undefined, value?: number | string) {
    if (!post) return;
    await addEvent({
      type,
      postId: post.id,
      mediaId: post.media?.id,
      subreddit: post.subreddit,
      value,
      ts: Date.now(),
    });
  }

  async function persistIndex(nextIndex: number) {
    currentIndex = Math.min(Math.max(0, nextIndex), Math.max(0, posts.length - 1));
    galleryIndex = 0;
    resetMediaState();
    if (run) {
      run = await setFeedRunIndex(run, currentIndex);
    }
  }

  async function advance() {
    if (!currentPost) return;
    await markPostSeen(currentPost.id);
    await recordEvent('advance_next', currentPost);
    await recordEvent('view_end', currentPost);
    if (currentIndex < posts.length - 1) {
      await persistIndex(currentIndex + 1);
      await recordEvent('impression', posts[currentIndex]);
      await recordEvent('view_start', posts[currentIndex]);
    }
    if (posts.length - currentIndex - 1 <= 3) {
      void refreshTail();
    }
  }

  async function retreat() {
    if (currentIndex > 0) {
      await recordEvent('view_end', currentPost);
      await persistIndex(currentIndex - 1);
      await recordEvent('impression', posts[currentIndex]);
      await recordEvent('view_start', posts[currentIndex]);
    }
  }

  async function advanceGallery() {
    if (!currentMedia) return;
    if (galleryIndex < currentMedia.items.length - 1) {
      galleryIndex += 1;
      await recordEvent('advance_gallery', currentPost);
    } else {
      await advance();
    }
  }

  async function retreatGallery() {
    if (galleryIndex > 0) {
      galleryIndex -= 1;
    } else {
      await retreat();
    }
  }

  async function selectPost(index: number) {
    if (index < 0 || index >= posts.length) return;
    await recordEvent('view_end', currentPost);
    await persistIndex(index);
    await recordEvent('impression', posts[currentIndex]);
    await recordEvent('view_start', posts[currentIndex]);
  }

  async function rateUp() {
    if (!currentPost) return;
    const existing = await getPost(currentPost.id);
    const newRating: 1 | undefined = existing?.localRating === 1 ? undefined : 1;
    await setPostRating(currentPost.id, newRating);
    posts = posts.map((post) => post.id === currentPost.id ? { ...post, localRating: newRating } : post);
    await recordEvent('rating_explicit', currentPost, newRating ?? 0);
    const delta = (newRating ?? 0) - (existing?.localRating ?? 0);
    if (delta !== 0) await updateSubredditRating(currentPost.subreddit, delta);
  }

  async function rateDown() {
    if (!currentPost) return;
    const existing = await getPost(currentPost.id);
    const newRating: -1 | undefined = existing?.localRating === -1 ? undefined : -1;
    await setPostRating(currentPost.id, newRating);
    posts = posts.map((post) => post.id === currentPost.id ? { ...post, localRating: newRating } : post);
    await recordEvent('rating_explicit', currentPost, newRating ?? 0);
    const delta = (newRating ?? 0) - (existing?.localRating ?? 0);
    if (delta !== 0) await updateSubredditRating(currentPost.subreddit, delta);
  }

  async function openReddit() {
    if (!currentPost) return;
    window.open(`https://reddit.com${currentPost.permalink}`, '_blank');
    await recordEvent('open_reddit', currentPost);
  }

  async function openMedia() {
    if (!currentItem) return;
    window.open(currentItem.openUrl ?? currentItem.url, '_blank');
    await recordEvent('open_media', currentPost);
  }

  async function refreshTail() {
    if (refreshingTail || !run) return;
    refreshingTail = true;
    message = '';
    try {
      applyState(await buildFeedRun(feedName, { refreshTail: true, currentIndex }));
      message = 'tail refreshed from local candidates';
    } catch (refreshError) {
      error = refreshError instanceof Error ? refreshError.message : String(refreshError);
    } finally {
      refreshingTail = false;
    }
  }

  async function refillNow() {
    if (refilling) return;
    refilling = true;
    message = '';
    try {
      const refill = await refillFeedSources(feedName);
      applyState(await buildFeedRun(feedName, { refreshTail: true, currentIndex }));
      message = `refill ${refill.ok}/${refill.attempted} sources · ${refill.mediaPosts} media · ${refill.newPosts} new`;
    } catch (refillError) {
      error = refillError instanceof Error ? refillError.message : String(refillError);
    } finally {
      refilling = false;
    }
  }

  async function toggleLock() {
    if (!run) return;
    run = await setFeedRunLocked(run, !run.locked);
    message = run.locked ? 'queue locked' : 'queue unlocked';
  }

  async function reloadRun() {
    loading = true;
    try {
      applyState(await loadFeedRun(feedName));
    } finally {
      loading = false;
    }
  }

  function handleMediaStateChange(detail: { state: 'loading' | 'ready' | 'error' }) {
    currentMediaLoadState = detail.state;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    const action = getViewerActionForKey(event.key);
    if (!action) return;
    event.preventDefault();

    switch (action) {
      case 'skip_forward':
      case 'step_forward':
        void advance();
        break;
      case 'skip_backward':
      case 'step_backward':
        void retreat();
        break;
      case 'rate_up_next':
        void rateUp().then(advance);
        break;
      case 'rate_down_next':
        void rateDown().then(advance);
        break;
      case 'open_reddit':
        void openReddit();
        break;
      case 'open_media':
        void openMedia();
        break;
    }
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });
</script>

<svelte:head>
  <title>SubGlass Feed · {feedName}</title>
</svelte:head>

<div class="feed-page">
  <nav class="feed-rail">
    <a href="/r/all" class="brand">SubGlass</a>
    <a href="/feed/random" class:active={feedName === 'random'}>random</a>
    <a href="/feed/comfort" class:active={feedName === 'comfort'}>comfort</a>
    <a href="/feed/fresh" class:active={feedName === 'fresh'}>fresh</a>
    <a href="/feed/explore" class:active={feedName === 'explore'}>explore</a>
    <span class="feed-summary">{queueHealth}</span>
    <button type="button" onclick={toggleLock} disabled={!run}>{run?.locked ? 'Unlock' : 'Lock'}</button>
    <button type="button" onclick={refreshTail} disabled={refreshingTail || !run || run.locked}>
      {refreshingTail ? 'Refreshing…' : 'Refresh tail'}
    </button>
    <button type="button" onclick={refillNow} disabled={refilling}>
      {refilling ? 'Refilling…' : 'Refill sources'}
    </button>
    <button type="button" onclick={reloadRun} disabled={loading}>Reload</button>
  </nav>

  {#if loading}
    <div class="feed-state">Loading {feedName} feed…</div>
  {:else if error}
    <div class="feed-state error">
      <p>{error}</p>
      <button type="button" onclick={() => loadFeed(feedName)}>Retry</button>
    </div>
  {:else if posts.length === 0}
    <div class="feed-state empty">
      <p>No local candidates for {feedName} yet.</p>
      <button type="button" onclick={refillNow} disabled={refilling}>
        {refilling ? 'Refilling…' : 'Fetch source inventory'}
      </button>
      {#if message}<span>{message}</span>{/if}
    </div>
  {:else if currentPost && currentMedia}
    <div class="feed-viewer">
      {#key `${currentPost.id}:${currentMedia.id}:${galleryIndex}`}
        <MediaViewer
          media={currentMedia}
          itemIndex={galleryIndex}
          fit="contain"
          ambient={true}
          onevent={(detail) => addEvent({ ...detail, subreddit: currentPost.subreddit, ts: Date.now(), type: detail.type as SignalEventType })}
          onstatechange={handleMediaStateChange}
        />
      {/key}
      <PostOverlay
        post={currentPost}
        mediaIndex={galleryIndex}
        totalMedia={totalItems}
        postIndex={currentIndex}
        totalPosts={posts.length}
        loadedMedia={loadedMediaStates}
        imageCacheMode={imageCacheMode}
        whyPost={currentWhyPost}
        onadvance={advance}
        onretreat={retreat}
        onadvanceGallery={advanceGallery}
        onretreatGallery={retreatGallery}
        onselectLoadedMedia={selectPost}
        onrateUp={rateUp}
        onrateDown={rateDown}
        onopenReddit={openReddit}
        onopenMedia={openMedia}
      />
      {#if message}
        <p class="feed-message">{message}</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .feed-page {
    min-height: 100vh;
    background: #060708;
    color: #eef5fb;
  }
  .feed-rail {
    position: fixed;
    z-index: 20;
    top: 0;
    left: 0;
    right: auto;
    max-width: min(720px, calc(100vw - 20px));
    min-height: 38px;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 6px 8px;
    background: rgba(6, 7, 8, 0.82);
    border-right: 1px solid rgba(255, 255, 255, 0.08);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    border-bottom-right-radius: 8px;
    backdrop-filter: blur(14px);
  }
  .feed-rail a,
  .feed-rail button,
  .feed-summary {
    min-height: 26px;
    display: inline-flex;
    align-items: center;
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.06);
    color: #dbe8f3;
    font-size: 0.72rem;
    text-decoration: none;
    padding: 0 9px;
  }
  .feed-rail button {
    cursor: pointer;
  }
  .feed-rail button:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }
  .feed-rail a.active {
    background: rgba(145, 205, 236, 0.2);
    border-color: rgba(145, 205, 236, 0.42);
    color: #f4fbff;
  }
  .brand {
    font-weight: 700;
  }
  .feed-summary {
    color: #aebfcb;
    background: rgba(255, 255, 255, 0.035);
  }
  .feed-viewer {
    width: 100vw;
    height: 100vh;
    overflow: hidden;
  }
  .feed-state {
    min-height: 100vh;
    display: grid;
    place-content: center;
    gap: 14px;
    color: #b7c5cf;
    text-align: center;
  }
  .feed-state button {
    justify-self: center;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.08);
    color: #eef5fb;
    padding: 8px 12px;
  }
  .feed-state.error {
    color: #f0a0a0;
  }
  .feed-message {
    position: fixed;
    z-index: 21;
    top: 48px;
    right: 10px;
    max-width: min(520px, calc(100vw - 20px));
    margin: 0;
    padding: 7px 10px;
    border-radius: 6px;
    background: rgba(10, 14, 18, 0.82);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: #b7d7ea;
    font-size: 0.75rem;
  }
  @media (max-width: 760px) {
    .feed-rail {
      top: 48px;
      overflow-x: auto;
      align-items: stretch;
    }
    .feed-summary {
      margin-left: 0;
      white-space: nowrap;
    }
  }
</style>
