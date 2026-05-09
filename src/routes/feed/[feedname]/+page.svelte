<script lang="ts">
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { ChevronDown, Database, Lock, RefreshCw, RotateCcw, Unlock } from 'lucide-svelte';
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
  import ProfileScanStatus from '$lib/components/ProfileScanStatus.svelte';
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
  let voteNotice = $state<VoteNotice | null>(null);
  let voteNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  let currentMediaLoadState = $state<'loading' | 'ready' | 'error'>('loading');

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

  async function refillSourceInventory(name: string) {
    const refill = await refillFeedSources(name);
    queueProfileScans(refill.scanTargets);
    return refill;
  }

  function formatRefillMessage(refill: Awaited<ReturnType<typeof refillFeedSources>>) {
    return `refill ${refill.ok}/${refill.attempted} sources · ${refill.mediaPosts} media · ${refill.newPosts} new`;
  }

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
      if (initial.posts.length < INITIAL_REFILL_POST_THRESHOLD) {
        refilling = true;
        const refill = await refillSourceInventory(name);
        message = formatRefillMessage(refill);
        applyState(await buildFeedRun(name, { refreshTail: true }));
      } else {
        applyState(initial);
        queueProfileScans(getPostScanTargets(initial.posts));
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
      const refreshed = await buildFeedRun(feedName, { refreshTail: true, currentIndex });
      applyState(refreshed);
      queueProfileScans(getPostScanTargets(refreshed.posts, refreshed.run.currentIndex));

      if (getAheadCount(refreshed.posts, refreshed.run.currentIndex) <= AUTO_REFILL_AHEAD_THRESHOLD && !refilling) {
        startedRefill = true;
        refilling = true;
        const refill = await refillSourceInventory(feedName);
        applyState(await buildFeedRun(feedName, { refreshTail: true, currentIndex }));
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
      const refill = await refillSourceInventory(feedName);
      applyState(await buildFeedRun(feedName, { refreshTail: true, currentIndex }));
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
  <title>SubGlass Feed · {feedName}</title>
</svelte:head>

<div class="feed-page" data-feed-status={feedStatus}>
  <div class="feed-canvas">
    {#if loading}
      <div class="feed-state loading">Loading {feedName} feed...</div>
    {:else if error}
      <div class="feed-state error">
        <p>{error}</p>
        <button type="button" onclick={() => loadFeed(feedName)}>Retry</button>
      </div>
    {:else if posts.length === 0}
      <div class="feed-state empty">
        <p>No local candidates for {feedName} yet.</p>
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

  <nav class="feed-topbar" aria-label="Feed viewer controls">
    <div class="feed-topbar-nav">
      <details class="topbar-menu brand-menu">
        <summary class="brand" aria-label="SubGlass menu">SubGlass</summary>
        <div class="topbar-menu-panel brand-panel">
          <div class="menu-section">
            <span class="menu-label">places</span>
            <div class="nav-links">
              <a href="/r/all">viewer</a>
              <a href="/feed/random">feed</a>
              <a href="/roulette">roulette</a>
              <a href="/discover">discover</a>
              <a href="/admin">admin</a>
            </div>
          </div>
        </div>
      </details>

      <details class="topbar-menu feed-menu">
        <summary class="feed-route-chip" aria-label={`Current feed ${feedName}`}>
          <span>feed</span>
          <strong>{feedName}</strong>
          <ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
        </summary>
        <div class="topbar-menu-panel feed-panel">
          <div class="menu-section">
            <span class="menu-label">feeds</span>
            <div class="feed-switcher" aria-label="Local feeds">
              {#each FEED_OPTIONS as option}
                <a href="/feed/{option.name}" class:active={feedName === option.name}>{option.label}</a>
              {/each}
            </div>
          </div>

          <div class="menu-section">
            <span class="menu-label">recipe</span>
            <div class="recipe-grid">
              <span>mode</span>
              <strong>{feedState?.recipe.sourceMode ?? '...'}</strong>
              <span>sort</span>
              <strong>
                {feedState?.recipe.listingSort ?? '...'}
                {#if feedState?.recipe.listingSort === 'top' || feedState?.recipe.listingSort === 'controversial'}
                  / {feedState.recipe.listingTime}
                {/if}
              </strong>
              <span>sources</span>
              <strong>{feedState?.recipe.sourceCount ?? '...'}</strong>
              <span>target</span>
              <strong>{feedState?.recipe.targetQueueSize ?? '...'}</strong>
            </div>
          </div>
        </div>
      </details>

      <ProfileScanStatus class="feed-scan-status" />
    </div>

    <div
      class="feed-status"
      role="group"
      aria-label="Feed queue controls"
      data-locked={run?.locked}
    >
      <span class="status-count">
        {#if posts.length > 0}
          {currentIndex + 1} / {posts.length}
        {:else}
          {feedStatus}
        {/if}
      </span>
      {#if currentPost}
        <span class="status-subreddit">r/{currentPost.subreddit}</span>
      {/if}
      <span class="status-chip lock-state" data-locked={run?.locked}>
        {#if run?.locked}
          <Lock size={13} strokeWidth={2} aria-hidden="true" />
          locked
        {:else}
          open
        {/if}
      </span>

      <details class="status-menu">
        <summary aria-label={`Feed queue: ${queueHealth}`}>
          <span class="status-label">queue</span>
          <span class="load-rail" aria-hidden="true">
            {#each loadedMediaStates.slice(Math.max(0, currentIndex - 3), currentIndex + 13) as item (item.id)}
              <span
                class="load-chip"
                class:rating-up={item.rating === 1}
                class:rating-down={item.rating === -1}
                class:current={item.index === currentIndex}
                data-kind={item.kind}
                data-status={item.status}
                title={`#${item.index + 1} · ${item.slot ?? 'tail'} · ${item.sourceLabel ?? 'local'} · ${item.title}`}
              ></span>
            {/each}
          </span>
        </summary>
        <div class="status-menu-panel">
          <section class="status-panel-section">
            <div class="status-panel-heading">
              <span>queue</span>
              <span>{queueHealth}</span>
            </div>
            <div class="queue-facts">
              <span>run</span>
              <strong>{run?.locked ? 'locked' : 'open'}</strong>
              <span>committed</span>
              <strong>{items.filter((item) => item.committed).length}</strong>
              <span>tail</span>
              <strong>{items.filter((item) => !item.committed).length}</strong>
              <span>sources</span>
              <strong>{new Set(items.map((item) => item.sourceKey).filter(Boolean)).size}</strong>
            </div>
          </section>

          <section class="status-panel-section">
            <div class="status-panel-heading">
              <span>feed actions</span>
              <span>{refilling ? 'refilling' : refreshingTail ? 'refreshing' : 'ready'}</span>
            </div>
            <div class="feed-action-grid">
              <button type="button" onclick={toggleLock} disabled={!run}>
                {#if run?.locked}
                  <Unlock size={15} strokeWidth={2} aria-hidden="true" />
                  <span>unlock</span>
                {:else}
                  <Lock size={15} strokeWidth={2} aria-hidden="true" />
                  <span>lock</span>
                {/if}
              </button>
              <button type="button" onclick={refreshTail} disabled={refreshingTail || !run || run.locked}>
                <RefreshCw size={15} strokeWidth={2} aria-hidden="true" />
                <span>{refreshingTail ? 'refreshing' : 'refresh tail'}</span>
              </button>
              <button type="button" onclick={refillNow} disabled={refilling}>
                <Database size={15} strokeWidth={2} aria-hidden="true" />
                <span>{refilling ? 'refilling' : 'refill sources'}</span>
              </button>
              <button type="button" onclick={reloadRun} disabled={loading}>
                <RotateCcw size={15} strokeWidth={2} aria-hidden="true" />
                <span>reload</span>
              </button>
            </div>
          </section>
        </div>
      </details>
    </div>
  </nav>
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

  .feed-page button,
  .feed-page summary {
    font: inherit;
  }

  .feed-page a {
    color: inherit;
    text-decoration: none;
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

  .feed-topbar {
    position: fixed;
    z-index: 40;
    top: 0;
    left: 0;
    right: 0;
    display: flex;
    min-height: 38px;
    align-items: stretch;
    justify-content: space-between;
    gap: 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.07);
    background: rgba(8, 11, 15, 0.62);
    backdrop-filter: blur(20px) saturate(1.05);
    box-shadow: 0 16px 36px rgba(0, 0, 0, 0.22);
  }

  .feed-topbar-nav,
  .feed-status {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 4px;
    padding: 4px 6px;
  }

  .feed-topbar-nav {
    flex: 1 1 auto;
  }

  .feed-status {
    flex: 0 1 auto;
    justify-content: flex-end;
    max-width: min(64vw, 760px);
    border-left: 1px solid rgba(255, 255, 255, 0.07);
    overflow: visible;
  }

  .brand,
  .feed-route-chip,
  .status-count,
  .status-subreddit,
  .status-chip,
  .status-menu summary,
  :global(.feed-scan-status) {
    display: inline-flex;
    min-height: 28px;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    background: rgba(255, 255, 255, 0.045);
    color: rgba(229, 241, 250, 0.86);
    font-size: 0.72rem;
    line-height: 1;
    white-space: nowrap;
  }

  .brand {
    padding: 5px 9px;
    color: rgba(198, 226, 246, 0.88);
    font-weight: 700;
  }

  .feed-route-chip {
    gap: 6px;
    padding: 0 8px;
  }

  .feed-route-chip span {
    color: rgba(166, 178, 190, 0.86);
  }

  .feed-route-chip strong,
  .status-subreddit {
    color: rgba(154, 211, 247, 0.92);
  }

  .brand:hover,
  .brand:focus-visible,
  .topbar-menu[open] .brand,
  .feed-route-chip:hover,
  .feed-route-chip:focus-visible,
  .topbar-menu[open] .feed-route-chip,
  .status-menu[open] summary,
  .status-menu summary:hover,
  .status-menu summary:focus-visible {
    background: rgba(140, 199, 239, 0.14);
    border-color: rgba(140, 199, 239, 0.24);
    color: #edf6ff;
  }

  :global(.feed-scan-status) {
    max-width: 180px;
    overflow: hidden;
    padding: 0 8px;
  }

  .topbar-menu,
  .status-menu {
    position: relative;
    min-width: 0;
  }

  .topbar-menu summary,
  .status-menu summary {
    list-style: none;
    cursor: pointer;
  }

  .topbar-menu summary::-webkit-details-marker,
  .status-menu summary::-webkit-details-marker {
    display: none;
  }

  .topbar-menu-panel,
  .status-menu-panel {
    position: absolute;
    top: calc(100% + 4px);
    display: grid;
    gap: 12px;
    padding: 10px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(8, 11, 15, 0.9);
    backdrop-filter: blur(22px) saturate(1.08);
    box-shadow: 0 24px 58px rgba(0, 0, 0, 0.36);
  }

  .topbar-menu-panel {
    left: 0;
    width: min(360px, calc(100vw - 12px));
    border-radius: 0 0 16px 0;
  }

  .feed-panel {
    width: min(420px, calc(100vw - 12px));
  }

  .status-menu {
    flex: 1 1 auto;
  }

  .status-menu summary {
    gap: 6px;
    width: 100%;
    min-width: 0;
    padding: 0 8px;
  }

  .status-menu-panel {
    right: 0;
    width: min(500px, 100vw);
    grid-template-columns: minmax(0, 1fr) minmax(190px, 0.75fr);
    border-radius: 0 0 0 16px;
    border-top: 0;
  }

  .menu-section,
  .status-panel-section {
    min-width: 0;
    display: grid;
    gap: 8px;
  }

  .menu-label,
  .status-panel-heading {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    color: rgba(166, 178, 190, 0.86);
    font-size: 0.64rem;
    text-transform: uppercase;
  }

  .nav-links,
  .feed-switcher,
  .feed-action-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .nav-links a,
  .feed-switcher a,
  .feed-action-grid button {
    min-height: 30px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.05);
    color: rgba(229, 241, 250, 0.86);
    font-size: 0.74rem;
    padding: 0 9px;
  }

  .feed-switcher a.active {
    background: rgba(140, 199, 239, 0.16);
    border-color: rgba(140, 199, 239, 0.3);
    color: #edf6ff;
  }

  .feed-action-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .feed-action-grid button {
    justify-content: flex-start;
    color: #e8f2fa;
    cursor: pointer;
  }

  .feed-action-grid button:disabled {
    cursor: not-allowed;
    opacity: 0.42;
  }

  .recipe-grid,
  .queue-facts {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 7px 12px;
    padding: 8px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.04);
    color: rgba(166, 178, 190, 0.9);
    font-size: 0.72rem;
  }

  .recipe-grid strong,
  .queue-facts strong {
    min-width: 0;
    overflow: hidden;
    color: #edf5fc;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-count,
  .status-subreddit,
  .status-chip,
  .status-label {
    padding: 0 8px;
  }

  .status-count {
    font-variant-numeric: tabular-nums;
  }

  .status-chip {
    gap: 5px;
    color: rgba(166, 178, 190, 0.92);
  }

  .lock-state[data-locked='true'] {
    border-color: rgba(232, 189, 95, 0.26);
    background: rgba(232, 189, 95, 0.12);
    color: #f0d8a0;
  }

  .load-rail {
    display: inline-flex;
    align-items: center;
    flex: 1 1 auto;
    gap: 4px;
    min-width: 34px;
    overflow: hidden;
  }

  .load-chip {
    position: relative;
    display: inline-flex;
    flex: 0 0 auto;
    width: 8px;
    height: 16px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.18);
    overflow: hidden;
  }

  .load-chip[data-kind='gallery'] {
    width: 12px;
    border-radius: 4px;
  }

  .load-chip[data-kind='video'] {
    width: 14px;
    border-radius: 5px;
  }

  .load-chip.current {
    transform: translateY(-1px);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.4);
  }

  .load-chip[data-status='seen'] {
    background: rgba(255, 255, 255, 0.34);
  }

  .load-chip[data-status='loading'] {
    background: rgba(214, 176, 103, 0.68);
  }

  .load-chip[data-status='ready'] {
    background: rgba(106, 176, 222, 0.82);
  }

  .load-chip[data-status='error'] {
    background: rgba(190, 101, 101, 0.82);
  }

  .load-chip::after {
    content: '';
    position: absolute;
    inset: auto 0 0;
    height: 3px;
    background: transparent;
  }

  .load-chip.rating-up::after {
    background: #71d488;
  }

  .load-chip.rating-down::after {
    background: #de7e7e;
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
    .feed-topbar {
      display: grid;
      align-items: stretch;
    }

    .feed-topbar-nav,
    .feed-status {
      width: 100%;
      max-width: none;
      overflow-x: auto;
    }

    .feed-status {
      border-left: 0;
      border-top: 1px solid rgba(255, 255, 255, 0.07);
      justify-content: flex-start;
    }

    .status-menu-panel {
      left: 0;
      right: auto;
      width: 100vw;
      grid-template-columns: 1fr;
      border-radius: 0 0 16px 0;
    }

    .topbar-menu-panel,
    .feed-panel {
      width: min(100vw, 380px);
    }

    .status-subreddit,
    :global(.feed-scan-status) {
      display: none;
    }
  }
</style>
