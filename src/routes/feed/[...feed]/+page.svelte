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
	    type RefillFeedSourcesOptions,
	    type FeedRunState,
	  } from '$lib/feed/engine';
	  import { parseFeedRouteSpec, type FeedRouteSpec } from '$lib/feed/routes';
  import FeedQueueStatus from '$lib/components/FeedQueueStatus.svelte';
  import FeedRouteMenu from '$lib/components/FeedRouteMenu.svelte';
  import MediaViewer from '$lib/components/MediaViewer.svelte';
  import PostOverlay from '$lib/components/PostOverlay.svelte';
  import ProfileScanStatus from '$lib/components/ProfileScanStatus.svelte';
  import ViewerBrandMenu from '$lib/components/ViewerBrandMenu.svelte';
  import ViewerTopRail from '$lib/components/ViewerTopRail.svelte';
  import { profileScanManager } from '$lib/discovery/profile-scan-manager.svelte.js';
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

  const INITIAL_REFILL_POST_THRESHOLD = 8;
  const AUTO_REFILL_AHEAD_THRESHOLD = 3;
  const PROFILE_SCAN_POST_TARGET_LIMIT = 8;
  const FEED_OPTIONS = [
    { name: 'random', label: 'random' },
    { name: 'comfort', label: 'comfort' },
    { name: 'fresh', label: 'fresh' },
    { name: 'explore', label: 'explore' },
  ] as const;

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
  type VoteNotice = {
    label: string;
    subreddit: string;
    tone: 'positive' | 'negative' | 'muted';
  };

	  let feedSpec = $state<FeedRouteSpec>(parseFeedRouteSpec(undefined));
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
	  let voteNotice = $state<VoteNotice | null>(null);
	  let voteNoticeTimer: ReturnType<typeof setTimeout> | undefined;
	  let currentMediaLoadState = $state<'loading' | 'ready' | 'error'>('loading');
	  let loadingRouteKey = $state('');

	  const feedName = $derived(feedSpec.feedName);
	  const sourceSummary = $derived(feedSpec.sourceSummary);
	  const currentPost = $derived(posts[currentIndex]);
  const currentRunItem = $derived(items[currentIndex]);
  const currentMedia = $derived(currentPost?.media);
  const currentItem = $derived(currentMedia?.items?.[galleryIndex] ?? currentMedia?.items?.[0]);
  const totalItems = $derived(currentMedia?.items?.length ?? 0);
  const imageCacheMode = $derived<MediaCacheRuntimeState>('inactive');
  const queueHealth = $derived(formatQueueHealth());
  const feedStatus = $derived(error ? 'error' : loading ? 'loading' : posts.length > 0 ? 'ready' : 'empty');
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

  function getAheadCount(statePosts = posts, index = currentIndex) {
    return Math.max(0, statePosts.length - index - 1);
  }

  function getPostScanTargets(feedPosts: PostRecord[], startIndex = 0) {
    return [...new Set(feedPosts
      .slice(startIndex, startIndex + PROFILE_SCAN_POST_TARGET_LIMIT)
      .map((post) => post.subreddit)
      .filter(Boolean)
    )];
  }

  function queueProfileScans(targets: string[]) {
    if (targets.length === 0) return;

    void profileScanManager.enqueueBackgroundTargets(targets).catch((scanError) => {
      console.warn('Failed to queue feed profile scans', scanError);
    });
  }

	  async function refillSourceInventory(spec: FeedRouteSpec, options: RefillFeedSourcesOptions = {}) {
	    const refill = await refillFeedSources(spec, options);
	    queueProfileScans(refill.scanTargets);
	    return refill;
	  }

  function formatRefillMessage(refill: Awaited<ReturnType<typeof refillFeedSources>>) {
    const requestSummary = refill.cacheHits > 0
      ? `${refill.networkRequests} net · ${refill.cacheHits} cached`
      : `${refill.networkRequests} net`;
    return `refill ${refill.ok}/${refill.attempted} sources · ${requestSummary} · ${refill.mediaPosts} media · ${refill.newPosts} new`;
  }

	  $effect(() => {
	    const nextFeedSpec = parseFeedRouteSpec($page.params.feed, $page.url.searchParams);
	    if (
	      nextFeedSpec.routeKey === feedSpec.routeKey &&
	      (feedState || loadingRouteKey === nextFeedSpec.routeKey)
	    ) {
	      return;
	    }
	    feedSpec = nextFeedSpec;
	    void loadFeed(nextFeedSpec);
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

	  async function loadFeed(spec: FeedRouteSpec) {
	    const routeKey = spec.routeKey;
	    loadingRouteKey = routeKey;
	    loading = true;
	    error = '';
	    message = '';
	    try {
	      const initial = await buildFeedRun(spec);
	      if (routeKey !== feedSpec.routeKey) return;
	      if (initial.posts.length < INITIAL_REFILL_POST_THRESHOLD) {
	        refilling = true;
	        const refill = await refillSourceInventory(spec);
	        if (routeKey !== feedSpec.routeKey) return;
	        message = formatRefillMessage(refill);
	        applyState(await buildFeedRun(spec, { refreshTail: true }));
	      } else {
	        applyState(initial);
	        queueProfileScans(getPostScanTargets(initial.posts));
      }
	    } catch (loadError) {
	      error = loadError instanceof Error ? loadError.message : String(loadError);
	    } finally {
	      if (routeKey === feedSpec.routeKey) {
	        refilling = false;
	        loading = false;
	      }
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
	      { label: 'feed', value: `${feedName} · ${sourceSummary} · ${item.committed ? 'committed' : 'tail'}` },
      { label: 'source', value: item.sourceLabel ?? post.fetchedInRoute ?? 'local db' },
      { label: 'slot', value: item.slot },
      { label: 'score', value: item.score.toFixed(2), tone: item.score >= 0 ? 'positive' : 'negative' },
      { label: 'position', value: `${currentIndex + 1}/${posts.length}` },
      { label: 'media', value: `${post.media?.kind?.replaceAll('_', ' ') ?? 'unknown'} · ${post.score} pts` },
      ...item.scoreDetails.map(formatScoreDetail),
    ];

    return {
	      summary: `${feedName}/${sourceSummary} · score ${item.score.toFixed(1)} · ${item.sourceLabel ?? `r/${post.subreddit}`}`,
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

  function showVoteNotice(notice: VoteNotice) {
    if (voteNoticeTimer) {
      clearTimeout(voteNoticeTimer);
    }

    voteNotice = notice;
    voteNoticeTimer = setTimeout(() => {
      voteNotice = null;
      voteNoticeTimer = undefined;
    }, 1600);
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
    const skippedPost = currentPost;
    await markPostSeen(currentPost.id);
    await recordEvent('advance_next', currentPost);
    await recordEvent('view_end', currentPost);
    if (skippedPost.localRating === undefined) {
      showVoteNotice({
        label: 'Skipped',
        subreddit: skippedPost.subreddit,
        tone: 'muted',
      });
    }
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
    const post = currentPost;
    const existing = await getPost(post.id);
    const newRating: 1 | undefined = existing?.localRating === 1 ? undefined : 1;
    await setPostRating(post.id, newRating);
    posts = posts.map((candidate) => candidate.id === post.id ? { ...candidate, localRating: newRating } : candidate);
    await recordEvent('rating_explicit', post, newRating ?? 0);
    const delta = (newRating ?? 0) - (existing?.localRating ?? 0);
    if (delta !== 0) await updateSubredditRating(post.subreddit, delta);
    showVoteNotice({
      label: newRating === 1 ? 'Rated up' : 'Cleared rating',
      subreddit: post.subreddit,
      tone: newRating === 1 ? 'positive' : 'muted',
    });
  }

  async function rateDown() {
    if (!currentPost) return;
    const post = currentPost;
    const existing = await getPost(post.id);
    const newRating: -1 | undefined = existing?.localRating === -1 ? undefined : -1;
    await setPostRating(post.id, newRating);
    posts = posts.map((candidate) => candidate.id === post.id ? { ...candidate, localRating: newRating } : candidate);
    await recordEvent('rating_explicit', post, newRating ?? 0);
    const delta = (newRating ?? 0) - (existing?.localRating ?? 0);
    if (delta !== 0) await updateSubredditRating(post.subreddit, delta);
    showVoteNotice({
      label: newRating === -1 ? 'Rated down' : 'Cleared rating',
      subreddit: post.subreddit,
      tone: newRating === -1 ? 'negative' : 'muted',
    });
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
    let startedRefill = false;
    refreshingTail = true;
    message = '';
    try {
	      const refreshed = await buildFeedRun(feedSpec, { refreshTail: true, currentIndex });
	      applyState(refreshed);
	      queueProfileScans(getPostScanTargets(refreshed.posts, refreshed.run.currentIndex));

	      if (getAheadCount(refreshed.posts, refreshed.run.currentIndex) <= AUTO_REFILL_AHEAD_THRESHOLD && !refilling) {
	        startedRefill = true;
	        refilling = true;
	        const refill = await refillSourceInventory(feedSpec);
	        applyState(await buildFeedRun(feedSpec, { refreshTail: true, currentIndex }));
	        message = `tail refreshed · ${formatRefillMessage(refill)}`;
      } else {
        message = 'tail refreshed from local candidates';
      }
    } catch (refreshError) {
      error = refreshError instanceof Error ? refreshError.message : String(refreshError);
    } finally {
      if (startedRefill) refilling = false;
      refreshingTail = false;
    }
  }

  async function refillNow() {
    if (refilling) return;
    refilling = true;
    message = '';
    try {
	      const refill = await refillSourceInventory(feedSpec, { force: true, forceNetwork: true });
	      applyState(await buildFeedRun(feedSpec, { refreshTail: true, currentIndex }));
      message = formatRefillMessage(refill);
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
	      applyState(await loadFeedRun(feedSpec));
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

    if (event.repeat && (action === 'rate_up_next' || action === 'rate_down_next')) return;

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
        void rateUp();
        break;
      case 'rate_down_next':
        void rateDown();
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
    return () => {
      window.removeEventListener('keydown', handleKeydown);
      if (voteNoticeTimer) {
        clearTimeout(voteNoticeTimer);
      }
    };
  });
</script>

	<svelte:head>
	  <title>SubGlass Feed · {feedName} · {sourceSummary}</title>
	</svelte:head>

<div class="feed-page" data-feed-status={feedStatus}>
  <div class="feed-canvas">
	    {#if loading}
	      <div class="feed-state loading">Loading {feedName} {sourceSummary} feed...</div>
	    {:else if error}
	      <div class="feed-state error">
	        <p>{error}</p>
	        <button type="button" onclick={() => loadFeed(feedSpec)}>Retry</button>
	      </div>
	    {:else if posts.length === 0}
	      <div class="feed-state empty">
	        <p>No local candidates for {feedName} {sourceSummary} yet.</p>
        <button type="button" onclick={refillNow} disabled={refilling}>
          {refilling ? 'Refilling...' : 'Fetch source inventory'}
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
          showTopBar={false}
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
        {#if voteNotice}
          <div class="vote-notice" data-tone={voteNotice.tone} role="status" aria-live="polite">
            <span>{voteNotice.label}</span>
            <strong>r/{voteNotice.subreddit}</strong>
          </div>
        {/if}
        {#if message}
          <p class="feed-message">{message}</p>
        {/if}
      </div>
    {/if}
  </div>

  <ViewerTopRail ariaLabel="Feed viewer controls">
    {#snippet left()}
	      <ViewerBrandMenu />
	      <FeedRouteMenu routeSpec={feedSpec} recipe={feedState?.recipe} options={FEED_OPTIONS} />
      <ProfileScanStatus class="feed-scan-status" />
    {/snippet}

    {#snippet right()}
      <FeedQueueStatus
        {feedStatus}
        {queueHealth}
        postsLength={posts.length}
        {currentIndex}
        currentSubreddit={currentPost?.subreddit}
        locked={run?.locked ?? false}
        canToggleLock={!!run}
        canRefreshTail={!!run && !run.locked}
        {loading}
        {refilling}
        {refreshingTail}
        loadedMedia={loadedMediaStates}
        {items}
        onToggleLock={toggleLock}
        onRefreshTail={refreshTail}
        onRefillNow={refillNow}
        onReloadRun={reloadRun}
      />
    {/snippet}
  </ViewerTopRail>
</div>

<style>
  .feed-page {
    min-height: 100vh;
    background:
      radial-gradient(circle at top, rgba(64, 108, 148, 0.18), transparent 42%),
      linear-gradient(180deg, #07090d 0%, #050608 50%, #030305 100%);
    color: #eef5fb;
    overflow: hidden;
    isolation: isolate;
    user-select: none;
  }

  .feed-page button {
    font: inherit;
  }

  .feed-canvas,
  .feed-viewer {
    position: relative;
    min-height: 100vh;
  }

  .feed-viewer {
    width: 100vw;
    height: 100vh;
    overflow: hidden;
  }

  :global(.feed-scan-status) {
    max-width: 180px;
    overflow: hidden;
    padding: 0 8px;
  }

  .feed-state {
    min-height: 100vh;
    display: grid;
    place-content: center;
    gap: 14px;
    color: #b7c5cf;
    text-align: center;
    padding: 96px 24px 40px;
  }

  .loading,
  .empty {
    font-size: clamp(1rem, 2vw, 1.2rem);
    text-transform: uppercase;
  }

  .feed-state button {
    justify-self: center;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.08);
    color: #eef5fb;
    padding: 8px 12px;
  }
  .feed-state.error {
    color: #f0a0a0;
  }
  .vote-notice {
    position: fixed;
    z-index: 42;
    left: 50%;
    bottom: 72px;
    display: flex;
    align-items: baseline;
    gap: 8px;
    max-width: min(360px, calc(100vw - 32px));
    min-height: 34px;
    padding: 8px 12px;
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(8, 11, 14, 0.86);
    color: #eaf4fb;
    font-size: 0.82rem;
    box-shadow: 0 18px 44px rgba(0, 0, 0, 0.32);
    transform: translateX(-50%);
    pointer-events: none;
  }
  .vote-notice strong {
    color: #ffffff;
    font-weight: 700;
  }
  .vote-notice[data-tone='positive'] {
    border-color: rgba(142, 226, 174, 0.45);
    background: rgba(12, 42, 26, 0.86);
  }
  .vote-notice[data-tone='negative'] {
    border-color: rgba(244, 144, 144, 0.45);
    background: rgba(52, 18, 20, 0.86);
  }
  .vote-notice[data-tone='muted'] {
    color: #cbd9e3;
  }
  .feed-message {
    position: fixed;
    z-index: 41;
    top: 46px;
    right: 10px;
    max-width: min(520px, calc(100vw - 20px));
    margin: 0;
    padding: 7px 10px;
    border-radius: 10px;
    background: rgba(10, 14, 18, 0.82);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: #b7d7ea;
    font-size: 0.75rem;
  }

  @media (max-width: 760px) {
    :global(.feed-scan-status) {
      display: none;
    }
  }
</style>
