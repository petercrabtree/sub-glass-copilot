<script lang="ts">
  import { dev } from '$app/environment';
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import type { MediaGroup, MediaItem, PostRecord } from '$lib/types';
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
  import {
    getViewerActionForKey,
    getViewerShortcut,
    type ViewerShortcutAction,
  } from '$lib/viewer/keyboard';

  type LoadedMediaStatus = 'queued' | 'seen' | 'loading' | 'ready' | 'error';
  type DisplayMode = 'fill' | 'scroll' | 'masonry' | 'wild' | 'wild2' | 'wild3';
  type VideoTiming = {
    currentTime: number;
    duration: number;
    paused: boolean;
    completedLoops: number;
  };
  type DisplayTile = {
    index: number;
    post: PostRecord;
    media: MediaGroup;
    item: MediaItem;
    isActive: boolean;
    itemCount: number;
    isVideo: boolean;
    aspectRatio: number;
    width: number;
    height: number;
    masonryColSpan: number;
    masonryRowSpan: number;
  };

  const DISPLAY_MODE_STORAGE_KEY = 'subglass:display-mode';
  const AUTO_ADVANCE_SETTINGS_STORAGE_KEY = 'subglass:auto-advance-settings';
  const POINTER_RESET_THROTTLE_MS = 280;
  const MIN_VIDEO_ADVANCE_MS = 5000;
  const DISPLAY_MODES: Array<{
    id: DisplayMode;
    label: string;
    blurb: string;
    action: ViewerShortcutAction;
  }> = [
    { id: 'fill', label: 'fill', blurb: 'Full view without clipping', action: 'display_fill' },
    { id: 'scroll', label: 'solo', blurb: 'Vertical solo image stream', action: 'display_scroll' },
    { id: 'masonry', label: 'masonry', blurb: 'Dynamic vertical wall', action: 'display_masonry' },
    { id: 'wild', label: 'wild', blurb: 'Layered collage chaos', action: 'display_wild' },
    { id: 'wild2', label: 'wild2', blurb: 'Orbital magazine spread', action: 'display_wild2' },
    { id: 'wild3', label: 'wild3', blurb: 'Ribbon wall drift', action: 'display_wild3' },
  ];
  const WILD_CARD_OFFSETS = [-3, -2, -1, 0, 1, 2, 3] as const;

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
  let currentMediaLoadState = $state<'loading' | 'ready' | 'error'>('loading');
  let displayMode = $state<DisplayMode>('fill');
  let debugExpanded = $state(false);
  let scrollFeedEl = $state<HTMLDivElement | null>(null);
  let masonryFeedEl = $state<HTMLDivElement | null>(null);
  let masonryAutoPaused = $state(false);
  let currentVideoTiming = $state<VideoTiming | null>(null);
  let autoAdvancePaused = $state(false);
  let imageAdvanceSeconds = $state(5);
  let videoAdvancePlays = $state(1);
  let autoAdvanceAnchorMs = $state(Date.now());
  let autoAdvanceVideoAnchorPlayedMs = $state(0);
  let countdownNowMs = $state(Date.now());
  let autoAdvanceInFlight = $state(false);
  let scrollSyncFrame = 0;
  let masonrySyncFrame = 0;
  let lastPointerResetAt = 0;
  let lastRouteLoadKey = '';

  function formatErrorJson(feedError: RedditRequestError): string {
    return JSON.stringify(feedError, null, 2);
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

  function clampAspectRatio(width?: number, height?: number): number {
    if (!width || !height) return 1;
    return Math.min(Math.max(width / height, 0.68), 1.9);
  }

  function clampImageAdvanceSeconds(value: number): number {
    return Math.min(30, Math.max(1, Math.round(value || 5)));
  }

  function clampVideoAdvancePlays(value: number): number {
    return Math.min(6, Math.max(1, Math.round(value || 1)));
  }

  function getResolvedDimensions(width?: number, height?: number) {
    return {
      width: width && width > 0 ? width : 1080,
      height: height && height > 0 ? height : 1080,
    };
  }

  function getMasonrySpans(width?: number, height?: number) {
    const resolved = getResolvedDimensions(width, height);
    const aspect = resolved.width / resolved.height;
    const area = resolved.width * resolved.height;
    const wide = aspect >= 1.32;
    const mediumWide = aspect >= 0.95;
    const densityBoost = Math.min(10, Math.max(0, Math.round(Math.log2(Math.max(1, area / 360000)))));
    const masonryColSpan = wide ? (area > 1800000 ? 3 : 2) : mediumWide ? 2 : 1;
    const masonryRowSpan = Math.min(
      68,
      Math.max(
        18,
        Math.round((resolved.height / resolved.width) * masonryColSpan * 18) + densityBoost
      )
    );

    return { masonryColSpan, masonryRowSpan, ...resolved };
  }

  function formatCountdown(ms: number | null | undefined): string {
    if (ms === null || ms === undefined) return '--';
    const safeMs = Math.max(0, Math.round(ms));
    if (safeMs < 10000) {
      return `${(safeMs / 1000).toFixed(1)}s`;
    }

    const totalSeconds = Math.ceil(safeMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds}s`;
  }

  function formatCountdownReadout(ms: number | null | undefined): string {
    if (ms === null || ms === undefined) return '--';

    const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
    if (totalSeconds >= 60) {
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }

    return String(totalSeconds);
  }

  function getVideoPlayedMs(snapshot: VideoTiming | null = currentVideoTiming) {
    if (!snapshot?.duration) return 0;

    return Math.max(
      0,
      Math.round((((snapshot.completedLoops ?? 0) * snapshot.duration) + snapshot.currentTime) * 1000)
    );
  }

  function mergeVideoTimingSnapshot(nextSample: {
    currentTime: number;
    duration: number;
    paused: boolean;
  }) {
    const duration = Number.isFinite(nextSample.duration) ? Math.max(0, nextSample.duration) : 0;
    const currentTime = Number.isFinite(nextSample.currentTime) ? Math.max(0, nextSample.currentTime) : 0;
    const previous = currentVideoTiming;

    const loopCompleted =
      previous &&
      previous.duration > 0 &&
      duration > 0 &&
      previous.currentTime >= previous.duration - 0.45 &&
      currentTime <= 0.75;

    currentVideoTiming = {
      currentTime,
      duration,
      paused: nextSample.paused,
      completedLoops: (previous?.completedLoops ?? 0) + (loopCompleted ? 1 : 0),
    };
  }

  function readStoredAutoAdvanceSettings() {
    if (typeof window === 'undefined') return null;

    try {
      const raw = window.localStorage.getItem(AUTO_ADVANCE_SETTINGS_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as {
        imageSeconds?: number;
        videoPlays?: number;
        paused?: boolean;
      };

      return {
        imageSeconds: clampImageAdvanceSeconds(parsed.imageSeconds ?? 5),
        videoPlays: clampVideoAdvancePlays(parsed.videoPlays ?? 1),
        paused: Boolean(parsed.paused),
      };
    } catch {
      return null;
    }
  }

  function persistAutoAdvanceSettings() {
    if (typeof window === 'undefined') return;

    try {
      window.localStorage.setItem(
        AUTO_ADVANCE_SETTINGS_STORAGE_KEY,
        JSON.stringify({
          imageSeconds: imageAdvanceSeconds,
          videoPlays: videoAdvancePlays,
          paused: autoAdvancePaused,
        })
      );
    } catch {
      // Ignore storage failures in private mode or restricted environments.
    }
  }

  function isDisplayMode(value: string | null): value is DisplayMode {
    return DISPLAY_MODES.some((mode) => mode.id === value);
  }

  function readStoredDisplayMode(): DisplayMode | null {
    if (typeof window === 'undefined') return null;

    try {
      const stored = window.localStorage.getItem(DISPLAY_MODE_STORAGE_KEY);
      return isDisplayMode(stored) ? stored : null;
    } catch {
      return null;
    }
  }

  function persistDisplayMode(mode: DisplayMode) {
    if (typeof window === 'undefined') return;

    try {
      window.localStorage.setItem(DISPLAY_MODE_STORAGE_KEY, mode);
    } catch {
      // Ignore storage failures in private mode or restricted environments.
    }
  }

  function prefersReducedMotion(): boolean {
    return typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function resetAutoAdvanceClock(videoPlayedMs = getVideoPlayedMs()) {
    const now = Date.now();
    autoAdvanceAnchorMs = now;
    autoAdvanceVideoAnchorPlayedMs = Math.max(0, Math.round(videoPlayedMs));
    countdownNowMs = now;
  }

  function syncCurrentSelectionState() {
    const media = posts[currentIndex]?.media;

    currentVideoTiming = media?.kind === 'video'
      ? { currentTime: 0, duration: 0, paused: false, completedLoops: 0 }
      : null;
    resetAutoAdvanceClock(0);
    autoAdvanceInFlight = false;

    if (!media) {
      currentMediaLoadState = 'loading';
      return;
    }

    currentMediaLoadState =
      media.kind === 'image' ||
      media.kind === 'external_image' ||
      media.kind === 'external_video' ||
      media.kind === 'gallery' ||
      media.kind === 'video'
        ? 'loading'
        : 'error';
  }

  function focusCurrentPostInActiveMode(behavior: ScrollBehavior = 'smooth') {
    if (typeof window === 'undefined') return;

    if (displayMode === 'scroll' && scrollFeedEl) {
      const slide = scrollFeedEl.querySelector<HTMLElement>(`[data-index="${currentIndex}"]`);
      slide?.scrollIntoView({ behavior, block: 'start' });
      return;
    }

    if (displayMode === 'masonry' && masonryFeedEl) {
      const tile = masonryFeedEl.querySelector<HTMLElement>(`[data-index="${currentIndex}"]`);
      tile?.scrollIntoView({ behavior, block: 'center', inline: 'nearest' });
    }
  }

  function setDisplayMode(mode: DisplayMode, behavior: ScrollBehavior = 'smooth') {
    if (mode === displayMode) {
      focusCurrentPostInActiveMode(behavior);
      return;
    }

    displayMode = mode;
    persistDisplayMode(mode);
    requestAnimationFrame(() => focusCurrentPostInActiveMode(behavior));
  }

  function setDisplaySelection(index: number) {
    if (index < 0 || index >= posts.length || index === currentIndex) return;
    currentIndex = index;
    galleryIndex = 0;
    syncCurrentSelectionState();
  }

  function selectPost(index: number) {
    setDisplaySelection(index);
    focusCurrentPostInActiveMode('smooth');

    if (index >= posts.length - 5) {
      void loadMore();
    }
  }

  function maybeLoadMoreFromContainer(container: HTMLElement) {
    if (container.scrollTop + container.clientHeight >= container.scrollHeight - container.clientHeight * 0.9) {
      void loadMore();
    }
  }

  function syncCurrentIndexFromContainer(container: HTMLElement, selector: string) {
    const containerRect = container.getBoundingClientRect();
    const viewportCenter = containerRect.top + containerRect.height / 2;
    let closestIndex = currentIndex;
    let closestDistance = Number.POSITIVE_INFINITY;

    for (const element of container.querySelectorAll<HTMLElement>(selector)) {
      const index = Number(element.dataset.index);
      if (Number.isNaN(index)) continue;

      const rect = element.getBoundingClientRect();
      const elementCenter = rect.top + rect.height / 2;
      const distance = Math.abs(elementCenter - viewportCenter);

      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
    }

    setDisplaySelection(closestIndex);
  }

  function handleScrollFeedScroll() {
    if (typeof window === 'undefined') return;

    cancelAnimationFrame(scrollSyncFrame);
    scrollSyncFrame = requestAnimationFrame(() => {
      scrollSyncFrame = 0;
      if (!scrollFeedEl) return;
      maybeLoadMoreFromContainer(scrollFeedEl);
      syncCurrentIndexFromContainer(scrollFeedEl, '.scroll-slide');
    });
  }

  function handleMasonryFeedScroll() {
    if (typeof window === 'undefined') return;

    cancelAnimationFrame(masonrySyncFrame);
    masonrySyncFrame = requestAnimationFrame(() => {
      masonrySyncFrame = 0;
      if (!masonryFeedEl) return;
      maybeLoadMoreFromContainer(masonryFeedEl);
      syncCurrentIndexFromContainer(masonryFeedEl, '.masonry-tile');
    });
  }

  function extractSubreddits(sub: string) {
    return sub.split('/')[0]?.split('+') ?? [];
  }

  const feedStatus = $derived(
    error ? `error:${error.kind}` : loading ? 'loading' : posts.length > 0 ? 'ready' : 'idle'
  );

  const currentPost = $derived(posts[currentIndex]);
  const currentMedia = $derived(currentPost?.media);
  const currentItem = $derived(currentMedia?.items?.[galleryIndex] ?? currentMedia?.items?.[0]);
  const totalItems = $derived(currentMedia?.items?.length ?? 0);
  const isSeen = $derived(currentPost ? seenIds.has(currentPost.id) : false);
  const currentDisplayMode = $derived(
    DISPLAY_MODES.find((mode) => mode.id === displayMode) ?? DISPLAY_MODES[0]
  );
  const autoAdvanceSuspended = $derived(
    autoAdvancePaused || (currentMedia?.kind === 'video' && currentVideoTiming?.paused === true)
  );
  const loadedMediaStates = $derived(
    posts.map((post, index) => {
      const status: LoadedMediaStatus =
        index === currentIndex
          ? currentMediaLoadState
          : seenIds.has(post.id)
            ? 'seen'
            : 'queued';

      return {
        id: post.id,
        index,
        kind: post.media?.kind ?? 'unknown',
        title: post.title,
        itemCount: post.media?.items.length ?? 0,
        rating: post.localRating,
        status,
      };
    })
  );
  const displayTiles = $derived(
    posts
      .map((post, index) => {
        const media = post.media;
        const item = media
          ? media.items[index === currentIndex ? galleryIndex : 0] ?? media.items[0]
          : undefined;
        if (!media || !item) return null;
        const masonrySize = getMasonrySpans(item.width, item.height);

        return {
          index,
          post,
          media,
          item,
          isActive: index === currentIndex,
          itemCount: media.items.length,
          isVideo: media.kind === 'video',
          aspectRatio: clampAspectRatio(item.width, item.height),
          width: masonrySize.width,
          height: masonrySize.height,
          masonryColSpan: masonrySize.masonryColSpan,
          masonryRowSpan: masonrySize.masonryRowSpan,
        } satisfies DisplayTile;
      })
      .filter((tile): tile is DisplayTile => tile !== null)
  );
  const autoAdvanceBaseMs = $derived(
    !currentMedia
      ? 0
      : currentMedia.kind === 'video'
        ? currentVideoTiming?.duration
          ? Math.max(
              Math.round(currentVideoTiming.duration * 1000),
              Math.ceil(
                (autoAdvanceVideoAnchorPlayedMs +
                  Math.max(
                    MIN_VIDEO_ADVANCE_MS,
                    Math.round(currentVideoTiming.duration * 1000 * videoAdvancePlays)
                  )) /
                  Math.round(currentVideoTiming.duration * 1000)
              ) *
                Math.round(currentVideoTiming.duration * 1000) -
                autoAdvanceVideoAnchorPlayedMs
            )
          : 0
        : imageAdvanceSeconds * 1000
  );
  const autoAdvanceElapsedMs = $derived(Math.max(0, countdownNowMs - autoAdvanceAnchorMs));
  const videoPlaybackRemainingMs = $derived(
    currentMedia?.kind === 'video' && currentVideoTiming?.duration
      ? Math.max(
          0,
          autoAdvanceBaseMs - Math.max(0, getVideoPlayedMs() - autoAdvanceVideoAnchorPlayedMs)
        )
      : null
  );
  const autoAdvanceRemainingMs = $derived(
    !currentMedia || autoAdvanceSuspended
      ? null
      : currentMedia.kind === 'video'
        ? currentVideoTiming?.duration
          ? videoPlaybackRemainingMs
          : null
        : Math.max(0, autoAdvanceBaseMs - autoAdvanceElapsedMs)
  );
  const autoAdvanceProgress = $derived(
    autoAdvanceBaseMs > 0 && autoAdvanceRemainingMs !== null
      ? Math.min(1, Math.max(0, 1 - autoAdvanceRemainingMs / autoAdvanceBaseMs))
      : 0
  );
  const currentVideoEndsInMs = $derived(
    currentMedia?.kind === 'video' && currentVideoTiming?.duration
      ? Math.max(0, (currentVideoTiming.duration - currentVideoTiming.currentTime) * 1000)
      : null
  );
  const autoAdvanceSummary = $derived(
    autoAdvanceSuspended
      ? currentMedia?.kind === 'video' && currentVideoTiming?.paused
        ? 'video paused'
        : 'autonext paused'
      : currentMedia?.kind === 'video'
        ? currentVideoTiming?.duration
          ? `end ${formatCountdown(currentVideoEndsInMs)} · next ${formatCountdown(autoAdvanceRemainingMs)}`
          : 'reading video timing…'
        : `next ${formatCountdown(autoAdvanceRemainingMs)}`
  );
  const wildDeck = $derived(
    WILD_CARD_OFFSETS.flatMap((offset) => {
      const tile = displayTiles.find((candidate) => candidate.index === currentIndex + offset);
      return tile ? [{ ...tile, offset }] : [];
    })
  );

  $effect(() => {
    const sub = $page.params.subreddit || 'all';
    const time = $page.url.searchParams.get('t') || undefined;
    const routeKey = `${sub}?${time ?? ''}`;
    if (routeKey === lastRouteLoadKey) return;
    lastRouteLoadKey = routeKey;
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

  $effect(() => {
    if (error) {
      debugExpanded = true;
    }
  });

  $effect(() => {
    void imageAdvanceSeconds;
    void videoAdvancePlays;
    void autoAdvancePaused;
    persistAutoAdvanceSettings();
  });

  $effect(() => {
    if (!currentMedia || typeof window === 'undefined') return;

    const interval = window.setInterval(() => {
      countdownNowMs = Date.now();
      if (canAutoAdvanceNow()) {
        void runAutoAdvance();
      }
    }, 100);

    return () => window.clearInterval(interval);
  });

  $effect(() => {
    if (displayMode !== 'masonry' || !masonryFeedEl || typeof window === 'undefined' || prefersReducedMotion()) {
      return;
    }

    let frame = 0;
    let lastFrameAt = performance.now();

    const tick = (now: number) => {
      const container = masonryFeedEl;
      if (!container) return;

      const elapsed = now - lastFrameAt;
      lastFrameAt = now;

      if (!masonryAutoPaused) {
        const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
        if (maxScroll > 0) {
          const nextPosition = container.scrollTop + elapsed * 0.024;

          if (nextPosition >= maxScroll - 2) {
            if (!loadingMore && afterCursor) {
              void loadMore();
              container.scrollTop = maxScroll - 2;
            } else if (!afterCursor) {
              container.scrollTop = 0;
            } else {
              container.scrollTop = nextPosition;
            }
          } else {
            container.scrollTop = nextPosition;
          }
        }

        syncCurrentIndexFromContainer(container, '.masonry-tile');
      }

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  });

  async function loadFeed(sub: string, time: string | undefined = listingTime) {
    loading = true;
    error = null;
    posts = [];
    currentIndex = 0;
    galleryIndex = 0;
    afterCursor = null;
    syncCurrentSelectionState();
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
    const mediaPosts = normalized.filter((post) => post.media);

    await Promise.all(mediaPosts.map(async (post) => {
      await upsertPost(post);
      if (post.media) await upsertMedia(post.media);
      await ensureSubreddit(post.subreddit);
      const links = extractLinksFromPost(post.title, '', post.subreddit, undefined);
      for (const link of links) {
        await upsertAdjacency(link);
        await ensureSubreddit(link.toSubreddit);
      }
    }));

    posts = mediaPosts;
    loading = false;
    syncCurrentSelectionState();

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
      time: listingTime,
    };
    const result = await fetchListing(spec, 25);
    syncRedditDebug();

    if (result.ok) {
      afterCursor = result.data.data.after || null;
      const normalized = normalizeListingResponse(result.data.data.children);
      const mediaPosts = normalized.filter((post) => post.media);

      await Promise.all(mediaPosts.map(async (post) => {
        await upsertPost(post);
        if (post.media) await upsertMedia(post.media);
        await ensureSubreddit(post.subreddit);
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
      syncCurrentSelectionState();
      focusCurrentPostInActiveMode('smooth');
      await recordEvent('impression', posts[currentIndex]);
      await recordEvent('view_start', posts[currentIndex]);

      if (currentIndex >= posts.length - 5) {
        void loadMore();
      }
    }
  }

  async function retreat() {
    if (currentIndex > 0) {
      await recordEvent('view_end', currentPost);
      currentIndex--;
      galleryIndex = 0;
      syncCurrentSelectionState();
      focusCurrentPostInActiveMode('smooth');
      await recordEvent('impression', posts[currentIndex]);
    }
  }

  async function advanceGallery() {
    if (!currentMedia) return;

    if (galleryIndex < currentMedia.items.length - 1) {
      galleryIndex++;
      syncCurrentSelectionState();
      await recordEvent('advance_gallery', currentPost);
    } else {
      await advance();
    }
  }

  async function retreatGallery() {
    if (galleryIndex > 0) {
      galleryIndex--;
      syncCurrentSelectionState();
    } else {
      await retreat();
    }
  }

  async function rateUp() {
    if (!currentPost) return;

    const existing = await getPost(currentPost.id);
    const newRating: 1 | undefined = existing?.localRating === 1 ? undefined : 1;
    await setPostRating(currentPost.id, newRating);
    posts = posts.map((post) => post.id === currentPost.id ? { ...post, localRating: newRating } : post);
    await recordEvent('rating_explicit', currentPost);

    if (newRating === 1) {
      await updateSubredditRating(currentPost.subreddit, 1);
    } else if (existing?.localRating === 1) {
      await updateSubredditRating(currentPost.subreddit, -1);
    }
  }

  async function rateDown() {
    if (!currentPost) return;

    const existing = await getPost(currentPost.id);
    const newRating: -1 | undefined = existing?.localRating === -1 ? undefined : -1;
    await setPostRating(currentPost.id, newRating);
    posts = posts.map((post) => post.id === currentPost.id ? { ...post, localRating: newRating } : post);
    await recordEvent('rating_explicit', currentPost);

    if (newRating === -1) {
      await updateSubredditRating(currentPost.subreddit, -1);
    } else if (existing?.localRating === -1) {
      await updateSubredditRating(currentPost.subreddit, 1);
    }
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

  function canUseGalleryNavigation() {
    return (
      (displayMode === 'fill' || displayMode === 'wild' || displayMode === 'wild2' || displayMode === 'wild3') &&
      currentMedia?.kind === 'gallery'
    );
  }

  async function stepForward() {
    if (canUseGalleryNavigation()) {
      await advanceGallery();
      return;
    }

    await advance();
  }

  async function stepBackward() {
    if (canUseGalleryNavigation()) {
      await retreatGallery();
      return;
    }

    await retreat();
  }

  function handleMediaStateChange(detail: { state: 'loading' | 'ready' | 'error' }) {
    currentMediaLoadState = detail.state;
  }

  function handleVideoTimingChange(detail: Pick<VideoTiming, 'currentTime' | 'duration' | 'paused'>) {
    mergeVideoTimingSnapshot(detail);
  }

  function captureActiveTileVideoTiming(index: number, event: Event) {
    if (index !== currentIndex) return;

    const video = event.currentTarget as HTMLVideoElement;
    mergeVideoTimingSnapshot({
      currentTime: video.currentTime,
      duration: video.duration,
      paused: video.paused,
    });
  }

  function handleViewerMouseMove() {
    if (autoAdvanceSuspended || !currentMedia) return;

    const now = Date.now();
    if (now - lastPointerResetAt < POINTER_RESET_THROTTLE_MS) return;
    lastPointerResetAt = now;
    resetAutoAdvanceClock();
  }

  function hasForwardTarget() {
    if (!currentMedia) return false;
    if (canUseGalleryNavigation() && galleryIndex < currentMedia.items.length - 1) return true;
    if (currentIndex < posts.length - 1) return true;
    return Boolean(afterCursor);
  }

  function canAutoAdvanceNow() {
    return (
      !autoAdvanceSuspended &&
      autoAdvanceRemainingMs !== null &&
      autoAdvanceRemainingMs <= 0 &&
      !autoAdvanceInFlight &&
      hasForwardTarget()
    );
  }

  async function runAutoAdvance() {
    if (!canAutoAdvanceNow() || !currentMedia) return;

    autoAdvanceInFlight = true;

    try {
      const canAdvanceGalleryItem =
        canUseGalleryNavigation() && galleryIndex < currentMedia.items.length - 1;

      if (canAdvanceGalleryItem || currentIndex < posts.length - 1) {
        await stepForward();
        return;
      }

      if (afterCursor) {
        const previousLength = posts.length;
        await loadMore();

        if (posts.length > previousLength) {
          await stepForward();
          return;
        }
      }
    } finally {
      autoAdvanceInFlight = false;
      resetAutoAdvanceClock();
    }
  }

  function toggleAutoAdvance() {
    autoAdvancePaused = !autoAdvancePaused;
    if (!autoAdvancePaused) {
      lastPointerResetAt = Date.now();
      resetAutoAdvanceClock();
    }
  }

  function handleImageAdvanceInput(event: Event) {
    imageAdvanceSeconds = clampImageAdvanceSeconds(
      Number((event.currentTarget as HTMLInputElement).value)
    );
    resetAutoAdvanceClock();
  }

  function handleVideoAdvanceInput(event: Event) {
    videoAdvancePlays = clampVideoAdvancePlays(
      Number((event.currentTarget as HTMLInputElement).value)
    );
    resetAutoAdvanceClock();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;

    const action = getViewerActionForKey(event.key);
    if (!action) return;

    if (getViewerShortcut(action).preventDefault) {
      event.preventDefault();
    }

    switch (action) {
      case 'skip_forward':
        void advance();
        break;
      case 'skip_backward':
        void retreat();
        break;
      case 'step_forward':
        void stepForward();
        break;
      case 'step_backward':
        void stepBackward();
        break;
      case 'open_reddit':
        void openReddit();
        break;
      case 'open_media':
        void openMedia();
        break;
      case 'rate_up':
        void rateUp();
        break;
      case 'rate_down':
        void rateDown();
        break;
      case 'toggle_auto_forward':
        toggleAutoAdvance();
        break;
      case 'display_fill':
        setDisplayMode('fill');
        break;
      case 'display_scroll':
        setDisplayMode('scroll');
        break;
      case 'display_masonry':
        setDisplayMode('masonry');
        break;
      case 'display_wild':
        setDisplayMode('wild');
        break;
      case 'display_wild2':
        setDisplayMode('wild2');
        break;
      case 'display_wild3':
        setDisplayMode('wild3');
        break;
    }
  }

  onMount(() => {
    syncRedditDebug();
    const storedMode = readStoredDisplayMode();
    if (storedMode) {
      displayMode = storedMode;
    }
    const storedAutoAdvance = readStoredAutoAdvanceSettings();
    if (storedAutoAdvance) {
      imageAdvanceSeconds = storedAutoAdvance.imageSeconds;
      videoAdvancePlays = storedAutoAdvance.videoPlays;
      autoAdvancePaused = storedAutoAdvance.paused;
    }

    window.addEventListener('keydown', handleKeydown);

    return () => {
      window.removeEventListener('keydown', handleKeydown);
      cancelAnimationFrame(scrollSyncFrame);
      cancelAnimationFrame(masonrySyncFrame);
    };
  });

  async function navigate() {
    const normalized = pathInput.trim().startsWith('/') ? pathInput.trim() : `/${pathInput.trim()}`;
    if (normalized.startsWith('/r/')) {
      const { goto } = await import('$app/navigation');
      goto(normalized);
    }
  }
</script>

<div
  class="viewer-page"
  data-feed-status={feedStatus}
  data-display-mode={displayMode}
  role="region"
  aria-label="Media viewer"
  onmousemove={handleViewerMouseMove}
>
  <div class="viewer-canvas">
    {#if loading}
      <div class="viewer-state loading">Loading feed…</div>
    {:else if error}
      <div class="viewer-state error">
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
        <button class="retry-button" onclick={() => loadFeed(subredditParam)}>Retry</button>
      </div>
    {:else if posts.length === 0}
      <div class="viewer-state empty">No media posts found in /r/{subredditParam}</div>
    {:else}
      <div class="feed" data-mode={displayMode}>
        {#if displayMode === 'fill'}
          {#if currentPost && currentMedia}
            {#key `${currentMedia.id}:${galleryIndex}:${currentPost.id}`}
              <MediaViewer
                media={currentMedia}
                itemIndex={galleryIndex}
                fit="contain"
                ambient={true}
                onevent={(detail) => addEvent({ ...detail, ts: Date.now(), type: detail.type as Parameters<typeof addEvent>[0]['type'] })}
                onstatechange={handleMediaStateChange}
                ontimingchange={handleVideoTimingChange}
              />
            {/key}
            <PostOverlay
              post={currentPost}
              mediaIndex={galleryIndex}
              totalMedia={totalItems}
              postIndex={currentIndex}
              totalPosts={posts.length}
              isSeen={isSeen}
              loadedMedia={loadedMediaStates}
              onadvance={advance}
              onretreat={retreat}
              onadvanceGallery={advanceGallery}
              onretreatGallery={retreatGallery}
              onrateUp={rateUp}
              onrateDown={rateDown}
              onopenReddit={openReddit}
              onopenMedia={openMedia}
            />
          {/if}
        {:else if displayMode === 'scroll'}
          <div bind:this={scrollFeedEl} class="scroll-feed" onscroll={handleScrollFeedScroll}>
            {#each displayTiles as tile (tile.post.id)}
              <article class="scroll-slide" data-index={tile.index} data-active={tile.isActive}>
                <button
                  type="button"
                  class="scroll-media"
                  aria-label={`Focus post ${tile.index + 1}`}
                  onclick={() => selectPost(tile.index)}
                >
                  {#if tile.isVideo}
                    <video
                      src={tile.item.url}
                      muted
                      autoplay={tile.isActive}
                      loop
                      playsinline
                      preload="metadata"
                      class="tile-video"
                      onloadedmetadata={(event) => captureActiveTileVideoTiming(tile.index, event)}
                      ontimeupdate={(event) => captureActiveTileVideoTiming(tile.index, event)}
                      onplay={(event) => captureActiveTileVideoTiming(tile.index, event)}
                      onpause={(event) => captureActiveTileVideoTiming(tile.index, event)}
                    ></video>
                  {:else}
                    <img src={tile.item.url} alt={tile.post.title} class="tile-image" loading="lazy" />
                  {/if}
                </button>
                <div class="scroll-slide-meta">
                  <span>{tile.index + 1} / {posts.length}</span>
                  <span>r/{tile.post.subreddit}</span>
                  {#if tile.itemCount > 1}
                    <span>{tile.itemCount} items</span>
                  {/if}
                </div>
              </article>
            {/each}
          </div>

          {#if currentPost}
            <div class="selection-card">
              <p class="selection-kicker">{currentDisplayMode.blurb}</p>
              <p class="selection-title">{currentPost.title}</p>
              <p class="selection-meta">
                <span>{currentIndex + 1} / {posts.length}</span>
                <span>r/{currentPost.subreddit}</span>
                <span>{currentPost.score} pts</span>
                {#if totalItems > 1}
                  <span>{galleryIndex + 1} / {totalItems} in set</span>
                {/if}
              </p>
              <div class="selection-actions">
                <button type="button" class="selection-action" class:active={currentPost.localRating === 1} onclick={() => rateUp()}>👍</button>
                <button type="button" class="selection-action" class:active={currentPost.localRating === -1} onclick={() => rateDown()}>👎</button>
                <button type="button" class="selection-action" onclick={() => openReddit()}>Reddit</button>
                <button type="button" class="selection-action" onclick={() => openMedia()}>Media</button>
              </div>
            </div>
          {/if}
        {:else if displayMode === 'masonry'}
          <div
            bind:this={masonryFeedEl}
            class="masonry-feed"
            role="region"
            aria-label="Masonry wall"
            onscroll={handleMasonryFeedScroll}
            onmouseenter={() => {
              masonryAutoPaused = true;
            }}
            onmouseleave={() => {
              masonryAutoPaused = false;
            }}
            onfocusin={() => {
              masonryAutoPaused = true;
            }}
            onfocusout={() => {
              masonryAutoPaused = false;
            }}
          >
            {#each displayTiles as tile (tile.post.id)}
              <button
                type="button"
                class="masonry-tile"
                data-index={tile.index}
                data-active={tile.isActive}
                style={`--tile-cols:${tile.masonryColSpan}; --tile-rows:${tile.masonryRowSpan}; --tile-ratio:${tile.aspectRatio};`}
                onclick={() => selectPost(tile.index)}
              >
                <div class="masonry-media">
                  {#if tile.isVideo}
                    <video
                      src={tile.item.url}
                      muted
                      autoplay={tile.isActive}
                      loop
                      playsinline
                      preload="metadata"
                      class="tile-video"
                      onloadedmetadata={(event) => captureActiveTileVideoTiming(tile.index, event)}
                      ontimeupdate={(event) => captureActiveTileVideoTiming(tile.index, event)}
                      onplay={(event) => captureActiveTileVideoTiming(tile.index, event)}
                      onpause={(event) => captureActiveTileVideoTiming(tile.index, event)}
                    ></video>
                  {:else}
                    <img src={tile.item.url} alt={tile.post.title} class="tile-image" loading="lazy" />
                  {/if}
                </div>
                <div class="masonry-caption">
                  <span class="masonry-count">{tile.index + 1}</span>
                  <span class="masonry-subreddit">r/{tile.post.subreddit}</span>
                </div>
              </button>
            {/each}
          </div>

          {#if currentPost}
            <div class="selection-card selection-card--masonry">
              <p class="selection-kicker">
                {#if masonryAutoPaused}
                  auto-scroll paused
                {:else}
                  auto-scroll cruising
                {/if}
              </p>
              <p class="selection-title">{currentPost.title}</p>
              <p class="selection-meta">
                <span>{currentIndex + 1} / {posts.length}</span>
                <span>r/{currentPost.subreddit}</span>
                <span>{currentPost.score} pts</span>
              </p>
              <div class="selection-actions">
                <button type="button" class="selection-action" class:active={currentPost.localRating === 1} onclick={() => rateUp()}>👍</button>
                <button type="button" class="selection-action" class:active={currentPost.localRating === -1} onclick={() => rateDown()}>👎</button>
                <button type="button" class="selection-action" onclick={() => openReddit()}>Reddit</button>
                <button type="button" class="selection-action" onclick={() => openMedia()}>Media</button>
              </div>
            </div>
          {/if}
        {:else if displayMode === 'wild' || displayMode === 'wild2' || displayMode === 'wild3'}
          <div class="wild-feed" data-variant={displayMode}>
            {#if currentItem && currentMedia}
              <div class="wild-backdrop">
                {#if currentMedia.kind === 'video'}
                  <video
                    src={currentItem.url}
                    muted
                    autoplay
                    loop
                    playsinline
                    preload="metadata"
                    class="wild-backdrop-media"
                  ></video>
                {:else}
                  <img src={currentItem.url} alt={currentPost?.title ?? 'Current post'} class="wild-backdrop-media" />
                {/if}
              </div>
            {/if}

            <div class="wild-veil"></div>

            <div class="wild-deck">
              {#each wildDeck as tile (tile.post.id)}
                <button
                  type="button"
                  class="wild-card"
                  data-offset={tile.offset}
                  data-active={tile.isActive}
                  data-center={tile.offset === 0}
                  style={`--float-delay:${tile.offset * 0.6}s;`}
                  onclick={() => selectPost(tile.index)}
                >
                  {#if tile.isVideo}
                    <video
                      src={tile.item.url}
                      muted
                      autoplay={tile.offset === 0}
                      loop
                      playsinline
                      preload="metadata"
                      class="wild-card-media"
                      onloadedmetadata={(event) => captureActiveTileVideoTiming(tile.index, event)}
                      ontimeupdate={(event) => captureActiveTileVideoTiming(tile.index, event)}
                      onplay={(event) => captureActiveTileVideoTiming(tile.index, event)}
                      onpause={(event) => captureActiveTileVideoTiming(tile.index, event)}
                    ></video>
                  {:else}
                    <img src={tile.item.url} alt={tile.post.title} class="wild-card-media" />
                  {/if}
                  <div class="wild-card-copy">
                    <span>{tile.index + 1}</span>
                    <span>r/{tile.post.subreddit}</span>
                  </div>
                </button>
              {/each}
            </div>

            {#if currentPost && currentMedia}
              <PostOverlay
                post={currentPost}
                mediaIndex={galleryIndex}
                totalMedia={totalItems}
                postIndex={currentIndex}
                totalPosts={posts.length}
                isSeen={isSeen}
                loadedMedia={loadedMediaStates}
                onadvance={advance}
                onretreat={retreat}
                onadvanceGallery={advanceGallery}
                onretreatGallery={retreatGallery}
                onrateUp={rateUp}
                onrateDown={rateDown}
                onopenReddit={openReddit}
                onopenMedia={openMedia}
              />
            {/if}
          </div>
        {/if}

        {#if loadingMore}
          <div class="feed-loading-indicator">pulling in more media…</div>
        {/if}
      </div>
    {/if}
  </div>

  <nav class="topbar">
    <a href="/r/all" class="logo">SubGlass</a>

    <form onsubmit={(event) => { event.preventDefault(); navigate(); }} class="path-form">
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

    <div class="display-switcher" role="tablist" aria-label="Display modes">
      {#each DISPLAY_MODES as mode}
        <button
          type="button"
          class="display-chip"
          class:active={displayMode === mode.id}
          title={`${mode.blurb} (${getViewerShortcut(mode.action).displayKeys.join(' / ')})`}
          onclick={() => setDisplayMode(mode.id)}
        >
          <span>{mode.label}</span>
        </button>
      {/each}
    </div>
  </nav>

  {#if currentMedia && !loading && !error}
    <div
      class="auto-advance-hud"
      data-paused={autoAdvanceSuspended}
      style={`--auto-advance-progress:${autoAdvanceProgress};`}
    >
      <div class="auto-advance-progress" aria-hidden="true"></div>
      <button
        type="button"
        class="auto-advance-toggle"
        onclick={toggleAutoAdvance}
        title={`${autoAdvanceSummary} · Pause or resume auto-next (${getViewerShortcut('toggle_auto_forward').displayKeys.join(' / ')})`}
        aria-label={`${autoAdvanceSummary}. Pause or resume auto-next.`}
      >
        <span class="auto-advance-center-label">
          {#if autoAdvanceSuspended}
            paused
          {:else if currentMedia.kind === 'video' && !currentVideoTiming?.duration}
            ...
          {:else}
            {formatCountdownReadout(autoAdvanceRemainingMs)}
          {/if}
        </span>
      </button>
    </div>

    <div class="auto-advance-dock" data-paused={autoAdvanceSuspended}>
      <span class="auto-advance-title">{autoAdvanceSummary}</span>
      <details class="auto-settings">
        <summary>{imageAdvanceSeconds}s / {videoAdvancePlays}x</summary>
        <div class="auto-settings-panel">
          <label class="auto-setting-row">
            <span>image</span>
            <input
              type="number"
              min="1"
              max="30"
              value={imageAdvanceSeconds}
              oninput={handleImageAdvanceInput}
            />
            <span>s</span>
          </label>
          <label class="auto-setting-row">
            <span>video</span>
            <input
              type="number"
              min="1"
              max="6"
              value={videoAdvancePlays}
              oninput={handleVideoAdvanceInput}
            />
            <span>x</span>
          </label>
          <p class="auto-setting-note">video waits for the configured plays, never less than 5s</p>
        </div>
      </details>
    </div>
  {/if}

  {#if dev}
    <details bind:open={debugExpanded} class="debug-dock" class:has-error={!!error}>
      <summary>
        <div class="debug-summary-copy">
          <span class="debug-kicker">dbg</span>
          <span>Feed Debug</span>
        </div>
        <span class:error-state={!!error} class:loading-state={loading} class:ready-state={!error && !loading && posts.length > 0} class="debug-state">
          {feedStatus}
        </span>
      </summary>

      <div class="debug-body">
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
      </div>
    </details>
  {/if}
</div>

<style>
  .viewer-page {
    position: relative;
    min-height: 100vh;
    background:
      radial-gradient(circle at top, rgba(64, 108, 148, 0.18), transparent 42%),
      linear-gradient(180deg, #07090d 0%, #050608 50%, #030305 100%);
    overflow: hidden;
    isolation: isolate;
  }

  .viewer-canvas,
  .feed,
  .wild-feed {
    position: relative;
    min-height: 100vh;
  }

  .feed {
    height: 100vh;
    overflow: hidden;
  }

  .viewer-state {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 18px;
    padding: 120px 24px 40px;
    color: #b8bbc4;
    text-align: center;
  }

  .loading,
  .empty {
    font-size: clamp(1rem, 2vw, 1.2rem);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .error {
    width: min(960px, calc(100vw - 32px));
    margin: 0 auto;
    align-items: stretch;
    text-align: left;
    background: rgba(16, 18, 23, 0.88);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 28px;
    backdrop-filter: blur(22px);
    box-shadow: 0 26px 70px rgba(0, 0, 0, 0.45);
  }

  .error-header {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .error-title {
    color: #f1b3b3;
    font-weight: 600;
    margin: 0;
  }

  .error-badge {
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.05);
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
    background: rgba(11, 12, 16, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 18px;
    padding: 14px 16px;
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

  .error-body pre,
  .error-pre {
    margin: 10px 0 0;
    width: 100%;
    white-space: pre-wrap;
    word-break: break-word;
    background: #0d0d0d;
    border: 1px solid #252525;
    border-radius: 12px;
    padding: 12px;
    color: #cfcfcf;
  }

  .retry-button {
    align-self: flex-start;
    background: linear-gradient(135deg, #39658b, #1f3547);
    color: #edf6ff;
    border: none;
    padding: 10px 16px;
    border-radius: 999px;
  }

  .topbar {
    position: absolute;
    inset: 10px 10px auto;
    z-index: 30;
    display: flex;
    width: fit-content;
    max-width: calc(100vw - 20px);
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 8px 10px;
    border-radius: 18px;
    background: rgba(8, 11, 15, 0.28);
    border: 1px solid rgba(255, 255, 255, 0.06);
    backdrop-filter: blur(18px) saturate(0.95);
    box-shadow: 0 14px 32px rgba(0, 0, 0, 0.16);
    transition:
      background 220ms ease,
      border-color 220ms ease,
      box-shadow 220ms ease,
      backdrop-filter 220ms ease,
      transform 220ms ease,
      opacity 220ms ease;
  }

  .logo {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 6px 10px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(9, 12, 16, 0.2);
    backdrop-filter: blur(10px);
    font-weight: 700;
    font-size: 0.88rem;
    letter-spacing: 0.04em;
    color: rgba(198, 226, 246, 0.88);
    white-space: nowrap;
    transition:
      color 220ms ease,
      background 220ms ease,
      border-color 220ms ease,
      opacity 220ms ease,
      transform 220ms ease;
  }

  .path-form {
    display: flex;
    gap: 4px;
    flex: 1 1 220px;
    max-width: 260px;
    min-width: 0;
    overflow: hidden;
    transition:
      opacity 220ms ease,
      max-width 220ms ease,
      transform 220ms ease,
      filter 220ms ease;
  }

  .path-input {
    background: rgba(10, 14, 19, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.09);
    color: #e0e0e0;
    padding: 7px 9px;
    border-radius: 10px;
    font-size: 0.82rem;
    flex: 1;
  }

  .path-form button,
  .display-chip,
  .selection-action {
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: rgba(229, 241, 250, 0.9);
    background: rgba(255, 255, 255, 0.05);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    transition:
      background 180ms ease,
      border-color 180ms ease,
      color 180ms ease,
      box-shadow 180ms ease,
      transform 180ms ease,
      opacity 180ms ease;
  }

  .path-form button {
    padding: 7px 10px;
    border-radius: 10px;
    font-size: 0.8rem;
  }

  .path-form button:hover,
  .display-chip:hover,
  .selection-action:hover {
    background: rgba(255, 255, 255, 0.11);
    border-color: rgba(255, 255, 255, 0.12);
    color: #edf6ff;
  }

  .nav-links {
    display: flex;
    gap: 10px;
    font-size: 0.76rem;
    flex-wrap: wrap;
    min-width: 0;
    overflow: hidden;
    transition:
      opacity 220ms ease,
      max-width 220ms ease,
      transform 220ms ease,
      filter 220ms ease;
  }

  .nav-links a {
    color: #b0b7c4;
  }

  .nav-links a:hover {
    color: #edf6ff;
  }

  .display-switcher {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
    margin-left: auto;
    min-width: 0;
    overflow: hidden;
    transition:
      opacity 220ms ease,
      max-width 220ms ease,
      transform 220ms ease,
      filter 220ms ease;
  }

  .display-chip {
    padding: 6px 10px;
    border-radius: 999px;
    font-size: 0.74rem;
    text-transform: lowercase;
    letter-spacing: 0.04em;
    opacity: 0.74;
  }

  .display-chip.active {
    opacity: 1;
    transform: translateY(-1px);
    background: rgba(140, 199, 239, 0.16);
    border-color: rgba(140, 199, 239, 0.24);
    box-shadow: 0 10px 22px rgba(14, 20, 26, 0.14);
  }

  .debug-dock {
    position: absolute;
    top: 64px;
    right: 10px;
    z-index: 28;
    width: min(300px, calc(100vw - 20px));
    border-radius: 16px;
    background: rgba(9, 11, 14, 0.42);
    border: 1px solid rgba(255, 255, 255, 0.06);
    backdrop-filter: blur(18px) saturate(0.95);
    overflow: hidden;
    box-shadow: 0 14px 34px rgba(0, 0, 0, 0.16);
    transition:
      opacity 220ms ease,
      background 220ms ease,
      border-color 220ms ease,
      box-shadow 220ms ease,
      backdrop-filter 220ms ease,
      transform 220ms ease;
  }

  .debug-dock.has-error {
    border-color: rgba(106, 50, 50, 0.72);
  }

  .debug-dock summary,
  .debug-block summary {
    list-style: none;
  }

  .debug-dock summary::-webkit-details-marker,
  .debug-block summary::-webkit-details-marker,
  .error-details summary::-webkit-details-marker {
    display: none;
  }

  .debug-dock summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    cursor: pointer;
    color: #d7d7d7;
    font-size: 0.8rem;
    padding: 9px 10px;
  }

  .debug-summary-copy {
    display: flex;
    gap: 10px;
    align-items: center;
  }

  .debug-summary-copy > :last-child,
  .debug-state {
    transition:
      opacity 220ms ease,
      max-width 220ms ease,
      transform 220ms ease,
      filter 220ms ease;
  }

  .debug-summary-copy > :last-child {
    max-width: 120px;
    overflow: hidden;
  }

  .debug-kicker {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 34px;
    padding: 3px 7px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.06);
    color: #9ea7b4;
    font-size: 0.7rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .debug-body {
    padding: 0 10px 10px;
    max-height: min(62vh, 560px);
    overflow: auto;
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
    gap: 8px 10px;
    color: #bcbcbc;
    font-size: 0.78rem;
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
    background: rgba(15, 17, 22, 0.88);
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 16px;
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
    border-radius: 10px;
    padding: 10px;
    color: #cfcfcf;
  }

  .debug-empty {
    color: #8f8f8f;
  }

  .feed[data-mode='fill'] {
    background: #030303;
  }

  .scroll-feed {
    height: 100vh;
    overflow-y: auto;
    scroll-snap-type: y mandatory;
    overscroll-behavior-y: contain;
    background:
      radial-gradient(circle at center, rgba(88, 127, 161, 0.12), transparent 52%),
      linear-gradient(180deg, #07080b 0%, #040507 100%);
  }

  .scroll-slide {
    min-height: 100vh;
    scroll-snap-align: start;
    display: grid;
    justify-items: center;
    align-content: center;
    gap: 14px;
    padding: 92px 18px 32px;
  }

  .scroll-media,
  .masonry-tile,
  .wild-card {
    border: none;
    padding: 0;
    background: transparent;
  }

  .scroll-media {
    width: min(100%, 1080px);
    height: min(76vh, 860px);
    border-radius: 28px;
    overflow: hidden;
    box-shadow: 0 26px 72px rgba(0, 0, 0, 0.46);
  }

  .tile-image,
  .tile-video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    pointer-events: none;
  }

  .scroll-slide-meta,
  .selection-meta,
  .masonry-caption,
  .wild-card-copy {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    font-size: 0.78rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #b8c2cf;
    max-height: 42px;
    overflow: hidden;
    transition:
      opacity 220ms ease,
      max-height 220ms ease,
      transform 220ms ease,
      filter 220ms ease;
  }

  .scroll-slide-meta span,
  .selection-meta span,
  .masonry-caption span,
  .wild-card-copy span {
    padding: 5px 9px;
    border-radius: 999px;
    background: rgba(9, 12, 16, 0.52);
    border: 1px solid rgba(255, 255, 255, 0.06);
    backdrop-filter: blur(10px);
  }

  .scroll-slide[data-active='true'] .scroll-media {
    outline: 2px solid rgba(140, 199, 239, 0.52);
    outline-offset: 4px;
  }

  .selection-card {
    position: absolute;
    left: 10px;
    bottom: 10px;
    z-index: 18;
    width: min(320px, calc(100vw - 20px));
    display: grid;
    gap: 6px;
    padding: 10px 11px;
    border-radius: 16px;
    background: rgba(9, 12, 16, 0.32);
    border: 1px solid rgba(255, 255, 255, 0.06);
    backdrop-filter: blur(16px) saturate(0.92);
    box-shadow: 0 14px 30px rgba(0, 0, 0, 0.18);
    transition:
      opacity 220ms ease,
      background 220ms ease,
      border-color 220ms ease,
      box-shadow 220ms ease,
      backdrop-filter 220ms ease,
      transform 220ms ease;
  }

  .selection-card--masonry {
    background: rgba(9, 11, 16, 0.36);
  }

  .selection-kicker {
    display: inline-flex;
    align-items: center;
    width: fit-content;
    padding: 4px 8px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(9, 12, 16, 0.2);
    backdrop-filter: blur(10px);
    color: rgba(152, 207, 241, 0.88);
    font-size: 0.68rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    transition:
      opacity 220ms ease,
      transform 220ms ease,
      background 220ms ease,
      border-color 220ms ease,
      color 220ms ease;
  }

  .selection-title {
    color: #edf6ff;
    font-size: 0.84rem;
    line-height: 1.25;
    max-height: 72px;
    display: -webkit-box;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
    transition:
      opacity 220ms ease,
      max-height 220ms ease,
      transform 220ms ease,
      filter 220ms ease;
  }

  .selection-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    max-height: 48px;
    overflow: hidden;
    transition:
      opacity 220ms ease,
      max-height 220ms ease,
      transform 220ms ease,
      filter 220ms ease;
  }

  .selection-action {
    padding: 6px 10px;
    border-radius: 999px;
    font-size: 0.76rem;
    min-width: 40px;
  }

  .selection-action.active {
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.24);
  }

  .masonry-feed {
    height: 100vh;
    overflow-y: auto;
    padding: 74px 10px 86px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    grid-auto-flow: dense;
    grid-auto-rows: 10px;
    gap: 10px;
    align-content: start;
    background:
      radial-gradient(circle at top center, rgba(82, 126, 163, 0.16), transparent 36%),
      linear-gradient(180deg, #07080b 0%, #040507 100%);
  }

  .masonry-tile {
    grid-column: span var(--tile-cols, 1);
    grid-row: span var(--tile-rows, 24);
    width: 100%;
    display: grid;
    grid-template-rows: 1fr auto;
    margin: 0;
    border-radius: 16px;
    overflow: hidden;
    background: rgba(9, 11, 15, 0.72);
    box-shadow: 0 16px 34px rgba(0, 0, 0, 0.24);
    transition: transform 0.2s ease, box-shadow 0.2s ease;
  }

  .masonry-tile[data-active='true'] {
    transform: translateY(-3px);
    box-shadow: 0 22px 54px rgba(0, 0, 0, 0.4);
  }

  .masonry-media {
    height: 100%;
    min-height: 100%;
    overflow: hidden;
  }

  .masonry-caption {
    padding: 8px 9px 10px;
  }

  .masonry-count {
    color: #edf6ff;
  }

  .wild-feed {
    overflow: hidden;
    background: #040506;
  }

  .wild-backdrop {
    position: absolute;
    inset: -8%;
    filter: blur(40px) saturate(1.35);
    opacity: 0.48;
    transform: scale(1.08);
  }

  .wild-backdrop-media {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .wild-veil {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(circle at center, rgba(255, 255, 255, 0.04), transparent 32%),
      linear-gradient(180deg, rgba(5, 7, 10, 0.2) 0%, rgba(5, 7, 10, 0.84) 100%);
  }

  .wild-deck {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .wild-card {
    pointer-events: auto;
    position: absolute;
    overflow: hidden;
    border-radius: 20px;
    background: rgba(9, 11, 16, 0.76);
    box-shadow: 0 24px 50px rgba(0, 0, 0, 0.4);
    animation: wildFloat 11s ease-in-out infinite;
    animation-delay: var(--float-delay, 0s);
    transition: transform 0.22s ease, box-shadow 0.22s ease;
  }

  .wild-card[data-center='true'] {
    z-index: 9;
  }

  .wild-card[data-active='true'] {
    box-shadow: 0 34px 76px rgba(0, 0, 0, 0.52);
  }

  .wild-card[data-offset='-3'] {
    top: 14%;
    left: 4%;
    width: clamp(150px, 16vw, 240px);
    aspect-ratio: 0.76;
    transform: rotate(-16deg);
  }

  .wild-card[data-offset='-2'] {
    top: 8%;
    left: 18%;
    width: clamp(180px, 18vw, 270px);
    aspect-ratio: 0.74;
    transform: rotate(-10deg);
  }

  .wild-card[data-offset='-1'] {
    top: 21%;
    left: 26%;
    width: clamp(220px, 22vw, 320px);
    aspect-ratio: 0.74;
    transform: rotate(-5deg);
  }

  .wild-card[data-offset='0'] {
    top: 11%;
    left: 50%;
    width: min(46vw, 620px);
    aspect-ratio: 0.72;
    transform: translateX(-50%) rotate(-1deg);
  }

  .wild-card[data-offset='1'] {
    top: 18%;
    right: 24%;
    width: clamp(220px, 22vw, 320px);
    aspect-ratio: 0.76;
    transform: rotate(6deg);
  }

  .wild-card[data-offset='2'] {
    top: 7%;
    right: 15%;
    width: clamp(180px, 18vw, 270px);
    aspect-ratio: 0.72;
    transform: rotate(12deg);
  }

  .wild-card[data-offset='3'] {
    top: 20%;
    right: 4%;
    width: clamp(150px, 16vw, 230px);
    aspect-ratio: 0.78;
    transform: rotate(18deg);
  }

  .wild-feed[data-variant='wild2'] .wild-card[data-offset='-3'] {
    top: 9%;
    left: 6%;
    width: clamp(120px, 13vw, 190px);
    aspect-ratio: 0.72;
    transform: rotate(-24deg);
  }

  .wild-feed[data-variant='wild2'] .wild-card[data-offset='-2'] {
    top: 38%;
    left: 10%;
    width: clamp(170px, 18vw, 250px);
    aspect-ratio: 0.86;
    transform: rotate(-12deg);
  }

  .wild-feed[data-variant='wild2'] .wild-card[data-offset='-1'] {
    top: 20%;
    left: 24%;
    width: clamp(220px, 21vw, 300px);
    aspect-ratio: 0.7;
    transform: rotate(-6deg);
  }

  .wild-feed[data-variant='wild2'] .wild-card[data-offset='0'] {
    top: 13%;
    left: 50%;
    width: min(40vw, 520px);
    aspect-ratio: 0.72;
    transform: translateX(-50%) rotate(-2deg);
  }

  .wild-feed[data-variant='wild2'] .wild-card[data-offset='1'] {
    top: 24%;
    right: 22%;
    width: clamp(210px, 21vw, 300px);
    aspect-ratio: 0.82;
    transform: rotate(7deg);
  }

  .wild-feed[data-variant='wild2'] .wild-card[data-offset='2'] {
    top: 10%;
    right: 11%;
    width: clamp(160px, 17vw, 240px);
    aspect-ratio: 0.74;
    transform: rotate(14deg);
  }

  .wild-feed[data-variant='wild2'] .wild-card[data-offset='3'] {
    top: 42%;
    right: 6%;
    width: clamp(130px, 13vw, 190px);
    aspect-ratio: 0.9;
    transform: rotate(20deg);
  }

  .wild-feed[data-variant='wild3'] .wild-card[data-offset='-3'],
  .wild-feed[data-variant='wild3'] .wild-card[data-offset='3'] {
    top: 16%;
    width: clamp(180px, 20vw, 280px);
    aspect-ratio: 1.3;
  }

  .wild-feed[data-variant='wild3'] .wild-card[data-offset='-3'] {
    left: 4%;
    transform: rotate(-9deg);
  }

  .wild-feed[data-variant='wild3'] .wild-card[data-offset='3'] {
    right: 4%;
    transform: rotate(9deg);
  }

  .wild-feed[data-variant='wild3'] .wild-card[data-offset='-2'],
  .wild-feed[data-variant='wild3'] .wild-card[data-offset='2'] {
    top: 58%;
    width: clamp(180px, 19vw, 260px);
    aspect-ratio: 1.1;
  }

  .wild-feed[data-variant='wild3'] .wild-card[data-offset='-2'] {
    left: 12%;
    transform: rotate(-6deg);
  }

  .wild-feed[data-variant='wild3'] .wild-card[data-offset='2'] {
    right: 12%;
    transform: rotate(6deg);
  }

  .wild-feed[data-variant='wild3'] .wild-card[data-offset='-1'] {
    top: 8%;
    left: 20%;
    width: clamp(230px, 24vw, 340px);
    aspect-ratio: 1.45;
    transform: rotate(-4deg);
  }

  .wild-feed[data-variant='wild3'] .wild-card[data-offset='0'] {
    top: 31%;
    left: 50%;
    width: min(62vw, 760px);
    aspect-ratio: 1.28;
    transform: translateX(-50%) rotate(-1deg);
  }

  .wild-feed[data-variant='wild3'] .wild-card[data-offset='1'] {
    top: 8%;
    right: 20%;
    width: clamp(230px, 24vw, 340px);
    aspect-ratio: 1.45;
    transform: rotate(4deg);
  }

  .wild-card-media {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .wild-card-copy {
    position: absolute;
    inset: auto 10px 10px;
    z-index: 1;
  }

  .auto-advance-hud {
    --auto-advance-progress: 0;
    position: absolute;
    top: 50%;
    left: 50%;
    z-index: 26;
    width: clamp(92px, 9vw, 116px);
    aspect-ratio: 1;
    border-radius: 50%;
    transform: translate(-50%, calc(-50% + clamp(46px, 9vh, 96px)));
    pointer-events: none;
    opacity: 0.16;
    transition:
      opacity 180ms ease,
      transform 180ms ease;
  }

  .auto-advance-hud::before {
    content: '';
    position: absolute;
    inset: 6px;
    border-radius: inherit;
    background: rgba(7, 10, 14, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.04);
    backdrop-filter: blur(22px) saturate(0.9);
    box-shadow:
      0 18px 46px rgba(0, 0, 0, 0.1),
      inset 0 1px 0 rgba(255, 255, 255, 0.03);
  }

  .auto-advance-hud:hover,
  .auto-advance-hud:focus-within {
    opacity: 0.62;
    transform: translate(-50%, calc(-50% + clamp(46px, 9vh, 96px))) scale(1.015);
  }

  .auto-advance-hud[data-paused='true'] {
    opacity: 0.1;
  }

  .auto-advance-progress {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background:
      conic-gradient(
        from -90deg,
        rgba(164, 209, 238, 0.28) 0turn calc(var(--auto-advance-progress) * 1turn),
        rgba(255, 255, 255, 0.045) calc(var(--auto-advance-progress) * 1turn) 1turn
      );
    -webkit-mask: radial-gradient(
      farthest-side,
      transparent calc(100% - 8px),
      #000 calc(100% - 7px)
    );
    mask: radial-gradient(
      farthest-side,
      transparent calc(100% - 8px),
      #000 calc(100% - 7px)
    );
    filter: blur(0.6px);
  }

  .auto-advance-hud[data-paused='true'] .auto-advance-progress {
    background: conic-gradient(from -90deg, rgba(255, 255, 255, 0.08) 0turn 1turn);
  }

  .auto-advance-toggle {
    position: absolute;
    inset: 12px;
    z-index: 1;
    display: grid;
    place-content: center;
    gap: 0;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.018);
    color: rgba(237, 246, 255, 0.86);
    text-align: center;
    cursor: pointer;
    pointer-events: auto;
    transition:
      background 180ms ease,
      color 180ms ease;
  }

  .auto-advance-toggle:hover {
    background: rgba(255, 255, 255, 0.04);
    color: rgba(237, 246, 255, 0.96);
  }

  .auto-advance-toggle:focus-visible,
  .auto-settings summary:focus-visible {
    outline: 2px solid rgba(140, 199, 239, 0.32);
    outline-offset: 2px;
  }

  .auto-advance-center-label {
    color: currentColor;
    font-size: 0.86rem;
    letter-spacing: 0.02em;
    font-variant-numeric: tabular-nums;
    text-shadow: 0 1px 12px rgba(0, 0, 0, 0.12);
  }

  .auto-advance-dock {
    position: absolute;
    right: 10px;
    bottom: 10px;
    z-index: 26;
    display: grid;
    justify-items: end;
    gap: 8px;
    max-width: min(320px, calc(100vw - 20px));
    padding: 8px 10px;
    border-radius: 16px;
    background: rgba(8, 10, 14, 0.24);
    border: 1px solid rgba(255, 255, 255, 0.05);
    backdrop-filter: blur(16px) saturate(0.92);
    box-shadow: 0 12px 26px rgba(0, 0, 0, 0.12);
    transition:
      opacity 220ms ease,
      background 220ms ease,
      border-color 220ms ease,
      box-shadow 220ms ease,
      backdrop-filter 220ms ease,
      transform 220ms ease;
  }

  .auto-advance-dock[data-paused='true'] {
    background: rgba(8, 10, 14, 0.42);
  }

  .auto-advance-title {
    color: rgba(237, 246, 255, 0.82);
    font-size: 0.72rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    max-height: 20px;
    overflow: hidden;
    text-overflow: ellipsis;
    transition:
      opacity 220ms ease,
      max-height 220ms ease,
      transform 220ms ease,
      filter 220ms ease;
  }

  .auto-settings {
    position: relative;
  }

  .auto-settings summary {
    list-style: none;
    cursor: pointer;
    border: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(255, 255, 255, 0.04);
    color: rgba(215, 227, 239, 0.88);
    border-radius: 999px;
    padding: 6px 10px;
    font-size: 0.72rem;
    text-transform: lowercase;
    transition:
      opacity 220ms ease,
      background 180ms ease,
      border-color 180ms ease,
      color 180ms ease,
      transform 180ms ease;
  }

  .auto-settings summary::-webkit-details-marker {
    display: none;
  }

  .auto-settings-panel {
    position: absolute;
    right: 0;
    bottom: calc(100% + 10px);
    width: min(220px, calc(100vw - 32px));
    display: grid;
    gap: 8px;
    padding: 10px;
    border-radius: 14px;
    background: rgba(10, 12, 16, 0.88);
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: 0 18px 34px rgba(0, 0, 0, 0.28);
  }

  .auto-setting-row {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 8px;
    align-items: center;
    font-size: 0.76rem;
    color: #d7e3ef;
  }

  .auto-setting-row input {
    width: 52px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.05);
    color: #edf6ff;
    padding: 5px 6px;
    font-size: 0.74rem;
  }

  .auto-setting-note {
    font-size: 0.68rem;
    color: #9eb0c1;
    line-height: 1.35;
  }

  .feed-loading-indicator {
    position: absolute;
    right: 10px;
    bottom: 60px;
    z-index: 17;
    padding: 8px 12px;
    border-radius: 999px;
    background: rgba(9, 12, 16, 0.76);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: #b7c0cb;
    font-size: 0.76rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    backdrop-filter: blur(14px);
  }

  @keyframes wildFloat {
    0%, 100% {
      translate: 0 0;
    }
    50% {
      translate: 0 -12px;
    }
  }

  @media (hover: hover) and (pointer: fine) {
    .topbar:not(:hover):not(:focus-within) {
      background: transparent;
      border-color: transparent;
      box-shadow: none;
      backdrop-filter: none;
      transform: translateY(-2px);
    }

    .topbar:not(:hover):not(:focus-within) .logo {
      color: rgba(198, 226, 246, 0.56);
      background: rgba(9, 12, 16, 0.12);
      border-color: rgba(255, 255, 255, 0.03);
    }

  .topbar:not(:hover):not(:focus-within) .path-form,
    .topbar:not(:hover):not(:focus-within) .nav-links,
    .topbar:not(:hover):not(:focus-within) .display-switcher {
      max-width: 0;
      opacity: 0;
      transform: translateY(-6px);
      filter: blur(3px);
      pointer-events: none;
    }

    .selection-card:not(:hover):not(:focus-within) {
      background: transparent;
      border-color: transparent;
      box-shadow: none;
      backdrop-filter: none;
      transform: translateY(4px);
    }

    .selection-card:not(:hover):not(:focus-within) .selection-title,
    .selection-card:not(:hover):not(:focus-within) .selection-meta,
    .selection-card:not(:hover):not(:focus-within) .selection-actions {
      max-height: 0;
      opacity: 0;
      transform: translateY(10px);
      filter: blur(3px);
      pointer-events: none;
    }

    .selection-card:not(:hover):not(:focus-within) .selection-kicker {
      color: rgba(152, 207, 241, 0.62);
      background: rgba(9, 12, 16, 0.12);
      border-color: rgba(255, 255, 255, 0.03);
    }

    .auto-advance-dock:not(:hover):not(:focus-within) {
      background: transparent;
      border-color: transparent;
      box-shadow: none;
      backdrop-filter: none;
      transform: translateY(4px);
    }

    .auto-advance-dock:not(:hover):not(:focus-within) .auto-advance-title {
      max-height: 0;
      opacity: 0;
      transform: translateY(8px);
      filter: blur(3px);
      pointer-events: none;
    }

    .auto-advance-dock:not(:hover):not(:focus-within) .auto-settings summary {
      opacity: 0.34;
      background: rgba(255, 255, 255, 0.025);
      border-color: rgba(255, 255, 255, 0.03);
      color: rgba(215, 227, 239, 0.54);
    }

    .debug-dock:not([open]):not(.has-error):not(:hover):not(:focus-within) {
      background: transparent;
      border-color: transparent;
      box-shadow: none;
      backdrop-filter: none;
      opacity: 0.28;
      transform: translateY(4px);
    }

    .debug-dock:not([open]):not(.has-error):not(:hover):not(:focus-within) .debug-summary-copy > :last-child {
      max-width: 0;
      opacity: 0;
      transform: translateX(-6px);
      pointer-events: none;
    }

    .debug-dock:not([open]):not(.has-error):not(:hover):not(:focus-within) .debug-state {
      opacity: 0;
    }

    .scroll-slide-meta,
    .masonry-caption,
    .wild-card-copy {
      opacity: 0.18;
      transform: translateY(6px);
      filter: blur(2px);
    }

    .scroll-slide:hover .scroll-slide-meta,
    .scroll-slide[data-active='true'] .scroll-slide-meta,
    .masonry-tile:hover .masonry-caption,
    .masonry-tile[data-active='true'] .masonry-caption,
    .wild-card:hover .wild-card-copy,
    .wild-card[data-active='true'] .wild-card-copy {
      opacity: 1;
      transform: translateY(0);
      filter: none;
    }
  }

  @media (max-width: 920px) {
    .topbar {
      inset: 8px 8px auto;
      padding: 8px;
    }

    .path-form {
      max-width: none;
      flex-basis: 100%;
      order: 3;
    }

    .nav-links {
      order: 4;
      width: 100%;
      overflow-x: auto;
      white-space: nowrap;
    }

    .display-switcher {
      order: 5;
      width: 100%;
      margin-left: 0;
    }

    .debug-dock {
      top: auto;
      bottom: 64px;
      right: 8px;
    }

    .selection-card {
      width: min(300px, calc(100vw - 16px));
      left: 8px;
      bottom: 8px;
    }

    .masonry-feed {
      padding-inline: 8px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .wild-card[data-offset='0'] {
      width: min(74vw, 420px);
      top: 18%;
    }

    .wild-card[data-offset='-1'] {
      left: 7%;
      top: 52%;
      width: min(34vw, 220px);
    }

    .wild-card[data-offset='1'] {
      right: 7%;
      top: 48%;
      width: min(34vw, 220px);
    }

    .wild-card[data-offset='-2'],
    .wild-card[data-offset='2'],
    .wild-card[data-offset='-3'],
    .wild-card[data-offset='3'] {
      display: none;
    }

    .auto-advance-hud {
      width: clamp(84px, 22vw, 102px);
      transform: translate(-50%, calc(-50% + clamp(34px, 11vh, 72px)));
    }

    .auto-advance-hud:hover,
    .auto-advance-hud:focus-within {
      transform: translate(-50%, calc(-50% + clamp(34px, 11vh, 72px))) scale(1.015);
    }

    .auto-advance-dock {
      left: 8px;
      right: 8px;
      bottom: 8px;
      max-width: none;
      justify-items: stretch;
    }

    .auto-advance-title {
      white-space: normal;
    }

    .auto-settings {
      justify-self: end;
    }

    .feed-loading-indicator {
      bottom: 72px;
      right: 8px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .display-chip,
    .masonry-tile,
    .wild-card,
    .auto-advance-hud,
    .auto-advance-toggle {
      transition: none;
    }

    .wild-card {
      animation: none;
    }

    .scroll-feed {
      scroll-behavior: auto;
    }
  }
</style>
