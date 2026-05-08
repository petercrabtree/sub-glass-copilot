<script lang="ts">
  import { dev } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { ExternalLink, Image as ImageIcon, ThumbsDown, ThumbsUp } from 'lucide-svelte';
  import type { FeedSnapshot, MediaGroup, MediaItem, MediaKind, PostRecord, SubredditRouletteSettings } from '$lib/types';
  import { fetchListing, readRedditDebugState } from '$lib/transport/reddit';
  import type { RedditDebugState, RedditRequestError } from '$lib/transport/reddit';
  import { normalizeListingResponse } from '$lib/normalize/posts';
  import { enrichRedgifsPosts } from '$lib/media/redgifs';
  import { profileScanManager } from '$lib/discovery/profile-scan-manager.svelte.js';
  import {
    DEFAULT_ROULETTE_SETTINGS,
    ROULETTE_LISTING_SORTS,
    ROULETTE_LISTING_TIMES,
    chooseRouletteSubreddits,
    formatRouletteRoutePath,
    formatRouletteBundle,
    isTimedRouletteListingSort,
    normalizeRouletteSettings,
    persistRouletteSettings,
    readStoredRouletteSettings,
  } from '$lib/discovery/roulette';
  import {
    upsertPost, upsertSubreddit, upsertMedia, upsertAdjacency,
    markPostSeen, setPostRating, getPost, getSeenPostIds, addEvent,
    getSubreddit, updateSubredditRating, getFeedSnapshot, setFeedSnapshot,
    getPostsByIds, getAllSubreddits, isSubredditUnavailable,
  } from '$lib/db/store';
  import { extractLinksFromPost } from '$lib/adjacency/extract';
  import MediaViewer from '$lib/components/MediaViewer.svelte';
  import PostOverlay from '$lib/components/PostOverlay.svelte';
  import ProfileScanStatus from '$lib/components/ProfileScanStatus.svelte';
  import VideoPreloadPool from '$lib/components/VideoPreloadPool.svelte';
  import {
    createVideoPreloadKey,
    type VideoPreloadState,
    type VideoPreloadTarget,
    type VideoPreloadUpdate,
  } from '$lib/media/video-preload';
  import {
    VIEWER_SHORTCUT_GROUPS,
    getViewerActionForKey,
    getViewerShortcut,
    type ViewerShortcutAction,
  } from '$lib/viewer/keyboard';
  import {
    inspectCachedMediaUrls,
    isInspectableMediaUrl,
    subscribeToMediaCacheUpdates,
    type MediaCacheRuntimeState,
    type MediaCacheState,
  } from '$lib/service-worker/media-cache';

  type LoadedMediaStatus = 'queued' | 'seen' | 'loading' | 'ready' | 'error';
  type LoadedVideoPreloadState = VideoPreloadState | 'skipped' | 'not-planned' | 'visible';
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
    videoPreloadKey?: string;
    videoPreloadUrl?: string;
    videoPreloadState: LoadedVideoPreloadState;
    videoPreloadBufferedSeconds?: number;
    videoPreloadDurationSeconds?: number;
    videoPreloadError?: string;
  };

  type ViewerUiMode = 'full' | 'mini' | 'hidden';
  type RouteListingSort = (typeof ROULETTE_LISTING_SORTS)[number];
  type RouteListingTime = (typeof ROULETTE_LISTING_TIMES)[number];

  const DISPLAY_MODE_STORAGE_KEY = 'subglass:display-mode';
  const AUTO_ADVANCE_SETTINGS_STORAGE_KEY = 'subglass:auto-advance-settings';
  const VIEWER_UI_MODE_STORAGE_KEY = 'subglass:viewer-ui-mode';
  const FEED_SNAPSHOT_SAVE_DELAY_MS = 160;
  const ROULETTE_QUERY_PARAM = 'roulette';
  const MIN_VIDEO_ADVANCE_MS = 5000;
  const VIEWER_UI_DISENGAGE_DELAY_MS = 900;
  const VIDEO_PRELOAD_AHEAD_POSTS = 8;
  const VIDEO_PRELOAD_BEHIND_POSTS = 1;
  const VIDEO_PRELOAD_DEFAULT_MAX_ACTIVE = 2;
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
  const VIEWER_UI_MODES: Array<{
    id: ViewerUiMode;
    label: string;
    blurb: string;
  }> = [
    { id: 'full', label: 'full', blurb: 'Compact chrome with expanded detail available' },
    { id: 'mini', label: 'mini', blurb: 'Tiny corner chrome with menus on demand' },
    { id: 'hidden', label: 'hide', blurb: 'Hide chrome until the tiny UI control is used' },
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
  let viewerUiMode = $state<ViewerUiMode>('full');
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
  let snapshotSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let lastRouteLoadKey = '';
  let activeRouteKey = $state('');
  let routeNotice = $state('');
  let routeNoticeRouteKey = $state('');
  const checkedRouteAvailabilityKeys = new Set<string>();
  let viewerUiEngaged = $state(false);
  let viewerUiDisengageTimer: ReturnType<typeof setTimeout> | undefined;
  let mediaCacheByUrl = $state<Record<string, boolean>>({});
  let mediaCacheRuntime = $state<MediaCacheRuntimeState>('inactive');
  let mediaCacheProbeGeneration = 0;
  let videoPreloadByKey = $state<Record<string, VideoPreloadUpdate>>({});
  let videoPreloadMaxActive = $state(VIDEO_PRELOAD_DEFAULT_MAX_ACTIVE);
  let lastVideoLoopBoundaryAt = $state(0);
  let rouletteSettings = $state<SubredditRouletteSettings>(DEFAULT_ROULETTE_SETTINGS);
  let rouletteTransitioning = $state(false);
  let rouletteMessage = $state('');

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

  function getLoadedMediaPreviewUrl(media: MediaGroup | undefined, selectedItemIndex = 0): string | undefined {
    if (!media) return undefined;

    const selectedItem = media.items[selectedItemIndex] ?? media.items[0];

    if (media.kind === 'video') {
      return media.thumbnailUrl;
    }

    if (media.kind === 'external_video') {
      return media.thumbnailUrl ?? selectedItem?.url;
    }

    return selectedItem?.url ?? media.thumbnailUrl;
  }

  function getLoadedMediaCacheUrl(media: MediaGroup | undefined, selectedItemIndex = 0): string | undefined {
    const previewUrl = getLoadedMediaPreviewUrl(media, selectedItemIndex);
    return previewUrl && isInspectableMediaUrl(previewUrl) ? previewUrl : undefined;
  }

  function getVideoPreloadPriority(index: number): number {
    const distance = index - currentIndex;
    return distance > 0
      ? distance
      : VIDEO_PRELOAD_AHEAD_POSTS + Math.abs(distance);
  }

  function getVideoPreloadTarget(
    post: PostRecord,
    index: number,
    selectedItemIndex = 0
  ): VideoPreloadTarget | undefined {
    const media = post.media;
    if (media?.kind !== 'video') return undefined;

    const item = media.items[selectedItemIndex] ?? media.items[0];
    if (!item?.url || !isInspectableMediaUrl(item.url)) return undefined;

    return {
      key: createVideoPreloadKey(post.id, media.id, selectedItemIndex, item.url),
      url: item.url,
      postId: post.id,
      mediaId: media.id,
      itemIndex: selectedItemIndex,
      postIndex: index,
      title: post.title,
      priority: getVideoPreloadPriority(index),
      mimeType: item.mimeType,
    };
  }

  function isInVideoPreloadWindow(index: number): boolean {
    const distance = index - currentIndex;
    return distance !== 0 &&
      distance >= -VIDEO_PRELOAD_BEHIND_POSTS &&
      distance <= VIDEO_PRELOAD_AHEAD_POSTS;
  }

  function getCurrentVideoPreloadState(): LoadedVideoPreloadState {
    if (currentMediaLoadState === 'error') return 'error';
    if (currentMediaLoadState === 'ready') return 'visible';
    return 'warming';
  }

  function getTileVideoPreloadMode(index: number): 'auto' | 'metadata' {
    return index === currentIndex || isInVideoPreloadWindow(index) ? 'auto' : 'metadata';
  }

  function resolveLoadedMediaVideoPreloadState(
    post: PostRecord,
    index: number,
    selectedItemIndex: number,
    plannedKeys: Set<string>
  ) {
    const target = getVideoPreloadTarget(post, index, selectedItemIndex);
    if (!target) {
      return { state: 'skipped' as LoadedVideoPreloadState };
    }

    if (index === currentIndex) {
      return {
        key: target.key,
        url: target.url,
        state: getCurrentVideoPreloadState(),
        bufferedSeconds: currentVideoTiming?.currentTime,
        durationSeconds: currentVideoTiming?.duration,
      };
    }

    const snapshot = videoPreloadByKey[target.key];
    if (snapshot) {
      return {
        key: target.key,
        url: target.url,
        state: snapshot.state as LoadedVideoPreloadState,
        bufferedSeconds: snapshot.bufferedSeconds,
        durationSeconds: snapshot.durationSeconds,
        error: snapshot.error,
      };
    }

    return {
      key: target.key,
      url: target.url,
      state: plannedKeys.has(target.key) ? 'queued' as LoadedVideoPreloadState : 'not-planned' as LoadedVideoPreloadState,
    };
  }

  function resolveLoadedMediaCacheState(cacheUrl: string | undefined): MediaCacheState {
    if (!cacheUrl) return 'skipped';
    if (mediaCacheRuntime === 'unsupported') return 'unsupported';
    if (mediaCacheRuntime === 'inactive') return 'inactive';

    const isCached = mediaCacheByUrl[cacheUrl];
    return typeof isCached === 'boolean' ? (isCached ? 'cached' : 'live') : 'checking';
  }

  function formatLoadedMediaKind(kind: MediaKind | 'unknown') {
    return kind.replaceAll('_', ' ');
  }

  function formatLoadedMediaCacheState(cacheState: MediaCacheState) {
    switch (cacheState) {
      case 'cached':
        return 'cached';
      case 'live':
        return 'network';
      case 'checking':
        return 'checking';
      case 'inactive':
        return 'cache off';
      case 'unsupported':
        return 'unsupported';
      case 'skipped':
        return 'n/a';
    }
  }

  function formatVideoSeconds(seconds: number | undefined): string {
    if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return '0s';
    if (seconds < 10) return `${seconds.toFixed(1)}s`;
    return `${Math.round(seconds)}s`;
  }

  function formatLoadedMediaVideoPreloadState(item: Pick<
    LoadedMediaQueueItem,
    'videoPreloadState' | 'videoPreloadBufferedSeconds' | 'videoPreloadError'
  >) {
    switch (item.videoPreloadState) {
      case 'visible':
        return 'video visible';
      case 'buffered':
        return `video buffered ${formatVideoSeconds(item.videoPreloadBufferedSeconds)}`;
      case 'ready':
        return 'video ready';
      case 'metadata':
        return 'video metadata';
      case 'warming':
        return 'video warming';
      case 'queued':
        return 'video queued';
      case 'not-planned':
        return 'video not planned';
      case 'error':
        return item.videoPreloadError ? `video error: ${item.videoPreloadError}` : 'video error';
      case 'skipped':
        return 'n/a';
    }
  }

  function getPreferredVideoPreloadLimit(): number {
    if (typeof navigator === 'undefined') return VIDEO_PRELOAD_DEFAULT_MAX_ACTIVE;

    const connection = (navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }).connection;
    if (connection?.saveData) return 0;

    const effectiveType = connection?.effectiveType ?? '';
    if (effectiveType.includes('2g') || effectiveType === 'slow-2g') return 1;
    if (effectiveType === '3g') return 1;

    return VIDEO_PRELOAD_DEFAULT_MAX_ACTIVE;
  }

  function refreshVideoPreloadBudget() {
    videoPreloadMaxActive = getPreferredVideoPreloadLimit();
  }

  function handleVideoPreloadUpdate(update: VideoPreloadUpdate) {
    videoPreloadByKey = {
      ...videoPreloadByKey,
      [update.key]: update,
    };
  }

  async function refreshMediaCacheRuntime() {
    if (typeof window === 'undefined') return;

    if (!('caches' in window)) {
      mediaCacheRuntime = 'unsupported';
      return;
    }

    if (!('serviceWorker' in navigator)) {
      mediaCacheRuntime = 'inactive';
      return;
    }

    const registration = await navigator.serviceWorker.getRegistration();
    mediaCacheRuntime = registration?.active ? 'ready' : 'inactive';
  }

  async function probeLoadedMediaCache(urls: string[]) {
    if (typeof window === 'undefined' || mediaCacheRuntime !== 'ready') return;

    const probeUrls = [...new Set(urls.filter((url) => isInspectableMediaUrl(url)))];
    if (probeUrls.length === 0) {
      mediaCacheByUrl = {};
      return;
    }

    const generation = ++mediaCacheProbeGeneration;
    const cacheMatches = await inspectCachedMediaUrls(probeUrls);
    if (generation !== mediaCacheProbeGeneration) return;

    mediaCacheByUrl = {
      ...mediaCacheByUrl,
      ...cacheMatches,
    };
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

  function getVideoAdvanceTargetLoopCount(durationSeconds: number) {
    const durationMs = Math.round(durationSeconds * 1000);
    if (durationMs <= 0) return 0;

    const requiredPlayedMs = Math.max(
      MIN_VIDEO_ADVANCE_MS,
      Math.round(durationSeconds * 1000 * videoAdvancePlays)
    );

    return Math.ceil((autoAdvanceVideoAnchorPlayedMs + requiredPlayedMs) / durationMs);
  }

  function hasReachedVideoAdvanceBoundary(snapshot: VideoTiming | null = currentVideoTiming) {
    if (!snapshot?.duration) return false;
    return snapshot.completedLoops >= getVideoAdvanceTargetLoopCount(snapshot.duration);
  }

  function canAutoAdvanceFromVideoBoundary(snapshot: VideoTiming | null = currentVideoTiming) {
    return (
      currentMedia?.kind === 'video' &&
      !autoAdvanceSuspended &&
      !autoAdvanceInFlight &&
      hasForwardTarget() &&
      hasReachedVideoAdvanceBoundary(snapshot)
    );
  }

  function maybeRunAutoAdvanceFromVideoBoundary(snapshot: VideoTiming | null = currentVideoTiming) {
    if (!canAutoAdvanceFromVideoBoundary(snapshot)) return;
    void runAutoAdvance('video-boundary');
  }

  function mergeVideoTimingSnapshot(nextSample: {
    currentTime: number;
    duration: number;
    paused: boolean;
  }) {
    const duration = Number.isFinite(nextSample.duration) ? Math.max(0, nextSample.duration) : 0;
    const currentTime = Number.isFinite(nextSample.currentTime) ? Math.max(0, nextSample.currentTime) : 0;
    const previous = currentVideoTiming;
    const boundaryDetected = Boolean(
      previous &&
      previous.duration > 0 &&
      duration > 0 &&
      !previous.paused &&
      !nextSample.paused &&
      previous.currentTime > duration * 0.85 &&
      currentTime <= Math.min(1.25, Math.max(0.35, duration * 0.2)) &&
      previous.currentTime - currentTime >= Math.max(0.5, duration * 0.5)
    );
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const canRecordBoundary = boundaryDetected && now - lastVideoLoopBoundaryAt >= 250;

    const updatedTiming = {
      currentTime,
      duration,
      paused: nextSample.paused,
      completedLoops: (previous?.completedLoops ?? 0) + (canRecordBoundary ? 1 : 0),
    };
    currentVideoTiming = updatedTiming;

    if (canRecordBoundary) {
      lastVideoLoopBoundaryAt = now;
      maybeRunAutoAdvanceFromVideoBoundary(updatedTiming);
    }
  }

  function markVideoLoopBoundary() {
    const current = currentVideoTiming;
    if (!current || !current.duration) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - lastVideoLoopBoundaryAt < 250) return;

    lastVideoLoopBoundaryAt = now;

    const updatedTiming = {
      ...current,
      currentTime: 0,
      completedLoops: current.completedLoops + 1,
    };
    currentVideoTiming = updatedTiming;
    maybeRunAutoAdvanceFromVideoBoundary(updatedTiming);
  }

  function captureActiveTileVideoLoop(index: number) {
    if (index !== currentIndex) return;
    markVideoLoopBoundary();
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

  function isViewerUiMode(value: string | null): value is ViewerUiMode {
    return VIEWER_UI_MODES.some((mode) => mode.id === value);
  }

  function readStoredViewerUiMode(): ViewerUiMode | null {
    if (typeof window === 'undefined') return null;

    try {
      const stored = window.localStorage.getItem(VIEWER_UI_MODE_STORAGE_KEY);
      return isViewerUiMode(stored) ? stored : null;
    } catch {
      return null;
    }
  }

  function persistViewerUiMode(mode: ViewerUiMode) {
    if (typeof window === 'undefined') return;

    try {
      window.localStorage.setItem(VIEWER_UI_MODE_STORAGE_KEY, mode);
    } catch {
      // Ignore storage failures in private mode or restricted environments.
    }
  }

  function setViewerUiMode(mode: ViewerUiMode) {
    viewerUiMode = mode;
    persistViewerUiMode(mode);
    if (mode !== 'hidden') {
      engageViewerUi();
      releaseViewerUiSoon();
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

  function engageViewerUi() {
    clearTimeout(viewerUiDisengageTimer);
    viewerUiEngaged = true;
  }

  function releaseViewerUiSoon() {
    clearTimeout(viewerUiDisengageTimer);
    viewerUiDisengageTimer = setTimeout(() => {
      viewerUiEngaged = false;
    }, VIEWER_UI_DISENGAGE_DELAY_MS);
  }

  function handleViewerSurfaceFocusOut(event: FocusEvent) {
    const currentTarget = event.currentTarget as HTMLElement | null;
    if (currentTarget && event.relatedTarget instanceof Node && currentTarget.contains(event.relatedTarget)) {
      return;
    }

    releaseViewerUiSoon();
  }

  function syncCurrentSelectionState() {
    const media = posts[currentIndex]?.media;

    currentVideoTiming = media?.kind === 'video'
      ? { currentTime: 0, duration: 0, paused: false, completedLoops: 0 }
      : null;
    lastVideoLoopBoundaryAt = 0;
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
    scheduleFeedSnapshotSave();
  }

  async function selectPost(index: number) {
    if (index < 0 || index >= posts.length) return;

    if (index === currentIndex) {
      focusCurrentPostInActiveMode('smooth');
      return;
    }

    const previousPost = currentPost;
    setDisplaySelection(index);
    focusCurrentPostInActiveMode('smooth');
    await recordEvent('view_end', previousPost);
    await recordEvent('impression', posts[index]);
    await recordEvent('view_start', posts[index]);

    if (index >= posts.length - (VIDEO_PRELOAD_AHEAD_POSTS + 5)) {
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
    return sub
      .split('/')[0]
      ?.split('+')
      .map((name) => name.trim().replace(/^\/?r\//i, '').toLowerCase())
      .filter(Boolean) ?? [];
  }

  function getRouteListingSort(sub: string): RouteListingSort {
    const routeSort = sub
      .split('/')
      .slice(1)
      .find((part) => part.trim().length > 0)
      ?.trim()
      .toLowerCase();

    return ROULETTE_LISTING_SORTS.includes(routeSort as RouteListingSort)
      ? routeSort as RouteListingSort
      : 'hot';
  }

  function getRouteListingTime(time: string | undefined): RouteListingTime | undefined {
    return ROULETTE_LISTING_TIMES.includes(time as RouteListingTime)
      ? time as RouteListingTime
      : undefined;
  }

  function formatRouteTargetSummary(sub: string) {
    const routeSubs = extractSubreddits(sub).filter((name) => name !== 'all');
    if (routeSubs.length === 0) return 'r/all';
    if (routeSubs.length === 1) return `r/${routeSubs[0]}`;
    return `${routeSubs.length} subs`;
  }

  function formatRouteListingSummary(sub: string, time: string | undefined) {
    const sort = getRouteListingSort(sub);
    const listingTime = getRouteListingTime(time);
    return isTimedRouletteListingSort(sort) && listingTime ? `${sort}/${listingTime}` : sort;
  }

  function formatRouteSummary(
    sub: string,
    time: string | undefined,
    roulette: boolean,
    imagesPerRound: number
  ) {
    const parts = [
      formatRouteTargetSummary(sub),
      formatRouteListingSummary(sub, time),
    ];

    if (roulette) {
      parts.push('roulette', `${imagesPerRound} images`);
    }

    return parts.join(' · ');
  }

  function getFeedRouteKey(sub: string, time: string | undefined, roulette: boolean) {
    return `${roulette ? 'roulette' : 'feed'}:/r/${sub}?t=${time ?? ''}`;
  }

  function getFeedPath(sub: string, time: string | undefined, roulette: boolean) {
    const params = new URLSearchParams();
    if (time) params.set('t', time);
    if (roulette) params.set(ROULETTE_QUERY_PARAM, '1');
    const query = params.toString();
    return `/r/${sub}${query ? `?${query}` : ''}`;
  }

  function replaceRouteSubredditBundle(sub: string, subreddits: string[]) {
    const slashIndex = sub.indexOf('/');
    const suffix = slashIndex >= 0 ? sub.slice(slashIndex) : '';
    const nextBundle = subreddits.length > 0 ? subreddits.join('+') : 'all';
    return `${nextBundle}${suffix}`;
  }

  async function getKnownUnavailableRouteFilter(sub: string) {
    const routeSubs = extractSubreddits(sub);
    if (routeSubs.length === 0) return null;

    const kept: string[] = [];
    const removed: string[] = [];

    for (const name of routeSubs) {
      if (name === 'all') {
        kept.push(name);
        continue;
      }

      const record = await getSubreddit(name);
      if (isSubredditUnavailable(record)) {
        removed.push(name);
      } else {
        kept.push(name);
      }
    }

    if (removed.length === 0) return null;

    return {
      removed,
      sanitizedSub: replaceRouteSubredditBundle(sub, kept),
    };
  }

  async function loadRouteFromParams(sub: string, time: string | undefined, roulette: boolean, routeKey: string) {
    const filter = await getKnownUnavailableRouteFilter(sub);
    if (routeKey !== lastRouteLoadKey) return;

    if (filter && filter.sanitizedSub !== sub) {
      const targetRouteKey = getFeedRouteKey(filter.sanitizedSub, time, roulette);
      routeNotice = `Removed unavailable ${filter.removed.map((name) => `r/${name}`).join(', ')}`;
      routeNoticeRouteKey = targetRouteKey;
      await goto(getFeedPath(filter.sanitizedSub, time, roulette), { replaceState: true });
      return;
    }

    subredditParam = sub;
    listingTime = time;
    pathInput = getFeedPath(sub, time, roulette);
    loadFeed(sub, time, roulette);
  }

  function shouldCheckRouteMembersAfterListingError(sub: string, error: RedditRequestError) {
    if (error.tooFast || error.kind !== 'http') return false;
    if (error.rateLimitedUntil && error.rateLimitedUntil > Date.now()) return false;
    if (error.status !== 403 && error.status !== 404) return false;
    return extractSubreddits(sub).some((name) => name !== 'all');
  }

  async function recheckRouteMembersAfterListingError(
    sub: string,
    time: string | undefined,
    roulette: boolean,
    error: RedditRequestError
  ) {
    if (!shouldCheckRouteMembersAfterListingError(sub, error)) return false;

    const routeKey = getFeedRouteKey(sub, time, roulette);
    const checkKey = `${routeKey}:availability`;
    if (checkedRouteAvailabilityKeys.has(checkKey)) return false;
    checkedRouteAvailabilityKeys.add(checkKey);

    const routeSubs = extractSubreddits(sub).filter((name) => name !== 'all');
    routeNotice = `Checking ${routeSubs.length} subreddit profile${routeSubs.length === 1 ? '' : 's'} after feed failure`;
    routeNoticeRouteKey = routeKey;
    await profileScanManager.scanRouteMembers(routeSubs);

    const filter = await getKnownUnavailableRouteFilter(sub);
    if (!filter || filter.sanitizedSub === sub) return false;

    const targetRouteKey = getFeedRouteKey(filter.sanitizedSub, time, roulette);
    routeNotice = `Removed unavailable ${filter.removed.map((name) => `r/${name}`).join(', ')}`;
    routeNoticeRouteKey = targetRouteKey;
    await goto(getFeedPath(filter.sanitizedSub, time, roulette), { replaceState: true });
    return true;
  }

  function clampIndex(index: number, length: number) {
    if (length <= 0) return 0;
    return Math.min(length - 1, Math.max(0, Math.round(index)));
  }

  function mergePostsPreservingCurrent(freshPosts: PostRecord[], shouldPreserveCurrent: boolean) {
    if (!shouldPreserveCurrent || !currentPost) return { mergedPosts: freshPosts, nextIndex: 0 };

    const anchorId = currentPost.id;
    const seen = new Set(posts.map((post) => post.id));
    const mergedPosts = [...posts];

    for (const post of freshPosts) {
      if (seen.has(post.id)) continue;
      seen.add(post.id);
      mergedPosts.push(post);
    }

    return {
      mergedPosts,
      nextIndex: clampIndex(mergedPosts.findIndex((post) => post.id === anchorId), mergedPosts.length),
    };
  }

  async function hydrateFeedSnapshot(routeKey: string) {
    const snapshot = await getFeedSnapshot(routeKey);
    if (!snapshot?.postIds.length) return false;

    const storedPosts = (await getPostsByIds(snapshot.postIds)).filter((post) => post.media);
    if (storedPosts.length === 0) return false;

    posts = storedPosts;
    afterCursor = snapshot.afterCursor ?? null;
    currentIndex = clampIndex(snapshot.currentIndex, storedPosts.length);
    galleryIndex = clampIndex(
      snapshot.galleryIndex || 0,
      storedPosts[currentIndex]?.media?.items.length ?? 1
    );
    loading = false;
    error = null;
    syncCurrentSelectionState();
    requestAnimationFrame(() => focusCurrentPostInActiveMode('auto'));
    return true;
  }

  async function persistCurrentFeedSnapshot() {
    if (!activeRouteKey || posts.length === 0) return;

    const snapshot: FeedSnapshot = {
      routeKey: activeRouteKey,
      path: getFeedPath(subredditParam, listingTime, isRouletteMode),
      subreddits: extractSubreddits(subredditParam),
      time: listingTime,
      afterCursor,
      postIds: posts.map((post) => post.id),
      currentIndex,
      galleryIndex,
      updatedAt: Date.now(),
    };

    await setFeedSnapshot(snapshot);
  }

  function scheduleFeedSnapshotSave() {
    clearTimeout(snapshotSaveTimer);
    snapshotSaveTimer = setTimeout(() => {
      void persistCurrentFeedSnapshot();
    }, FEED_SNAPSHOT_SAVE_DELAY_MS);
  }

  async function persistLoadedPosts(mediaPosts: PostRecord[], routePath: string) {
    await Promise.all(mediaPosts.map(async (post) => {
      const routedPost = { ...post, fetchedInRoute: routePath };
      await upsertPost(routedPost);
      if (routedPost.media) await upsertMedia(routedPost.media);
      await ensureSubreddit(routedPost.subreddit, undefined, undefined, routedPost.isNsfw);
      const links = extractLinksFromPost(
        routedPost.title,
        routedPost.selftext ?? '',
        routedPost.subreddit,
        routedPost.crosspostParentSubreddit
      );
      for (const link of links) {
        await upsertAdjacency(link);
        await ensureSubreddit(link.toSubreddit, `${link.source}:r/${routedPost.subreddit}`, link.evidence);
      }
    }));
  }

  function getProfileScanTargets(sub: string, mediaPosts: PostRecord[]) {
    const routeSubs = extractSubreddits(sub).filter((name) => name !== 'all');
    if (routeSubs.length > 0 && routeSubs.length <= 12) return routeSubs;

    return [...new Set(mediaPosts.slice(0, 6).map((post) => post.subreddit).filter(Boolean))];
  }

  const feedStatus = $derived(
    error ? `error:${error.kind}` : loading ? 'loading' : posts.length > 0 ? 'ready' : 'idle'
  );
  const isRouletteMode = $derived($page.url.searchParams.get(ROULETTE_QUERY_PARAM) === '1');

  const currentPost = $derived(posts[currentIndex]);
  const currentMedia = $derived(currentPost?.media);
  const currentItem = $derived(currentMedia?.items?.[galleryIndex] ?? currentMedia?.items?.[0]);
  const totalItems = $derived(currentMedia?.items?.length ?? 0);
  const isSeen = $derived(currentPost ? seenIds.has(currentPost.id) : false);
  const currentDisplayMode = $derived(
    DISPLAY_MODES.find((mode) => mode.id === displayMode) ?? DISPLAY_MODES[0]
  );
  const activeSubredditBundle = $derived(extractSubreddits(subredditParam).filter((name) => name !== 'all'));
  const routeSummary = $derived(
    formatRouteSummary(subredditParam, listingTime, isRouletteMode, rouletteSettings.imagesPerRound)
  );
  const routeSummaryTitle = $derived(
    `${routeSummary}${pathInput ? ` · ${pathInput}` : ''}`
  );
  const rouletteRoundProgress = $derived(
    Math.min(currentIndex + 1, rouletteSettings.imagesPerRound)
  );
  const rouletteSortUsesTime = $derived(isTimedRouletteListingSort(rouletteSettings.listingSort));
  const autoAdvanceSuspended = $derived(
    autoAdvancePaused ||
    viewerUiEngaged ||
    currentMedia?.kind === 'external_video' ||
    (currentMedia?.kind === 'video' && currentVideoTiming?.paused === true)
  );
  const loadedMediaCacheUrls = $derived(
    posts.flatMap((post, index) => {
      const selectedItemIndex = index === currentIndex ? galleryIndex : 0;
      const cacheUrl = getLoadedMediaCacheUrl(post.media, selectedItemIndex);
      return cacheUrl ? [cacheUrl] : [];
    })
  );
  const videoPreloadTargets = $derived(
    posts
      .flatMap((post, index) => {
        if (!isInVideoPreloadWindow(index)) return [];
        const target = getVideoPreloadTarget(post, index, 0);
        return target ? [target] : [];
      })
      .sort((a, b) => a.priority - b.priority)
  );
  const plannedVideoPreloadKeys = $derived(new Set(videoPreloadTargets.map((target) => target.key)));
  const loadedMediaStates = $derived<LoadedMediaQueueItem[]>(
    posts.map((post, index) => {
      const status: LoadedMediaStatus =
        index === currentIndex
          ? currentMediaLoadState
          : seenIds.has(post.id)
            ? 'seen'
            : 'queued';
      const selectedItemIndex = index === currentIndex ? galleryIndex : 0;
      const previewUrl = getLoadedMediaPreviewUrl(post.media, selectedItemIndex);
      const cacheUrl = getLoadedMediaCacheUrl(post.media, selectedItemIndex);
      const videoPreload = resolveLoadedMediaVideoPreloadState(
        post,
        index,
        selectedItemIndex,
        plannedVideoPreloadKeys
      );

      return {
        id: post.id,
        index,
        kind: post.media?.kind ?? 'unknown',
        title: post.title,
        itemCount: post.media?.items.length ?? 0,
        rating: post.localRating,
        status,
        previewUrl,
        cacheUrl,
        cacheState: resolveLoadedMediaCacheState(cacheUrl),
        videoPreloadKey: videoPreload.key,
        videoPreloadUrl: videoPreload.url,
        videoPreloadState: videoPreload.state,
        videoPreloadBufferedSeconds: videoPreload.bufferedSeconds,
        videoPreloadDurationSeconds: videoPreload.durationSeconds,
        videoPreloadError: videoPreload.error,
      };
    })
  );
  const cacheableLoadedMediaCount = $derived(
    loadedMediaStates.filter((item) => item.cacheState !== 'skipped').length
  );
  const cachedLoadedMediaCount = $derived(
    loadedMediaStates.filter((item) => item.cacheState === 'cached').length
  );
  const loadedMediaCacheSummary = $derived(
    mediaCacheRuntime === 'ready'
      ? cacheableLoadedMediaCount > 0
        ? `${cachedLoadedMediaCount}/${cacheableLoadedMediaCount} cached`
        : 'cache ready'
      : mediaCacheRuntime === 'unsupported'
        ? 'cache unsupported'
        : 'cache inactive'
  );
  const videoLoadedMediaCount = $derived(
    loadedMediaStates.filter((item) => item.videoPreloadState !== 'skipped').length
  );
  const warmVideoLoadedMediaCount = $derived(
    loadedMediaStates.filter((item) =>
      item.videoPreloadState === 'visible' ||
      item.videoPreloadState === 'ready' ||
      item.videoPreloadState === 'buffered'
    ).length
  );
  const activeVideoPreloadCount = $derived(Math.min(videoPreloadTargets.length, videoPreloadMaxActive));
  const videoPreloadSummary = $derived(
    videoLoadedMediaCount > 0
      ? `${warmVideoLoadedMediaCount}/${videoLoadedMediaCount} video warm`
      : 'no videos'
  );
  const mediaReadinessSummary = $derived(`${loadedMediaCacheSummary} · ${videoPreloadSummary}`);
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
      ? currentMedia?.kind === 'external_video'
        ? 'external video: autonext unavailable'
        : currentMedia?.kind === 'video' && currentVideoTiming?.paused
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
    const roulette = $page.url.searchParams.get(ROULETTE_QUERY_PARAM) === '1';
    const routeKey = getFeedRouteKey(sub, time, roulette);
    if (routeKey === lastRouteLoadKey) return;
    lastRouteLoadKey = routeKey;
    void loadRouteFromParams(sub, time, roulette, routeKey);
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
    const cacheUrls = loadedMediaCacheUrls;
    if (typeof window === 'undefined') return;

    if (mediaCacheRuntime !== 'ready') {
      mediaCacheByUrl = {};
      return;
    }

    void probeLoadedMediaCache(cacheUrls);
  });

  $effect(() => {
    const retainedKeys = new Set(plannedVideoPreloadKeys);
    const currentVideoTarget = currentPost
      ? getVideoPreloadTarget(currentPost, currentIndex, galleryIndex)
      : undefined;
    if (currentVideoTarget) retainedKeys.add(currentVideoTarget.key);

    const entries = Object.entries(videoPreloadByKey)
      .filter(([key]) => retainedKeys.has(key));

    if (entries.length !== Object.keys(videoPreloadByKey).length) {
      videoPreloadByKey = Object.fromEntries(entries);
    }
  });

  $effect(() => {
    void imageAdvanceSeconds;
    void videoAdvancePlays;
    void autoAdvancePaused;
    persistAutoAdvanceSettings();
  });

  $effect(() => {
    void rouletteSettings.subredditCount;
    void rouletteSettings.imagesPerRound;
    void rouletteSettings.likedWeight;
    void rouletteSettings.newWeight;
    void rouletteSettings.randomWeight;
    void rouletteSettings.nsfwMode;
    void rouletteSettings.listingSort;
    void rouletteSettings.listingTime;
    persistRouletteSettings(rouletteSettings);
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

  async function loadFeed(sub: string, time: string | undefined = listingTime, roulette = isRouletteMode) {
    const routeKey = getFeedRouteKey(sub, time, roulette);
    activeRouteKey = routeKey;
    const restored = await hydrateFeedSnapshot(routeKey);

    loading = !restored;
    error = null;
    if (!restored) {
      posts = [];
      currentIndex = 0;
      galleryIndex = 0;
      afterCursor = null;
      syncCurrentSelectionState();
    }
    seenIds = await getSeenPostIds();

    const spec = { path: `/r/${sub}`, subreddits: extractSubreddits(sub), time };
    const result = await fetchListing(spec, 25);
    if (routeKey !== activeRouteKey || routeKey !== lastRouteLoadKey) return;
    syncRedditDebug();
    if (!result.ok) {
      console.error('Failed to load feed', result.error);
      if (await recheckRouteMembersAfterListingError(sub, time, roulette, result.error)) {
        loading = false;
        return;
      }
      if (!restored) {
        error = result.error;
      }
      loading = false;
      return;
    }

    afterCursor = result.data.data.after || null;
    const normalized = await enrichRedgifsPosts(normalizeListingResponse(result.data.data.children));
    const mediaPosts = normalized.filter((post) => post.media);

    await persistLoadedPosts(mediaPosts, getFeedPath(sub, time, roulette));

    const { mergedPosts, nextIndex } = mergePostsPreservingCurrent(mediaPosts, restored);
    posts = mergedPosts;
    currentIndex = nextIndex;
    loading = false;
    syncCurrentSelectionState();
    scheduleFeedSnapshotSave();

    const scanTargets = getProfileScanTargets(sub, mediaPosts);
    if (scanTargets.length > 0) {
      void profileScanManager.enqueueBackgroundTargets(scanTargets).catch((scanError) => {
        console.warn('Failed to scan subreddit profiles', scanError);
      });
    }

    if (mediaPosts.length > 0) {
      await recordEvent('impression', posts[currentIndex]);
    }
  }

  async function loadMore() {
    if (loadingMore || !afterCursor) return;
    const routeKey = activeRouteKey;
    loadingMore = true;

    const spec = {
      path: `/r/${subredditParam}`,
      subreddits: extractSubreddits(subredditParam),
      after: afterCursor,
      time: listingTime,
    };
    const result = await fetchListing(spec, 25);
    if (routeKey !== activeRouteKey) {
      loadingMore = false;
      return;
    }
    syncRedditDebug();

    if (result.ok) {
      afterCursor = result.data.data.after || null;
      const normalized = await enrichRedgifsPosts(normalizeListingResponse(result.data.data.children));
      const mediaPosts = normalized.filter((post) => post.media);

      await persistLoadedPosts(mediaPosts, getFeedPath(subredditParam, listingTime, isRouletteMode));

      const existingIds = new Set(posts.map((post) => post.id));
      posts = [...posts, ...mediaPosts.filter((post) => !existingIds.has(post.id))];
      scheduleFeedSnapshotSave();
    } else {
      console.error('Failed to load more posts', result.error);
    }

    loadingMore = false;
  }

  async function startNextRouletteRound() {
    if (rouletteTransitioning) return;
    rouletteTransitioning = true;
    rouletteMessage = '';

    try {
      const allSubreddits = await getAllSubreddits();
      const selected = chooseRouletteSubreddits(allSubreddits, rouletteSettings, activeSubredditBundle);
      if (selected.length === 0) {
        rouletteMessage = 'No eligible known subreddits yet. Scan or browse a few first.';
        return;
      }

      const bundle = formatRouletteBundle(selected);
      await goto(formatRouletteRoutePath(bundle, rouletteSettings));
    } finally {
      rouletteTransitioning = false;
    }
  }

  function updateRouletteSettings(nextSettings: Partial<SubredditRouletteSettings>) {
    rouletteSettings = normalizeRouletteSettings({
      ...rouletteSettings,
      ...nextSettings,
    });
  }

  function handleRouletteNumberInput(
    key: 'subredditCount' | 'imagesPerRound' | 'likedWeight' | 'newWeight' | 'randomWeight',
    event: Event
  ) {
    updateRouletteSettings({ [key]: Number((event.currentTarget as HTMLInputElement).value) });
  }

  function handleRouletteSelectInput(
    key: 'listingSort' | 'listingTime',
    event: Event
  ) {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (key === 'listingSort') {
      updateRouletteSettings({ listingSort: value as SubredditRouletteSettings['listingSort'] });
    } else {
      updateRouletteSettings({ listingTime: value as SubredditRouletteSettings['listingTime'] });
    }
  }

  async function ensureSubreddit(
    name: string,
    discoveredVia?: string,
    discoveryReason?: string,
    isNsfwHint?: boolean
  ) {
    const existing = await getSubreddit(name);
    if (!existing) {
      await upsertSubreddit({
        name: name.toLowerCase(),
        prefixedName: `r/${name.toLowerCase()}`,
        firstSeenAt: Date.now(),
        localRating: 0,
        isMuted: false,
        isNsfw: isNsfwHint,
        discoveryStatus: 'discovered',
        discoveredVia,
        discoveryReason,
      });
    } else {
      const nextIsNsfw = existing.isNsfw === true
        ? true
        : isNsfwHint ?? existing.isNsfw;
      if (!discoveredVia && !discoveryReason && nextIsNsfw === existing.isNsfw) return;

      await upsertSubreddit({
        ...existing,
        isNsfw: nextIsNsfw,
        discoveredVia: existing.discoveredVia ?? discoveredVia,
        discoveryReason: existing.discoveryReason ?? discoveryReason,
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

    if (isRouletteMode && currentIndex + 1 >= rouletteSettings.imagesPerRound) {
      await startNextRouletteRound();
      return;
    }

    if (currentIndex < posts.length - 1) {
      currentIndex++;
      galleryIndex = 0;
      syncCurrentSelectionState();
      scheduleFeedSnapshotSave();
      focusCurrentPostInActiveMode('smooth');
      await recordEvent('impression', posts[currentIndex]);
      await recordEvent('view_start', posts[currentIndex]);

      if (currentIndex >= posts.length - (VIDEO_PRELOAD_AHEAD_POSTS + 5)) {
        void loadMore();
      }
    } else if (isRouletteMode) {
      await startNextRouletteRound();
    }
  }

  async function retreat() {
    if (currentIndex > 0) {
      await recordEvent('view_end', currentPost);
      currentIndex--;
      galleryIndex = 0;
      syncCurrentSelectionState();
      scheduleFeedSnapshotSave();
      focusCurrentPostInActiveMode('smooth');
      await recordEvent('impression', posts[currentIndex]);
    }
  }

  async function advanceGallery() {
    if (!currentMedia) return;

    if (galleryIndex < currentMedia.items.length - 1) {
      galleryIndex++;
      syncCurrentSelectionState();
      scheduleFeedSnapshotSave();
      await recordEvent('advance_gallery', currentPost);
    } else {
      await advance();
    }
  }

  async function retreatGallery() {
    if (galleryIndex > 0) {
      galleryIndex--;
      syncCurrentSelectionState();
      scheduleFeedSnapshotSave();
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

    const delta = (newRating ?? 0) - (existing?.localRating ?? 0);
    if (delta !== 0) {
      await updateSubredditRating(currentPost.subreddit, delta);
    }
  }

  async function rateDown() {
    if (!currentPost) return;

    const existing = await getPost(currentPost.id);
    const newRating: -1 | undefined = existing?.localRating === -1 ? undefined : -1;
    await setPostRating(currentPost.id, newRating);
    posts = posts.map((post) => post.id === currentPost.id ? { ...post, localRating: newRating } : post);
    await recordEvent('rating_explicit', currentPost);

    const delta = (newRating ?? 0) - (existing?.localRating ?? 0);
    if (delta !== 0) {
      await updateSubredditRating(currentPost.subreddit, delta);
    }
  }

  async function rateUpAndAdvance() {
    await rateUp();
    await advance();
  }

  async function rateDownAndAdvance() {
    await rateDown();
    await advance();
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

  function hasForwardTarget() {
    if (!currentMedia) return false;
    if (canUseGalleryNavigation() && galleryIndex < currentMedia.items.length - 1) return true;
    if (currentIndex < posts.length - 1) return true;
    return Boolean(afterCursor);
  }

  function canAutoAdvanceNow() {
    if (!currentMedia || currentMedia.kind === 'video') return false;

    return (
      !autoAdvanceSuspended &&
      autoAdvanceRemainingMs !== null &&
      autoAdvanceRemainingMs <= 0 &&
      !autoAdvanceInFlight &&
      hasForwardTarget()
    );
  }

  async function runAutoAdvance(trigger: 'timer' | 'video-boundary' = 'timer') {
    if (!currentMedia) return;

    const canRun = trigger === 'video-boundary'
      ? canAutoAdvanceFromVideoBoundary()
      : canAutoAdvanceNow();

    if (!canRun) return;

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

    const shortcut = getViewerShortcut(action);
    if (shortcut.preventDefault) {
      event.preventDefault();
    }

    if (event.repeat && (action === 'rate_up_next' || action === 'rate_down_next')) return;

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
      case 'rate_up_next':
        void rateUpAndAdvance();
        break;
      case 'rate_down_next':
        void rateDownAndAdvance();
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
    const storedViewerUiMode = readStoredViewerUiMode();
    if (storedViewerUiMode) {
      viewerUiMode = storedViewerUiMode;
    }
    const storedAutoAdvance = readStoredAutoAdvanceSettings();
    if (storedAutoAdvance) {
      imageAdvanceSeconds = storedAutoAdvance.imageSeconds;
      videoAdvancePlays = storedAutoAdvance.videoPlays;
      autoAdvancePaused = storedAutoAdvance.paused;
    }
    rouletteSettings = readStoredRouletteSettings();

    void refreshMediaCacheRuntime();
    refreshVideoPreloadBudget();

    const connection = (navigator as Navigator & {
      connection?: EventTarget;
    }).connection;
    connection?.addEventListener('change', refreshVideoPreloadBudget);

    const unsubscribeFromMediaCache = subscribeToMediaCacheUpdates((url) => {
      mediaCacheByUrl = {
        ...mediaCacheByUrl,
        [url]: true,
      };
    });
    const handleServiceWorkerControllerChange = () => {
      void refreshMediaCacheRuntime();
    };

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('controllerchange', handleServiceWorkerControllerChange);
      void navigator.serviceWorker.ready.then(() => {
        void refreshMediaCacheRuntime();
      });
    }

    window.addEventListener('keydown', handleKeydown);

    return () => {
      unsubscribeFromMediaCache();
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('controllerchange', handleServiceWorkerControllerChange);
      }
      connection?.removeEventListener('change', refreshVideoPreloadBudget);
      window.removeEventListener('keydown', handleKeydown);
      cancelAnimationFrame(scrollSyncFrame);
      cancelAnimationFrame(masonrySyncFrame);
      clearTimeout(viewerUiDisengageTimer);
      clearTimeout(snapshotSaveTimer);
    };
  });

  async function navigate() {
    const normalized = pathInput.trim().startsWith('/') ? pathInput.trim() : `/${pathInput.trim()}`;
    if (normalized.startsWith('/r/')) {
      goto(normalized);
    }
  }
</script>

<div
  class="viewer-page"
  data-feed-status={feedStatus}
  data-display-mode={displayMode}
  data-ui-mode={viewerUiMode}
  role="region"
  aria-label="Media viewer"
>
  <VideoPreloadPool
    targets={videoPreloadTargets}
    maxActive={videoPreloadMaxActive}
    onupdate={handleVideoPreloadUpdate}
  />

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
                onvideoended={markVideoLoopBoundary}
              />
            {/key}
            <PostOverlay
              post={currentPost}
              uiMode={viewerUiMode}
              showTopBar={false}
              mediaIndex={galleryIndex}
              totalMedia={totalItems}
              postIndex={currentIndex}
              totalPosts={posts.length}
              isSeen={isSeen}
              loadedMedia={loadedMediaStates}
              imageCacheMode={mediaCacheRuntime}
              onadvance={advance}
              onretreat={retreat}
              onadvanceGallery={advanceGallery}
              onretreatGallery={retreatGallery}
              onselectLoadedMedia={selectPost}
              onrateUp={rateUp}
              onrateDown={rateDown}
              onopenReddit={openReddit}
              onopenMedia={openMedia}
              oncontrolenter={engageViewerUi}
              oncontrolleave={releaseViewerUiSoon}
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
	                      preload={getTileVideoPreloadMode(tile.index)}
                      class="tile-video"
                      onloadedmetadata={(event) => captureActiveTileVideoTiming(tile.index, event)}
                      ontimeupdate={(event) => captureActiveTileVideoTiming(tile.index, event)}
                      onplay={(event) => captureActiveTileVideoTiming(tile.index, event)}
                      onpause={(event) => captureActiveTileVideoTiming(tile.index, event)}
                      onended={() => captureActiveTileVideoLoop(tile.index)}
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
            <div
              class="selection-card"
              role="group"
              aria-label="Current post details"
              onpointerenter={engageViewerUi}
              onpointerleave={releaseViewerUiSoon}
              onfocusin={engageViewerUi}
              onfocusout={handleViewerSurfaceFocusOut}
            >
              <p class="selection-subreddit">r/{currentPost.subreddit}</p>
              <p class="selection-title">{currentPost.title}</p>
              <p class="selection-kicker">{currentDisplayMode.blurb}</p>
              <p class="selection-meta">
                <span>{currentIndex + 1} / {posts.length}</span>
                <span>{currentPost.score} pts</span>
                {#if totalItems > 1}
                  <span>{galleryIndex + 1} / {totalItems} in set</span>
                {/if}
              </p>
            </div>
            <div
              class="selection-actions"
              role="group"
              aria-label="Current post actions"
              onpointerenter={engageViewerUi}
              onpointerleave={releaseViewerUiSoon}
              onfocusin={engageViewerUi}
              onfocusout={handleViewerSurfaceFocusOut}
            >
              <button
                type="button"
                class="selection-action"
                class:active={currentPost.localRating === 1}
                title={`Thumbs up (${getViewerShortcut('rate_up_next').displayKeys.join(' / ')} rates and advances)`}
                aria-label="Rate up"
                onclick={() => rateUp()}
              ><ThumbsUp size={16} strokeWidth={1.9} aria-hidden="true" /></button>
              <button
                type="button"
                class="selection-action"
                class:active={currentPost.localRating === -1}
                title={`Thumbs down (${getViewerShortcut('rate_down_next').displayKeys.join(' / ')} rates and advances)`}
                aria-label="Rate down"
                onclick={() => rateDown()}
              ><ThumbsDown size={16} strokeWidth={1.9} aria-hidden="true" /></button>
              <button
                type="button"
                class="selection-action"
                title={`Open on Reddit (${getViewerShortcut('open_reddit').displayKeys.join(' / ')})`}
                aria-label="Open Reddit post"
                onclick={() => openReddit()}
              ><ExternalLink size={16} strokeWidth={1.9} aria-hidden="true" /></button>
              <button
                type="button"
                class="selection-action"
                title={`Open media (${getViewerShortcut('open_media').displayKeys.join(' / ')})`}
                aria-label="Open media URL"
                onclick={() => openMedia()}
              ><ImageIcon size={16} strokeWidth={1.9} aria-hidden="true" /></button>
            </div>
          {/if}
        {:else if displayMode === 'masonry'}
          <div
            bind:this={masonryFeedEl}
            class="masonry-feed"
            role="region"
            aria-label="Masonry wall"
            onscroll={handleMasonryFeedScroll}
            onpointerenter={() => {
              masonryAutoPaused = true;
            }}
            onpointerleave={() => {
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
	                      preload={getTileVideoPreloadMode(tile.index)}
                      class="tile-video"
                      onloadedmetadata={(event) => captureActiveTileVideoTiming(tile.index, event)}
                      ontimeupdate={(event) => captureActiveTileVideoTiming(tile.index, event)}
                      onplay={(event) => captureActiveTileVideoTiming(tile.index, event)}
                      onpause={(event) => captureActiveTileVideoTiming(tile.index, event)}
                      onended={() => captureActiveTileVideoLoop(tile.index)}
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
            <div
              class="selection-card selection-card--masonry"
              role="group"
              aria-label="Current masonry selection details"
              onpointerenter={engageViewerUi}
              onpointerleave={releaseViewerUiSoon}
              onfocusin={engageViewerUi}
              onfocusout={handleViewerSurfaceFocusOut}
            >
              <p class="selection-subreddit">r/{currentPost.subreddit}</p>
              <p class="selection-title">{currentPost.title}</p>
              <p class="selection-kicker">
                {#if masonryAutoPaused}
                  auto-scroll paused
                {:else}
                  auto-scroll cruising
                {/if}
              </p>
              <p class="selection-meta">
                <span>{currentIndex + 1} / {posts.length}</span>
                <span>{currentPost.score} pts</span>
              </p>
            </div>
            <div
              class="selection-actions"
              role="group"
              aria-label="Current masonry selection actions"
              onpointerenter={engageViewerUi}
              onpointerleave={releaseViewerUiSoon}
              onfocusin={engageViewerUi}
              onfocusout={handleViewerSurfaceFocusOut}
            >
              <button
                type="button"
                class="selection-action"
                class:active={currentPost.localRating === 1}
                title={`Thumbs up (${getViewerShortcut('rate_up_next').displayKeys.join(' / ')} rates and advances)`}
                aria-label="Rate up"
                onclick={() => rateUp()}
              ><ThumbsUp size={16} strokeWidth={1.9} aria-hidden="true" /></button>
              <button
                type="button"
                class="selection-action"
                class:active={currentPost.localRating === -1}
                title={`Thumbs down (${getViewerShortcut('rate_down_next').displayKeys.join(' / ')} rates and advances)`}
                aria-label="Rate down"
                onclick={() => rateDown()}
              ><ThumbsDown size={16} strokeWidth={1.9} aria-hidden="true" /></button>
              <button
                type="button"
                class="selection-action"
                title={`Open on Reddit (${getViewerShortcut('open_reddit').displayKeys.join(' / ')})`}
                aria-label="Open Reddit post"
                onclick={() => openReddit()}
              ><ExternalLink size={16} strokeWidth={1.9} aria-hidden="true" /></button>
              <button
                type="button"
                class="selection-action"
                title={`Open media (${getViewerShortcut('open_media').displayKeys.join(' / ')})`}
                aria-label="Open media URL"
                onclick={() => openMedia()}
              ><ImageIcon size={16} strokeWidth={1.9} aria-hidden="true" /></button>
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
	                    preload="auto"
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
	                      preload={getTileVideoPreloadMode(tile.index)}
                      class="wild-card-media"
                      onloadedmetadata={(event) => captureActiveTileVideoTiming(tile.index, event)}
                      ontimeupdate={(event) => captureActiveTileVideoTiming(tile.index, event)}
                      onplay={(event) => captureActiveTileVideoTiming(tile.index, event)}
                      onpause={(event) => captureActiveTileVideoTiming(tile.index, event)}
                      onended={() => captureActiveTileVideoLoop(tile.index)}
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
                uiMode={viewerUiMode}
                showTopBar={false}
                mediaIndex={galleryIndex}
                totalMedia={totalItems}
                postIndex={currentIndex}
                totalPosts={posts.length}
                isSeen={isSeen}
                loadedMedia={loadedMediaStates}
                imageCacheMode={mediaCacheRuntime}
                onadvance={advance}
                onretreat={retreat}
                onadvanceGallery={advanceGallery}
                onretreatGallery={retreatGallery}
                onselectLoadedMedia={selectPost}
                onrateUp={rateUp}
                onrateDown={rateDown}
                onopenReddit={openReddit}
                onopenMedia={openMedia}
                oncontrolenter={engageViewerUi}
                oncontrolleave={releaseViewerUiSoon}
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

	  <nav
	    class="topbar"
	    onpointerenter={engageViewerUi}
    onpointerleave={releaseViewerUiSoon}
	    onfocusin={engageViewerUi}
	    onfocusout={handleViewerSurfaceFocusOut}
	  >
	    <div class="topbar-nav">
	      <details class="topbar-menu topbar-brand-menu">
	        <summary class="logo" aria-label="Viewer menu">SubGlass</summary>
	        <div class="topbar-menu-panel">
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

	          <div class="menu-section">
	            <span class="menu-label">places</span>
	            <div class="nav-links">
	              <a href="/r/all">all</a>
	              <a href="/r/pics">pics</a>
	              <a href="/r/videos">videos</a>
	              <a href="/roulette">roulette</a>
	              <a href="/discover">discover</a>
	              <a href="/admin">admin</a>
	            </div>
	          </div>

	          <div class="menu-section">
	            <span class="menu-label">display</span>
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
	          </div>

	          <div class="menu-section">
	            <span class="menu-label">keys</span>
	            <div class="shortcut-grid" aria-label="Keyboard shortcuts">
	              {#each VIEWER_SHORTCUT_GROUPS as group}
	                <div class="shortcut-group">
	                  <span class="shortcut-group-title">{group.title}</span>
	                  {#each group.shortcuts as shortcut}
	                    <div class="shortcut-row">
	                      <span>{shortcut.description}</span>
	                      <kbd>{shortcut.displayKeys.join(' / ')}</kbd>
	                    </div>
	                  {/each}
	                </div>
	              {/each}
	            </div>
	          </div>

	          <div class="menu-section">
	            <span class="menu-label">ui</span>
	            <div class="ui-switcher" role="radiogroup" aria-label="Viewer UI density">
	              {#each VIEWER_UI_MODES as mode}
	                <button
	                  type="button"
	                  class="ui-chip"
	                  role="radio"
	                  class:active={viewerUiMode === mode.id}
	                  aria-checked={viewerUiMode === mode.id}
	                  title={mode.blurb}
	                  onclick={() => setViewerUiMode(mode.id)}
	                >
	                  {mode.label}
	                </button>
	              {/each}
	            </div>
	          </div>

	          <div class="menu-section">
	            <span class="menu-label">roulette</span>
	            <div class="roulette-settings-grid">
	              <label class="roulette-setting">
	                <span>sort</span>
	                <select
	                  value={rouletteSettings.listingSort}
	                  onchange={(event) => handleRouletteSelectInput('listingSort', event)}
	                >
	                  {#each ROULETTE_LISTING_SORTS as sort}
	                    <option value={sort}>{sort}</option>
	                  {/each}
	                </select>
	              </label>
	              <label class="roulette-setting">
	                <span>time</span>
	                <select
	                  value={rouletteSettings.listingTime}
	                  disabled={!rouletteSortUsesTime}
	                  onchange={(event) => handleRouletteSelectInput('listingTime', event)}
	                >
	                  {#each ROULETTE_LISTING_TIMES as time}
	                    <option value={time}>{time}</option>
	                  {/each}
	                </select>
	              </label>
	              <label class="roulette-setting">
	                <span>subs</span>
	                <input
	                  type="number"
	                  min="1"
	                  max="12"
	                  value={rouletteSettings.subredditCount}
	                  oninput={(event) => handleRouletteNumberInput('subredditCount', event)}
	                />
	              </label>
	              <label class="roulette-setting">
	                <span>images</span>
	                <input
	                  type="number"
	                  min="3"
	                  max="80"
	                  value={rouletteSettings.imagesPerRound}
	                  oninput={(event) => handleRouletteNumberInput('imagesPerRound', event)}
	                />
	              </label>
	              <label class="roulette-setting">
	                <span>liked</span>
	                <input
	                  type="range"
	                  min="0"
	                  max="10"
	                  step="0.5"
	                  value={rouletteSettings.likedWeight}
	                  oninput={(event) => handleRouletteNumberInput('likedWeight', event)}
	                />
	              </label>
	              <label class="roulette-setting">
	                <span>new</span>
	                <input
	                  type="range"
	                  min="0"
	                  max="10"
	                  step="0.5"
	                  value={rouletteSettings.newWeight}
	                  oninput={(event) => handleRouletteNumberInput('newWeight', event)}
	                />
	              </label>
	              <label class="roulette-setting">
	                <span>random</span>
	                <input
	                  type="range"
	                  min="0"
	                  max="10"
	                  step="0.5"
	                  value={rouletteSettings.randomWeight}
	                  oninput={(event) => handleRouletteNumberInput('randomWeight', event)}
	                />
	              </label>
	              <div class="roulette-setting roulette-setting--wide">
	                <span>nsfw</span>
	                <div class="roulette-segmented" role="radiogroup" aria-label="NSFW mode">
	                  {#each (['only', 'yes', 'no'] as const) as mode}
	                    <button
	                      type="button"
	                      role="radio"
	                      class:active={rouletteSettings.nsfwMode === mode}
	                      aria-checked={rouletteSettings.nsfwMode === mode}
	                      onclick={() => updateRouletteSettings({ nsfwMode: mode })}
	                    >
	                      {mode}
	                    </button>
	                  {/each}
	                </div>
	              </div>
	            </div>
	            <div class="roulette-actions">
	              <button type="button" onclick={startNextRouletteRound} disabled={rouletteTransitioning}>
	                {isRouletteMode ? 'Next round' : 'Start'}
	              </button>
	              <a href="/roulette">setup</a>
	            </div>
	            {#if rouletteMessage}
	              <p class="roulette-message">{rouletteMessage}</p>
	            {/if}
	          </div>
	        </div>
	      </details>
	      <span class="route-chip" title={routeSummaryTitle} aria-label={`Current route: ${routeSummary}`}>
	        {routeSummary}
	      </span>
	      {#if isRouletteMode}
	        <span class="roulette-chip">roulette {rouletteRoundProgress}/{rouletteSettings.imagesPerRound}</span>
	      {/if}
	      <ProfileScanStatus class="viewer-profile-scan-status" />
	      {#if routeNotice && (!routeNoticeRouteKey || routeNoticeRouteKey === activeRouteKey)}
	        <span class="route-notice-chip" title={routeNotice}>{routeNotice}</span>
	      {/if}
	    </div>

	    {#if currentPost && currentMedia && !loading && !error}
	      <div
	        class="viewer-status"
	        role="group"
	        aria-label="Viewer queue and auto-next"
	        data-paused={autoAdvanceSuspended}
	        style={`--auto-advance-progress:${autoAdvanceProgress};`}
	      >
	        <span class="status-progress" aria-hidden="true"></span>
	        <span class="status-count counter">{currentIndex + 1} / {posts.length}</span>
	        {#if isRouletteMode}
	          <span class="status-count roulette-counter">round {rouletteRoundProgress}/{rouletteSettings.imagesPerRound}</span>
	        {/if}
	        {#if totalItems > 1}
	          <span class="status-count gallery-counter">img {galleryIndex + 1}/{totalItems}</span>
	        {/if}
	        <span class="status-subreddit">r/{currentPost.subreddit}</span>

	        <details class="status-menu">
	          <summary aria-label={`Loaded queue showing ${loadedMediaStates.length} items, ${mediaReadinessSummary}`}>
	            <span class="status-label">queue</span>
	            <span class="load-rail" aria-hidden="true">
	              {#each loadedMediaStates as item (item.id)}
	                <span
	                  class="load-chip"
	                  class:rating-up={item.rating === 1}
	                  class:rating-down={item.rating === -1}
	                  class:current={item.index === currentIndex}
	                  data-kind={item.kind}
	                  data-status={item.status}
	                  data-cache={item.cacheState}
	                  data-video-preload={item.videoPreloadState}
	                  title={`#${item.index + 1} · ${formatLoadedMediaKind(item.kind)} · ${item.status} · ${formatLoadedMediaCacheState(item.cacheState)} · ${formatLoadedMediaVideoPreloadState(item)} · ${item.title}`}
	                ></span>
	              {/each}
	            </span>
	          </summary>
	          <div class="status-menu-panel">
	            <div class="status-panel-section">
	              <div class="status-panel-heading">
	                <span>queue</span>
	                <span>{mediaReadinessSummary}</span>
	              </div>
	              <div class="status-queue-list" role="list" aria-label="Loaded media queue">
	                {#each loadedMediaStates as item (item.id)}
	                  <button
	                    type="button"
	                    class="status-queue-item"
	                    data-current={item.index === currentIndex}
	                    data-status={item.status}
	                    data-cache={item.cacheState}
	                    data-video-preload={item.videoPreloadState}
	                    aria-current={item.index === currentIndex ? 'true' : undefined}
	                    title={`Jump to ${item.title}`}
	                    onclick={() => selectPost(item.index)}
	                  >
	                    <span class="queue-item-index">{item.index + 1}</span>
	                    <span
	                      class="load-chip"
	                      class:rating-up={item.rating === 1}
	                      class:rating-down={item.rating === -1}
	                      class:current={item.index === currentIndex}
	                      data-kind={item.kind}
	                      data-status={item.status}
	                      data-cache={item.cacheState}
	                      data-video-preload={item.videoPreloadState}
	                    ></span>
	                    <span class="queue-item-copy">
	                      <span class="queue-item-title">{item.title}</span>
	                      <span class="queue-item-meta">
	                        {formatLoadedMediaKind(item.kind)} · {item.status}
	                        {#if item.cacheState !== 'skipped'}
	                          · image {formatLoadedMediaCacheState(item.cacheState)}
	                        {/if}
	                        {#if item.videoPreloadState !== 'skipped'}
	                          · {formatLoadedMediaVideoPreloadState(item)}
	                        {/if}
	                      </span>
	                    </span>
	                  </button>
	                {/each}
	              </div>
	            </div>

	            <div class="status-panel-section status-panel-section--auto">
	              <div class="status-panel-heading">
	                <span>media cache</span>
	                <span>{mediaReadinessSummary}</span>
	              </div>
	              <div class="cache-readiness-grid">
	                <span>images</span>
	                <strong>{loadedMediaCacheSummary}</strong>
	                <span>videos</span>
	                <strong>{videoPreloadSummary}</strong>
	                <span>preloads</span>
	                <strong>{activeVideoPreloadCount}/{videoPreloadTargets.length} active</strong>
	                <span>window</span>
	                <strong>{VIDEO_PRELOAD_BEHIND_POSTS} back / {VIDEO_PRELOAD_AHEAD_POSTS} ahead</strong>
	              </div>
	              <div class="status-panel-heading">
	                <span>auto-next</span>
	                <span>{autoAdvanceSummary}</span>
	              </div>
	              <div class="auto-settings-panel auto-settings-panel--inline">
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
	              </div>
	            </div>
	          </div>
	        </details>

	        <button
	          type="button"
	          class="auto-dock-toggle auto-countdown-button"
	          onclick={toggleAutoAdvance}
	          title={`${autoAdvanceSummary} · Pause or resume auto-next (${getViewerShortcut('toggle_auto_forward').displayKeys.join(' / ')})`}
	          aria-label={`${autoAdvanceSummary}. Pause or resume auto-next.`}
	        >
	          <span class="auto-countdown-readout">
	            {#if autoAdvanceSuspended}
	              paused
	            {:else if currentMedia.kind === 'video' && !currentVideoTiming?.duration}
	              wait
	            {:else}
	              {formatCountdownReadout(autoAdvanceRemainingMs)}
	            {/if}
	          </span>
	          <span class="auto-advance-title">{autoAdvanceSummary}</span>
	        </button>
	      </div>
	    {/if}
	  </nav>

  {#if viewerUiMode === 'hidden'}
    <button
      type="button"
      class="ui-reveal-button"
      aria-label="Show viewer UI"
      title={`Show viewer UI · ${profileScanManager.detailText}`}
      onclick={() => setViewerUiMode('mini')}
    >
      ui
    </button>
  {/if}

	  {#if dev}
    <details
      bind:open={debugExpanded}
      class="debug-dock"
      class:has-error={!!error}
      onpointerenter={engageViewerUi}
      onpointerleave={releaseViewerUiSoon}
      onfocusin={engageViewerUi}
      onfocusout={handleViewerSurfaceFocusOut}
    >
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
    user-select: none;
  }

  .viewer-page input,
  .viewer-page code,
  .viewer-page pre,
  .viewer-page .error,
  .viewer-page .debug-body,
  .viewer-page .selection-card {
    user-select: text;
  }

  .viewer-page button,
  .viewer-page summary,
  .viewer-page .topbar,
  .viewer-page .selection-actions,
  .viewer-page .status-menu-panel {
    user-select: none;
  }

  .viewer-page .topbar input,
  .viewer-page .status-menu-panel input {
    user-select: text;
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
    inset: 10px auto auto 10px;
    z-index: 36;
    display: flex;
    width: fit-content;
    max-width: min(760px, calc(100vw - 20px));
    align-items: center;
    gap: 6px;
    padding: 6px;
    border-radius: 16px;
    background: rgba(8, 11, 15, 0.54);
    border: 1px solid rgba(255, 255, 255, 0.08);
    backdrop-filter: blur(20px) saturate(1.05);
    box-shadow: 0 16px 36px rgba(0, 0, 0, 0.22);
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
    min-height: 28px;
    padding: 5px 9px;
    border-radius: 11px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.06);
    backdrop-filter: blur(10px);
    font-weight: 700;
    font-size: 0.78rem;
    color: rgba(198, 226, 246, 0.88);
    white-space: nowrap;
    transition:
      color 220ms ease,
      background 220ms ease,
      border-color 220ms ease,
      opacity 220ms ease,
      transform 220ms ease;
  }

  .route-chip,
  .roulette-chip,
  .route-notice-chip,
  .topbar-menu summary,
  .ui-reveal-button {
    display: inline-flex;
    min-height: 28px;
    align-items: center;
    justify-content: center;
    border-radius: 11px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    background: rgba(255, 255, 255, 0.045);
    color: rgba(229, 241, 250, 0.86);
    font-size: 0.72rem;
    line-height: 1;
  }

  .route-chip {
    max-width: clamp(130px, 24vw, 320px);
    justify-content: flex-start;
    overflow: hidden;
    padding: 0 9px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .roulette-chip {
    padding: 0 8px;
    color: rgba(166, 231, 194, 0.88);
    background: rgba(94, 179, 128, 0.12);
    border-color: rgba(117, 217, 156, 0.18);
    font-variant-numeric: tabular-nums;
  }

  .route-notice-chip {
    max-width: clamp(120px, 22vw, 300px);
    justify-content: flex-start;
    overflow: hidden;
    padding: 0 8px;
    color: rgba(244, 205, 158, 0.92);
    background: rgba(188, 128, 67, 0.12);
    border-color: rgba(224, 166, 104, 0.22);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .topbar-menu {
    position: static;
  }

  .topbar-menu summary {
    list-style: none;
    padding: 0 9px;
    cursor: pointer;
    transition:
      background 180ms ease,
      border-color 180ms ease,
      color 180ms ease;
  }

  .topbar-menu summary::-webkit-details-marker {
    display: none;
  }

  .topbar-menu[open] summary,
  .topbar-menu summary:hover,
  .topbar-menu summary:focus-visible {
    background: rgba(140, 199, 239, 0.14);
    border-color: rgba(140, 199, 239, 0.24);
    color: #edf6ff;
  }

  .topbar-menu-panel {
    position: absolute;
    top: calc(100% + 8px);
    left: 0;
    width: min(480px, calc(100vw - 20px));
    display: grid;
    gap: 10px;
    padding: 10px;
    border-radius: 16px;
    background: rgba(8, 11, 15, 0.86);
    border: 1px solid rgba(255, 255, 255, 0.08);
    backdrop-filter: blur(22px) saturate(1.08);
    box-shadow: 0 24px 58px rgba(0, 0, 0, 0.36);
  }

  .path-form {
    display: flex;
    gap: 6px;
    width: 100%;
    min-width: 0;
    overflow: visible;
    transition:
      opacity 220ms ease,
      max-width 220ms ease,
      transform 220ms ease,
      filter 220ms ease;
  }

  .path-input {
    min-width: 0;
    background: rgba(6, 9, 13, 0.78);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: #e0e0e0;
    padding: 7px 9px;
    border-radius: 10px;
    font-size: 0.78rem;
    flex: 1;
  }

  .path-form button,
  .display-chip,
  .ui-chip,
  .roulette-actions button,
  .roulette-segmented button,
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
    font-size: 0.76rem;
  }

  .path-form button:hover,
  .display-chip:hover,
  .ui-chip:hover,
  .roulette-actions button:hover,
  .roulette-segmented button:hover,
  .selection-action:hover {
    background: rgba(255, 255, 255, 0.11);
    border-color: rgba(255, 255, 255, 0.12);
    color: #edf6ff;
  }

  .menu-section {
    display: grid;
    gap: 6px;
  }

  .menu-label {
    color: rgba(166, 178, 190, 0.82);
    font-size: 0.62rem;
    letter-spacing: 0.11em;
    text-transform: uppercase;
  }

  .shortcut-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 8px;
  }

  .shortcut-group {
    display: grid;
    gap: 6px;
    min-width: 0;
  }

  .shortcut-group-title {
    color: rgba(166, 178, 190, 0.82);
    font-size: 0.62rem;
    text-transform: uppercase;
  }

  .shortcut-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    color: rgba(215, 224, 232, 0.88);
    font-size: 0.72rem;
  }

  .shortcut-row kbd {
    font: 0.68rem ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    color: #9bd2f6;
    white-space: nowrap;
  }

  .nav-links {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    min-width: 0;
    overflow: visible;
    transition:
      opacity 220ms ease,
      max-width 220ms ease,
      transform 220ms ease,
      filter 220ms ease;
  }

  .nav-links a {
    display: inline-flex;
    align-items: center;
    min-height: 28px;
    padding: 0 9px;
    border-radius: 10px;
    color: #b0b7c4;
    font-size: 0.72rem;
    background: rgba(255, 255, 255, 0.035);
  }

  .nav-links a:hover {
    background: rgba(255, 255, 255, 0.08);
    color: #edf6ff;
  }

  .display-switcher,
  .ui-switcher {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
    min-width: 0;
    overflow: visible;
    transition:
      opacity 220ms ease,
      max-width 220ms ease,
      transform 220ms ease,
      filter 220ms ease;
  }

  .display-chip,
  .ui-chip {
    min-height: 28px;
    padding: 0 9px;
    border-radius: 10px;
    font-size: 0.74rem;
    text-transform: lowercase;
    opacity: 0.74;
  }

  .display-chip.active,
  .ui-chip.active {
    opacity: 1;
    transform: translateY(-1px);
    background: rgba(140, 199, 239, 0.16);
    border-color: rgba(140, 199, 239, 0.24);
    box-shadow: 0 10px 22px rgba(14, 20, 26, 0.14);
  }

  .roulette-settings-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .roulette-setting {
    display: grid;
    grid-template-columns: 62px minmax(0, 1fr);
    gap: 8px;
    align-items: center;
    min-width: 0;
    color: rgba(204, 216, 226, 0.88);
    font-size: 0.72rem;
  }

  .roulette-setting input[type='number'] {
    width: 100%;
    min-width: 0;
    border-radius: 9px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(6, 9, 13, 0.72);
    color: #edf6ff;
    padding: 6px 7px;
    font-size: 0.74rem;
  }

  .roulette-setting select {
    width: 100%;
    min-width: 0;
    border-radius: 9px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(6, 9, 13, 0.72);
    color: #edf6ff;
    padding: 6px 7px;
    font-size: 0.74rem;
  }

  .roulette-setting select:disabled {
    opacity: 0.5;
  }

  .roulette-setting input[type='range'] {
    width: 100%;
  }

  .roulette-setting--wide {
    grid-column: 1 / -1;
  }

  .roulette-segmented {
    display: inline-grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 4px;
    min-width: 0;
  }

  .roulette-segmented button {
    min-width: 0;
    min-height: 28px;
    padding: 0 8px;
    border-radius: 9px;
    font-size: 0.72rem;
  }

  .roulette-segmented button.active {
    opacity: 1;
    background: rgba(112, 207, 150, 0.18);
    border-color: rgba(117, 217, 156, 0.32);
    color: #eefcf2;
  }

  .roulette-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .roulette-actions button {
    min-height: 28px;
    padding: 0 10px;
    border-radius: 10px;
    font-size: 0.74rem;
  }

  .roulette-actions button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .roulette-actions a,
  .roulette-message {
    color: rgba(154, 211, 247, 0.9);
    font-size: 0.72rem;
  }

  .ui-reveal-button {
    position: absolute;
    top: 10px;
    left: 10px;
    z-index: 42;
    width: 34px;
    min-height: 32px;
    padding: 0;
    background: rgba(8, 11, 15, 0.48);
    backdrop-filter: blur(18px) saturate(1.05);
    color: rgba(221, 236, 246, 0.82);
    cursor: pointer;
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.18);
  }

  .ui-reveal-button:hover,
  .ui-reveal-button:focus-visible {
    background: rgba(140, 199, 239, 0.18);
    border-color: rgba(140, 199, 239, 0.28);
    color: #edf6ff;
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

  .debug-dock:not([open]):not(.has-error) {
    width: max-content;
    max-width: calc(100vw - 20px);
  }

  .debug-dock[open],
  .debug-dock.has-error {
    width: min(300px, calc(100vw - 20px));
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

  .selection-meta span {
    background: rgba(9, 12, 16, 0.18);
  }

  .scroll-slide[data-active='true'] .scroll-media {
    outline: 2px solid rgba(140, 199, 239, 0.52);
    outline-offset: 4px;
  }

  .selection-card {
    position: absolute;
    left: 10px;
    top: 48px;
    z-index: 18;
    width: min(380px, calc(100vw - 20px));
    display: grid;
    gap: 5px;
    padding: 9px 10px;
    border-radius: 16px;
    background: rgba(9, 12, 16, 0.16);
    border: 1px solid rgba(255, 255, 255, 0.055);
    backdrop-filter: blur(18px) saturate(0.94);
    box-shadow: 0 12px 26px rgba(0, 0, 0, 0.14);
    transition:
      opacity 220ms ease,
      background 220ms ease,
      border-color 220ms ease,
      box-shadow 220ms ease,
      backdrop-filter 220ms ease,
      transform 220ms ease;
  }

  .selection-card:hover,
  .selection-card:focus-within,
  .selection-actions:hover,
  .selection-actions:focus-within {
    background: rgba(9, 12, 16, 0.32);
    border-color: rgba(255, 255, 255, 0.09);
  }

  .selection-card--masonry {
    background: rgba(9, 11, 16, 0.18);
  }

  .selection-subreddit {
    width: fit-content;
    max-width: 100%;
    padding: 3px 8px;
    border-radius: 999px;
    background: rgba(140, 199, 239, 0.1);
    border: 1px solid rgba(140, 199, 239, 0.13);
    color: rgba(158, 216, 250, 0.94);
    font-size: 0.78rem;
    font-weight: 700;
    line-height: 1.1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    position: absolute;
    left: 10px;
    bottom: 10px;
    z-index: 19;
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
    max-height: none;
    padding: 6px;
    border-radius: 16px;
    background: rgba(9, 12, 16, 0.16);
    border: 1px solid rgba(255, 255, 255, 0.055);
    backdrop-filter: blur(18px) saturate(0.94);
    box-shadow: 0 12px 26px rgba(0, 0, 0, 0.14);
    overflow: hidden;
    transition:
      opacity 220ms ease,
      background 220ms ease,
      border-color 220ms ease,
      box-shadow 220ms ease,
      transform 220ms ease,
      filter 220ms ease;
  }

  .selection-action {
    width: 32px;
    height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border-radius: 10px;
    color: rgba(229, 241, 250, 0.82);
    cursor: pointer;
  }

  .selection-action.active {
    background: rgba(106, 176, 222, 0.18);
    border-color: rgba(106, 176, 222, 0.34);
    color: rgba(182, 224, 252, 0.98);
    box-shadow: none;
  }

  .selection-action:focus-visible {
    outline: 2px solid rgba(106, 176, 222, 0.75);
    outline-offset: 2px;
  }

  .selection-action :global(svg) {
    display: block;
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

  .auto-dock-toggle {
    min-width: 48px;
    min-height: 30px;
    padding: 0 9px;
    border-radius: 11px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.055);
    color: rgba(237, 246, 255, 0.9);
    font-size: 0.74rem;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }

  .auto-dock-toggle:hover,
  .auto-dock-toggle:focus-visible {
    background: rgba(140, 199, 239, 0.16);
    border-color: rgba(140, 199, 239, 0.24);
    color: #edf6ff;
  }

  .auto-advance-title {
    min-width: 0;
    flex: 1;
    font-size: 0.72rem;
  }

  .viewer-page[data-ui-mode='mini'] .topbar {
    max-width: calc(100vw - 20px);
    padding: 5px;
    opacity: 0.88;
  }

  .viewer-page[data-ui-mode='mini'] .route-chip {
    max-width: min(168px, 34vw);
  }

  .viewer-page[data-ui-mode='mini'] .selection-card {
    width: min(300px, calc(100vw - 20px));
    gap: 4px;
    padding: 8px;
    opacity: 0.78;
  }

  .viewer-page[data-ui-mode='mini'] .selection-meta {
    max-height: 0;
    opacity: 0;
    transform: translateY(4px);
  }

  .viewer-page[data-ui-mode='mini'] .selection-card:hover .selection-meta,
  .viewer-page[data-ui-mode='mini'] .selection-card:focus-within .selection-meta {
    max-height: 48px;
    opacity: 1;
    transform: translateY(0);
  }

  .viewer-page[data-ui-mode='mini'] .selection-title {
    font-size: 0.78rem;
    -webkit-line-clamp: 1;
    line-clamp: 1;
    max-height: 24px;
  }

  .viewer-page[data-ui-mode='mini'] .selection-kicker {
    display: none;
  }

  .viewer-page[data-ui-mode='mini'] .selection-card:hover .selection-title,
  .viewer-page[data-ui-mode='mini'] .selection-card:focus-within .selection-title {
    -webkit-line-clamp: 2;
    line-clamp: 2;
    max-height: 48px;
  }

  .viewer-page[data-ui-mode='mini'] .auto-advance-title {
    max-width: 98px;
  }

  .viewer-page[data-ui-mode='hidden'] .topbar,
  .viewer-page[data-ui-mode='hidden'] .selection-card,
  .viewer-page[data-ui-mode='hidden'] .selection-actions,
  .viewer-page[data-ui-mode='hidden'] .debug-dock,
  .viewer-page[data-ui-mode='hidden'] .feed-loading-indicator {
    opacity: 0;
    pointer-events: none;
    transform: translateY(-6px);
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
      max-width: 0;
      opacity: 0;
      overflow: hidden;
      padding-inline: 0;
      border-color: transparent;
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
      top: 74px;
    }

    .selection-actions {
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

    .auto-advance-title {
      white-space: normal;
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
    .auto-dock-toggle {
      transition: none;
    }

    .wild-card {
      animation: none;
    }

    .scroll-feed {
      scroll-behavior: auto;
    }
  }

  .viewer-page[data-ui-mode='hidden'] .debug-dock,
  .viewer-page[data-ui-mode='hidden'] .debug-dock:not([open]):not(.has-error):not(:hover):not(:focus-within) {
    opacity: 0 !important;
    pointer-events: none !important;
    transform: translateY(-6px) !important;
  }

  .viewer-page[data-ui-mode='mini'] .debug-dock:not([open]):not(.has-error) {
    opacity: 0;
    pointer-events: none;
  }

  @media (max-width: 720px) {
    .viewer-page[data-ui-mode='mini'] .topbar {
      inset: 8px auto auto 8px;
      max-width: calc(100vw - 16px);
      gap: 4px;
      padding: 5px;
    }

    .viewer-page[data-ui-mode='mini'] .logo {
      width: 34px;
      padding: 0;
      font-size: 0;
    }

    .viewer-page[data-ui-mode='mini'] .logo::after {
      content: 'SG';
      font-size: 0.76rem;
    }

    .viewer-page[data-ui-mode='mini'] .route-chip {
      max-width: 112px;
    }

    .viewer-page[data-ui-mode='mini'] .topbar-menu summary {
      padding-inline: 8px;
    }

    .viewer-page[data-ui-mode='mini'] .topbar-menu-panel {
      width: min(360px, calc(100vw - 16px));
    }

    .viewer-page[data-ui-mode='mini'] .auto-dock-toggle {
      min-width: 42px;
      padding-inline: 7px;
    }

    .viewer-page[data-ui-mode='mini'] .auto-advance-title {
      max-width: 72px;
    }
  }

  .topbar {
    inset: 0 0 auto 0;
    width: 100%;
    max-width: none;
    align-items: stretch;
    justify-content: space-between;
    gap: 0;
    padding: 0;
    border-width: 0 0 1px;
    border-radius: 0;
    background: rgba(8, 11, 15, 0.62);
  }

  .topbar-nav,
  .viewer-status {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 4px;
    padding: 4px 6px;
  }

  .topbar-nav {
    flex: 1 1 auto;
  }

  .viewer-status {
    --auto-advance-progress: 0;
    position: relative;
    flex: 0 1 auto;
    justify-content: flex-end;
    max-width: min(62vw, 760px);
    border-left: 1px solid rgba(255, 255, 255, 0.07);
    overflow: visible;
  }

  .status-progress {
    position: absolute;
    inset: auto 0 0;
    height: 2px;
    background:
      linear-gradient(
        90deg,
        rgba(164, 209, 238, 0.76) 0% calc(var(--auto-advance-progress) * 100%),
        rgba(255, 255, 255, 0.1) calc(var(--auto-advance-progress) * 100%) 100%
      );
  }

  .status-count,
  .status-subreddit,
  .status-menu summary,
  .status-label,
  .auto-dock-toggle {
    display: inline-flex;
    min-height: 28px;
    align-items: center;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.045);
    border: 1px solid rgba(255, 255, 255, 0.07);
    color: rgba(229, 241, 250, 0.86);
    font-size: 0.72rem;
    line-height: 1;
    white-space: nowrap;
  }

  .status-count,
  .status-subreddit,
  .status-label {
    padding: 0 8px;
  }

  .status-count,
  .auto-countdown-readout {
    font-variant-numeric: tabular-nums;
  }

  .status-subreddit {
    color: rgba(154, 211, 247, 0.92);
  }

  .status-menu {
    position: static;
    flex: 1 1 auto;
    min-width: 0;
  }

  .status-menu summary {
    list-style: none;
    gap: 6px;
    width: 100%;
    min-width: 0;
    padding: 0 8px;
    cursor: pointer;
  }

  .status-menu summary::-webkit-details-marker {
    display: none;
  }

  .status-menu[open] summary,
  .status-menu summary:hover,
  .status-menu summary:focus-visible {
    background: rgba(140, 199, 239, 0.14);
    border-color: rgba(140, 199, 239, 0.24);
    color: #edf6ff;
  }

  .load-rail {
    display: inline-flex;
    align-items: center;
    flex: 1 1 auto;
    gap: 4px;
    min-width: 32px;
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
    transition: transform 0.16s ease, box-shadow 0.16s ease, opacity 0.16s ease;
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

  .load-chip[data-status='queued'] {
    background: rgba(255, 255, 255, 0.16);
  }

  .load-chip[data-status='seen'] {
    background: rgba(255, 255, 255, 0.34);
  }

  .load-chip[data-status='loading'] {
    background: rgba(214, 176, 103, 0.68);
    animation: loading-pulse 1.4s ease-in-out infinite;
  }

  .load-chip[data-status='ready'] {
    background: rgba(106, 176, 222, 0.82);
  }

  .load-chip[data-status='error'] {
    background: rgba(190, 101, 101, 0.82);
  }

  .load-chip[data-cache='cached'] {
    box-shadow: 0 0 0 1px rgba(113, 212, 136, 0.78);
  }

  .load-chip[data-cache='live'],
  .load-chip[data-cache='checking'] {
    opacity: 0.78;
  }

  .load-chip[data-cache='inactive'],
  .load-chip[data-cache='unsupported'],
  .load-chip[data-cache='skipped'] {
    opacity: 0.52;
  }

  .load-chip[data-kind='video']::before {
    content: '';
    position: absolute;
    inset: 2px 2px auto;
    height: 3px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.26);
  }

  .load-chip[data-video-preload='warming']::before,
  .load-chip[data-video-preload='metadata']::before {
    background: rgba(232, 189, 95, 0.86);
  }

  .load-chip[data-video-preload='ready']::before,
  .load-chip[data-video-preload='buffered']::before,
  .load-chip[data-video-preload='visible']::before {
    background: rgba(113, 212, 136, 0.92);
  }

  .load-chip[data-video-preload='error']::before {
    background: rgba(222, 126, 126, 0.92);
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

  .status-menu-panel {
    position: absolute;
    top: 100%;
    right: 0;
    width: min(560px, 100vw);
    display: grid;
    grid-template-columns: minmax(0, 1.45fr) minmax(180px, 0.75fr);
    gap: 10px;
    padding: 10px;
    border-radius: 0 0 0 16px;
    background: rgba(8, 11, 15, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-top: 0;
    backdrop-filter: blur(22px) saturate(1.08);
    box-shadow: 0 24px 58px rgba(0, 0, 0, 0.36);
  }

  .status-panel-section {
    min-width: 0;
    display: grid;
    gap: 8px;
  }

  .status-panel-heading {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    color: rgba(166, 178, 190, 0.86);
    font-size: 0.64rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .status-panel-heading > :last-child {
    min-width: 0;
    overflow: hidden;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-queue-list {
    display: grid;
    gap: 5px;
    max-height: min(48vh, 330px);
    overflow: auto;
    padding-right: 2px;
  }

  .status-queue-item {
    display: grid;
    grid-template-columns: 2.5ch auto minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 7px 8px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    background: rgba(255, 255, 255, 0.04);
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .status-queue-item:hover,
  .status-queue-item:focus-visible,
  .status-queue-item[data-current='true'] {
    background: rgba(106, 176, 222, 0.13);
    border-color: rgba(106, 176, 222, 0.28);
  }

  .status-queue-item[data-video-preload='warming'],
  .status-queue-item[data-video-preload='metadata'] {
    border-color: rgba(232, 189, 95, 0.18);
  }

  .status-queue-item[data-video-preload='ready'],
  .status-queue-item[data-video-preload='buffered'],
  .status-queue-item[data-video-preload='visible'] {
    border-color: rgba(113, 212, 136, 0.22);
  }

  .queue-item-index {
    color: #9fb0be;
    font-size: 0.7rem;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .queue-item-copy {
    min-width: 0;
    display: grid;
    gap: 3px;
  }

  .queue-item-title,
  .queue-item-meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .queue-item-title {
    color: #edf5fc;
    font-size: 0.74rem;
  }

  .queue-item-meta {
    color: #9fb0be;
    font-size: 0.66rem;
  }

  .auto-settings-panel--inline {
    position: static;
    width: auto;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }

  .cache-readiness-grid {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 6px 10px;
    padding: 8px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.06);
    color: #9fb0be;
    font-size: 0.68rem;
  }

  .cache-readiness-grid strong {
    min-width: 0;
    overflow: hidden;
    color: #edf5fc;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .auto-dock-toggle {
    min-width: 54px;
    justify-content: center;
    padding: 0 8px;
  }

  .auto-countdown-button {
    gap: 8px;
    max-width: min(260px, 24vw);
    cursor: pointer;
  }

  .auto-countdown-readout {
    min-width: 42px;
    text-align: center;
  }

  .auto-countdown-button .auto-advance-title {
    display: inline-block;
    min-width: 0;
    max-width: 160px;
    overflow: hidden;
    color: rgba(237, 246, 255, 0.82);
    font-size: 0.72rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .auto-countdown-button:hover,
  .auto-countdown-button:focus-visible {
    background: rgba(140, 199, 239, 0.14);
    border-color: rgba(140, 199, 239, 0.24);
    color: #edf6ff;
  }

  .auto-countdown-button:hover .auto-advance-title,
  .auto-countdown-button:focus-visible .auto-advance-title {
    color: #edf6ff;
  }

  .ui-reveal-button {
    top: 0;
    left: 0;
    border-radius: 0 0 10px 0;
  }

  .debug-dock {
    top: 37px;
    right: 0;
    bottom: auto;
    border-radius: 0 0 0 16px;
  }

  .selection-card {
    left: 0;
    top: 37px;
    border-left: 0;
    border-top: 0;
    border-radius: 0 0 16px 0;
  }

  .selection-actions {
    left: 0;
    bottom: 0;
    border-left: 0;
    border-bottom: 0;
    border-radius: 0 16px 0 0;
  }

  .feed-loading-indicator {
    right: 0;
    bottom: 0;
    border-radius: 16px 0 0 0;
  }

  .viewer-page[data-ui-mode='hidden'] .topbar,
  .viewer-page[data-ui-mode='hidden'] .viewer-status,
  .viewer-page[data-ui-mode='hidden'] .selection-card,
  .viewer-page[data-ui-mode='hidden'] .selection-actions,
  .viewer-page[data-ui-mode='hidden'] .feed-loading-indicator {
    opacity: 0;
    pointer-events: none;
    transform: translateY(-6px);
  }

  .viewer-page[data-ui-mode='mini'] .topbar {
    inset: 0 0 auto 0;
    width: 100%;
    max-width: none;
    padding: 0;
    opacity: 0.92;
  }

  .viewer-page[data-ui-mode='mini'] .viewer-status {
    max-width: min(54vw, 560px);
  }

  .viewer-page[data-ui-mode='mini'] .status-subreddit,
  .viewer-page[data-ui-mode='mini'] .status-label,
  .viewer-page[data-ui-mode='mini'] .auto-advance-title {
    display: none;
  }

  @media (max-width: 760px) {
    .topbar {
      flex-wrap: wrap;
    }

    .topbar-nav,
    .viewer-status {
      flex: 1 1 100%;
      padding: 4px;
    }

    .viewer-status {
      max-width: none;
      justify-content: space-between;
      border-left: 0;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
    }

    .logo {
      width: 34px;
      padding: 0;
      font-size: 0;
    }

    .logo::after {
      content: 'SG';
      font-size: 0.76rem;
    }

    .route-chip {
      max-width: 128px;
    }

    .status-subreddit,
    .status-label,
    .auto-advance-title {
      display: none;
    }

    .status-menu summary {
      max-width: none;
      overflow: hidden;
    }

    .status-menu-panel {
      left: 0;
      right: 0;
      width: auto;
      grid-template-columns: 1fr;
      border-radius: 0 0 14px 14px;
    }

    .debug-dock {
      top: 74px;
    }

    .selection-card {
      top: 74px;
      width: min(280px, calc(100vw - 44px));
      border-radius: 0 0 14px 0;
    }

    .selection-actions {
      left: 0;
      bottom: 0;
      border-radius: 0 14px 0 0;
    }
  }
</style>
