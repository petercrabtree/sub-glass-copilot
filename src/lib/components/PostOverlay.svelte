<script lang="ts">
  import { CircleHelp } from 'lucide-svelte';
  import LoadedMediaChip from '$lib/components/LoadedMediaChip.svelte';
  import LoadedMediaRail from '$lib/components/LoadedMediaRail.svelte';
  import PostActionDock from '$lib/components/PostActionDock.svelte';
  import PostDetailsPanel from '$lib/components/PostDetailsPanel.svelte';
  import ViewerNavGutters, {
    type ViewerNavAction,
    type ViewerNavZone,
  } from '$lib/components/ViewerNavGutters.svelte';
  import type { MediaKind, PostRecord } from '$lib/types';
  import type { MediaCacheRuntimeState, MediaCacheState } from '$lib/service-worker/media-cache';
  import type { VideoPreloadState } from '$lib/media/video-preload';
  import {
    VIEWER_SHORTCUT_GROUPS,
    formatViewerShortcutKeys,
  } from '$lib/viewer/keyboard';

  type ViewerUiMode = 'full' | 'mini' | 'hidden';
  type LoadedVideoPreloadState = VideoPreloadState | 'skipped' | 'not-planned' | 'visible';
  type LoadedMediaItem = {
    id: string;
    index: number;
    kind: MediaKind | 'unknown';
    title: string;
    itemCount: number;
    rating?: 1 | -1;
    status: 'queued' | 'seen' | 'loading' | 'ready' | 'error';
    previewUrl?: string;
    cacheUrl?: string;
    cacheState: MediaCacheState;
    videoPreloadState: LoadedVideoPreloadState;
    videoPreloadBufferedSeconds?: number;
    videoPreloadDurationSeconds?: number;
    videoPreloadError?: string;
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

  let {
    post,
    chromeVisible = true,
    showTopBar = true,
    uiMode = 'full',
    mediaIndex = 0,
    totalMedia = 1,
    postIndex = 0,
    totalPosts = 0,
    isSeen = false,
    imageCacheMode = 'inactive',
    loadedMedia = [],
    whyPost,
    votePromptActive = false,
    onadvance,
    onretreat,
    onadvanceGallery,
    onretreatGallery,
    onselectLoadedMedia,
    onrateUp,
    onrateDown,
    onopenReddit,
    onopenMedia,
    oncontrolenter,
    oncontrolleave,
  }: {
    post: PostRecord;
    chromeVisible?: boolean;
    showTopBar?: boolean;
    uiMode?: ViewerUiMode;
    mediaIndex?: number;
    totalMedia?: number;
    postIndex?: number;
    totalPosts?: number;
    isSeen?: boolean;
    imageCacheMode?: MediaCacheRuntimeState;
    loadedMedia?: LoadedMediaItem[];
    whyPost?: WhyPostInfo;
    votePromptActive?: boolean;
    onadvance?: () => void;
    onretreat?: () => void;
    onadvanceGallery?: () => void;
    onretreatGallery?: () => void;
    onselectLoadedMedia?: (index: number) => void;
    onrateUp?: () => void;
    onrateDown?: () => void;
    onopenReddit?: () => void;
    onopenMedia?: () => void;
    oncontrolenter?: () => void;
    oncontrolleave?: () => void;
  } = $props();

  let previewedLoadItemId = $state<string | null>(null);
  let overlayEl = $state<HTMLDivElement | null>(null);

  $effect(() => {
    void post.id;
    previewedLoadItemId = null;
  });

  const rating = $derived(post.localRating);
  const stepBackShortcut = formatViewerShortcutKeys('step_backward');
  const stepForwardShortcut = formatViewerShortcutKeys('step_forward');
  const skipBackShortcut = formatViewerShortcutKeys('skip_backward');
  const skipForwardShortcut = formatViewerShortcutKeys('skip_forward');
  const redditShortcut = formatViewerShortcutKeys('open_reddit');
  const mediaShortcut = formatViewerShortcutKeys('open_media');
  const rateUpShortcut = formatViewerShortcutKeys('rate_up_next');
  const rateDownShortcut = formatViewerShortcutKeys('rate_down_next');
  const canMoveGalleryBack = $derived(totalMedia > 1 && mediaIndex > 0);
  const canMoveGalleryForward = $derived(totalMedia > 1 && mediaIndex < totalMedia - 1);
  const cacheableLoadedMediaCount = $derived(
    loadedMedia.filter((item) => item.cacheState !== 'skipped').length
  );
  const cachedLoadedMediaCount = $derived(
    loadedMedia.filter((item) => item.cacheState === 'cached').length
  );
  const controlsVisible = $derived(chromeVisible && uiMode !== 'hidden');
  const navZones = $derived<ViewerNavZone[]>([
    {
      id: 'top',
      className: 'top',
      glyph: '↑',
      action: canMoveGalleryBack ? 'gallery_back' : 'none',
      label: 'Previous gallery item',
      title: canMoveGalleryBack
        ? `Previous gallery item (${stepBackShortcut})`
        : undefined,
    },
    {
      id: 'left',
      className: 'left',
      glyph: '←',
      action: 'retreat',
      label: 'Previous post',
      title: `Previous post (${skipBackShortcut})`,
    },
    {
      id: 'right',
      className: 'right',
      glyph: '→',
      action: 'advance',
      label: 'Next post',
      title: `Next post (${skipForwardShortcut})`,
    },
    {
      id: 'bottom',
      className: 'bottom',
      glyph: '↓',
      action: canMoveGalleryForward ? 'gallery_forward' : 'none',
      label: 'Next gallery item',
      title: canMoveGalleryForward ? `Next gallery item (${stepForwardShortcut})` : undefined,
    },
  ]);

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
    LoadedMediaItem,
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

  function describeLoadedMedia(item: LoadedMediaItem) {
    const parts = [
      `#${item.index + 1}`,
      formatLoadedMediaKind(item.kind),
      item.status,
    ];

    const cacheStateLabel = formatLoadedMediaCacheState(item.cacheState);
    if (cacheStateLabel !== 'n/a') {
      parts.push(cacheStateLabel);
    }

    const videoPreloadStateLabel = formatLoadedMediaVideoPreloadState(item);
    if (videoPreloadStateLabel !== 'n/a') {
      parts.push(videoPreloadStateLabel);
    }

    if (item.itemCount > 1) {
      parts.push(`${item.itemCount} items`);
    }

    if (item.slot) {
      parts.push(item.slot);
    }

    if (item.score !== undefined) {
      parts.push(`score ${item.score.toFixed(1)}`);
    }

    if (item.sourceLabel) {
      parts.push(item.sourceLabel);
    }

    if (item.reason) {
      parts.push(item.reason);
    }

    if (item.rating === 1) {
      parts.push('rated up');
    } else if (item.rating === -1) {
      parts.push('rated down');
    }

    parts.push(item.title);
    return parts.join(' · ');
  }

  function describeLoadedMediaCacheMode() {
    switch (imageCacheMode) {
      case 'ready':
        return cacheableLoadedMediaCount > 0
          ? `${cachedLoadedMediaCount}/${cacheableLoadedMediaCount} cached`
          : 'cache ready';
      case 'inactive':
        return 'cache inactive';
      case 'unsupported':
        return 'cache unsupported';
    }
  }

  function previewLoadedMediaItem(itemId: string | null) {
    previewedLoadItemId = itemId;
  }

  function activateZone(action: ViewerNavAction) {
    switch (action) {
      case 'retreat':
        onretreat?.();
        break;
      case 'advance':
        onadvance?.();
        break;
      case 'gallery_back':
        onretreatGallery?.();
        break;
      case 'gallery_forward':
        onadvanceGallery?.();
        break;
    }
  }

  function handleOverlayPointerEnter() {
    oncontrolenter?.();
  }

  function handleOverlayPointerLeave() {
    oncontrolleave?.();
  }

  function handleOverlayFocusIn() {
    oncontrolenter?.();
  }

  function handleOverlayFocusOut(event: FocusEvent) {
    if (event.relatedTarget instanceof Node && overlayEl?.contains(event.relatedTarget)) return;
    oncontrolleave?.();
  }
</script>

<div
  bind:this={overlayEl}
  class="overlay"
  data-ui-mode={uiMode}
  role="region"
  aria-label="Post controls"
  onpointerenter={handleOverlayPointerEnter}
  onpointerleave={handleOverlayPointerLeave}
  onfocusin={handleOverlayFocusIn}
  onfocusout={handleOverlayFocusOut}
>
  {#if showTopBar}
    <!-- Top bar: counter + seen indicator -->
    <div class="top-bar" class:visible={chromeVisible && uiMode !== 'hidden'}>
      <span class="counter">{postIndex + 1} / {totalPosts}</span>
      {#if totalMedia > 1}
        <span class="gallery-counter">img {mediaIndex + 1}/{totalMedia}</span>
      {/if}
      {#if isSeen}
        <span class="seen-badge">seen</span>
      {/if}
      <div class="top-bar-spacer"></div>
      <span class="subreddit">r/{post.subreddit}</span>
      <div class="utility-cluster">
        {#if loadedMedia.length > 0}
          <div class="hover-card-anchor">
            <button
              type="button"
              class="load-cluster"
              aria-label={`Loaded queue showing ${loadedMedia.length} items, ${describeLoadedMediaCacheMode()}`}
            >
              <span class="utility-label">queue</span>
              <span class="load-summary">{loadedMedia.length}</span>
              <span class="cache-summary" data-cache-mode={imageCacheMode}>
                {describeLoadedMediaCacheMode()}
              </span>
              <LoadedMediaRail
                items={loadedMedia}
                currentIndex={postIndex}
                titleForItem={describeLoadedMedia}
              />
            </button>
            <div class="hover-panel queue-panel">
              <div class="queue-panel-header">
                <div class="queue-panel-copy">
                  <p class="panel-title">Loaded Queue</p>
                  <p class="panel-copy">
                    Jump to any loaded post and hover a row to peek at its preview image.
                  </p>
                </div>
                <div class="queue-panel-summary">
                  <span class="summary-pill">{loadedMedia.length} loaded</span>
                  <span class="summary-pill" data-cache-mode={imageCacheMode}>
                    {describeLoadedMediaCacheMode()}
                  </span>
                </div>
              </div>
              {#if imageCacheMode === 'inactive'}
                <p class="panel-copy muted">
                  The image cache becomes inspectable once the service worker controls this page. If it still shows inactive, use the admin cache tools to register or refresh the worker.
                </p>
              {:else if imageCacheMode === 'unsupported'}
                <p class="panel-copy muted">
                  This browser does not expose Cache Storage inspection here.
                </p>
              {/if}
              <div class="queue-list" role="list" aria-label="Loaded media queue">
                {#each loadedMedia as item (item.id)}
                  <div class="queue-item-shell" role="listitem">
                    <button
                      type="button"
                      class="queue-item"
                      data-current={item.index === postIndex}
                      data-status={item.status}
                      data-cache={item.cacheState}
                      data-video-preload={item.videoPreloadState}
                      aria-current={item.index === postIndex ? 'true' : undefined}
                      aria-label={`Jump to ${describeLoadedMedia(item)}`}
                      title={`Jump to ${describeLoadedMedia(item)}`}
                      onclick={() => onselectLoadedMedia?.(item.index)}
                      onmouseenter={() => previewLoadedMediaItem(item.id)}
                      onmouseleave={() => previewLoadedMediaItem(null)}
                      onfocus={() => previewLoadedMediaItem(item.id)}
                      onblur={() => previewLoadedMediaItem(null)}
                    >
                      <span class="queue-item-leading">
                        <LoadedMediaChip item={item} currentIndex={postIndex} />
                        <span class="queue-index">{item.index + 1}</span>
                      </span>
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
                          {#if item.itemCount > 1}
                            · {item.itemCount} items
                          {/if}
                          {#if item.slot}
                            · {item.slot}
                          {/if}
                          {#if item.score !== undefined}
                            · score {item.score.toFixed(1)}
                          {/if}
                          {#if item.sourceLabel}
                            · {item.sourceLabel}
                          {/if}
                          {#if item.reason}
                            · {item.reason}
                          {/if}
                          {#if item.rating === 1}
                            · rated up
                          {:else if item.rating === -1}
                            · rated down
                          {/if}
                        </span>
                      </span>
                      <span class="queue-item-badges">
                        {#if item.index === postIndex}
                          <span class="queue-badge current">now</span>
                        {/if}
                        <span class="queue-badge cache" data-cache={item.cacheState}>
                          {formatLoadedMediaCacheState(item.cacheState)}
                        </span>
                        {#if item.videoPreloadState !== 'skipped'}
                          <span class="queue-badge video" data-video-preload={item.videoPreloadState}>
                            {formatLoadedMediaVideoPreloadState(item)}
                          </span>
                        {/if}
                        {#if item.slot}
                          <span class="queue-badge slot">{item.slot}</span>
                        {/if}
                        {#if item.score !== undefined}
                          <span class="queue-badge score">{item.score.toFixed(1)}</span>
                        {/if}
                      </span>
                      {#if previewedLoadItemId === item.id && item.previewUrl}
                        <span class="queue-preview-popover">
                          <img
                            src={item.previewUrl}
                            alt={`Preview for ${item.title}`}
                            class="queue-preview-image"
                            loading="lazy"
                          />
                        </span>
                      {/if}
                    </button>
                  </div>
                {/each}
              </div>
            </div>
          </div>
        {/if}
        {#if whyPost}
          <div class="hover-card-anchor">
            <button
              type="button"
              class="help-chip why-chip"
              aria-label={`Why this post: ${whyPost.summary}`}
              title="Why this post?"
            >
              <CircleHelp size={14} strokeWidth={1.9} aria-hidden="true" />
              <span class="utility-label">why</span>
            </button>
            <div class="hover-panel why-panel">
              <p class="panel-title">Why This Post</p>
              <p class="panel-copy">{whyPost.summary}</p>
              <div class="why-list" role="list">
                {#each whyPost.details as detail}
                  <div class="why-row" data-tone={detail.tone ?? 'neutral'} role="listitem">
                    <span>{detail.label}</span>
                    <strong>{detail.value}</strong>
                  </div>
                {/each}
              </div>
            </div>
          </div>
        {/if}
        <div class="hover-card-anchor">
          <button type="button" class="help-chip" aria-label="Keyboard shortcuts">
            <span class="utility-label">keys</span>
          </button>
          <div class="hover-panel shortcuts-panel">
            <p class="panel-title">Keyboard</p>
            {#each VIEWER_SHORTCUT_GROUPS as group}
              <div class="shortcut-group">
                <p class="shortcut-group-title">{group.title}</p>
                {#each group.shortcuts as shortcut}
                  <div class="shortcut-row">
                    <span class="shortcut-copy">{shortcut.description}</span>
                    <span class="shortcut-keys">{shortcut.displayKeys.join(' / ')}</span>
                  </div>
                {/each}
              </div>
            {/each}
          </div>
        </div>
      </div>
    </div>
  {/if}

  <PostDetailsPanel
    {post}
    visible={controlsVisible}
    {uiMode}
    {mediaIndex}
    {totalMedia}
    {postIndex}
    {totalPosts}
  />

  <PostActionDock
    {rating}
    visible={controlsVisible}
    {uiMode}
    {votePromptActive}
    {rateUpShortcut}
    {rateDownShortcut}
    {redditShortcut}
    {mediaShortcut}
    {onrateUp}
    {onrateDown}
    {onopenReddit}
    {onopenMedia}
  />

  <ViewerNavGutters
    zones={navZones}
    {uiMode}
    onactivate={activateZone}
    {oncontrolenter}
  />
</div>

<style>
  .overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    user-select: none;
  }

  .top-bar {
    pointer-events: none;
    opacity: 0;
    transition:
      opacity 0.22s ease,
      transform 0.22s ease,
      background 0.22s ease,
      border-color 0.22s ease;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    position: absolute;
    z-index: 3;
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.055);
    background: rgba(8, 11, 15, 0.16);
    backdrop-filter: blur(18px) saturate(0.94);
    box-shadow: 0 12px 26px rgba(0, 0, 0, 0.14);
  }

  .top-bar {
    top: 10px;
    right: 10px;
    max-width: min(520px, calc(100vw - 20px));
    padding: 6px;
    transform: translateY(-4px);
  }

  .top-bar.visible {
    opacity: 0.88;
    pointer-events: auto;
    transform: translateY(0);
  }

  .top-bar:hover,
  .top-bar:focus-within {
    opacity: 0.98;
    background: rgba(8, 11, 15, 0.32);
    border-color: rgba(255, 255, 255, 0.09);
  }

  .counter,
  .gallery-counter {
    min-height: 24px;
    display: inline-flex;
    align-items: center;
    padding: 0 8px;
    border-radius: 9px;
    background: rgba(255, 255, 255, 0.045);
    color: #c7d1dc;
    font-size: 0.68rem;
    font-variant-numeric: tabular-nums;
  }

  .top-bar-spacer {
    flex: 1;
    min-width: 0;
  }

  .seen-badge {
    font-size: 0.62rem;
    background: rgba(255, 255, 255, 0.08);
    padding: 4px 7px;
    border-radius: 9px;
    color: #bcc6d1;
  }

  .subreddit {
    min-height: 24px;
    display: inline-flex;
    align-items: center;
    padding: 0 8px;
    border-radius: 9px;
    background: rgba(140, 199, 239, 0.1);
    font-size: 0.7rem;
    color: #9bd2f6;
  }

  .utility-cluster {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .hover-card-anchor {
    position: relative;
    pointer-events: all;
  }
  .load-cluster,
  .help-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 24px;
    padding: 0 7px;
    border-radius: 9px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.045);
    backdrop-filter: blur(12px);
    color: inherit;
  }
  .load-cluster {
    cursor: pointer;
  }
  .help-chip {
    cursor: help;
  }
  .load-cluster:focus-visible,
  .help-chip:focus-visible {
    outline: 2px solid rgba(106, 176, 222, 0.75);
    outline-offset: 2px;
  }
  .utility-label {
    font-size: 0.62rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #9d9d9d;
  }
  .load-summary,
  .cache-summary {
    font-size: 0.66rem;
    color: #d3dbe2;
    font-variant-numeric: tabular-nums;
  }
  .cache-summary {
    color: #93b8d4;
  }
  .cache-summary[data-cache-mode='inactive'],
  .cache-summary[data-cache-mode='unsupported'] {
    color: #9d9d9d;
  }
  .hover-panel {
    position: absolute;
    top: calc(100% + 10px);
    right: 0;
    min-width: 240px;
    max-width: min(92vw, 360px);
    padding: 12px 14px;
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(8, 11, 15, 0.92);
    backdrop-filter: blur(20px) saturate(1.05);
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35);
    opacity: 0;
    transform: translateY(-6px);
    pointer-events: none;
    transition: opacity 0.18s, transform 0.18s;
  }
  .hover-card-anchor:hover .hover-panel,
  .hover-card-anchor:focus-within .hover-panel,
  .hover-card-anchor:focus .hover-panel {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
  }
  .panel-title,
  .shortcut-group-title {
    margin: 0;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #9a9a9a;
  }
  .panel-copy {
    margin: 8px 0 0;
    font-size: 0.74rem;
    color: #cbcbcb;
    line-height: 1.35;
  }
  .panel-copy.muted {
    color: #9f9f9f;
  }
  .queue-panel {
    min-width: min(92vw, 420px);
    max-width: min(92vw, 460px);
    overflow: visible;
  }
  .queue-panel-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }
  .queue-panel-copy {
    min-width: 0;
  }
  .queue-panel-summary {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
  }
  .summary-pill,
  .queue-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 0.68rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.05);
    color: #d5dde5;
    white-space: nowrap;
  }
  .summary-pill[data-cache-mode='ready'] {
    color: #a7daf8;
  }
  .summary-pill[data-cache-mode='inactive'],
  .summary-pill[data-cache-mode='unsupported'] {
    color: #a3acb5;
  }
  .queue-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 12px;
    max-height: min(56vh, 360px);
    overflow-y: auto;
    padding-right: 4px;
  }
  .queue-item {
    width: 100%;
    position: relative;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.04);
    color: inherit;
    text-align: left;
    cursor: pointer;
    transition: background 0.16s ease, border-color 0.16s ease, transform 0.16s ease;
  }
  .queue-item:hover,
  .queue-item:focus-visible {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(106, 176, 222, 0.28);
    transform: translateY(-1px);
  }
  .queue-item:focus-visible {
    outline: 2px solid rgba(106, 176, 222, 0.75);
    outline-offset: 2px;
  }
  .queue-item[data-current='true'] {
    background: rgba(106, 176, 222, 0.14);
    border-color: rgba(106, 176, 222, 0.34);
  }
  .queue-item-leading {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .queue-index {
    min-width: 2ch;
    font-size: 0.72rem;
    color: #9fb0be;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .queue-item-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .queue-item-title,
  .queue-item-meta {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .queue-item-title {
    font-size: 0.78rem;
    color: #edf5fc;
  }
  .queue-item-meta {
    font-size: 0.68rem;
    color: #9fb0be;
  }
  .queue-item-badges {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    justify-self: end;
  }
  .queue-badge.current {
    background: rgba(163, 226, 255, 0.92);
    border-color: rgba(163, 226, 255, 0.92);
    color: #051018;
  }
  .queue-badge.cache[data-cache='cached'] {
    color: #8ce0a0;
  }
  .queue-badge.cache[data-cache='live'] {
    color: #cbd5df;
  }
  .queue-badge.cache[data-cache='checking'] {
    color: #e0c489;
  }
  .queue-badge.cache[data-cache='inactive'],
  .queue-badge.cache[data-cache='unsupported'],
  .queue-badge.cache[data-cache='skipped'] {
    color: #9da6ae;
  }
  .queue-badge.video[data-video-preload='warming'],
  .queue-badge.video[data-video-preload='metadata'] {
    color: #e0c489;
  }
  .queue-badge.video[data-video-preload='ready'],
  .queue-badge.video[data-video-preload='buffered'],
  .queue-badge.video[data-video-preload='visible'] {
    color: #8ce0a0;
  }
  .queue-badge.video[data-video-preload='queued'],
  .queue-badge.video[data-video-preload='not-planned'] {
    color: #cbd5df;
  }
  .queue-badge.video[data-video-preload='error'] {
    color: #de7e7e;
  }
  .queue-badge.slot,
  .queue-badge.score {
    color: #c5d4e0;
  }
  .queue-preview-popover {
    position: absolute;
    top: 50%;
    right: calc(100% + 14px);
    width: 156px;
    aspect-ratio: 4 / 5;
    transform: translateY(-50%);
    padding: 6px;
    border-radius: 14px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(11, 13, 16, 0.96);
    box-shadow: 0 18px 42px rgba(0, 0, 0, 0.34);
    pointer-events: none;
  }
  .queue-preview-image {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: 10px;
  }
  .shortcuts-panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .why-chip {
    min-width: 28px;
  }
  .why-chip :global(svg) {
    display: block;
    color: rgba(160, 205, 236, 0.9);
  }
  .why-panel {
    width: min(92vw, 380px);
  }
  .why-list {
    display: grid;
    gap: 7px;
    margin-top: 12px;
  }
  .why-row {
    display: grid;
    grid-template-columns: 88px minmax(0, 1fr);
    gap: 10px;
    align-items: start;
    padding: 7px 8px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.055);
  }
  .why-row span {
    color: #9fb0be;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.07em;
  }
  .why-row strong {
    min-width: 0;
    color: #e4eef7;
    font-size: 0.74rem;
    font-weight: 500;
    line-height: 1.3;
    word-break: break-word;
  }
  .why-row[data-tone='positive'] strong {
    color: #8ce0a0;
  }
  .why-row[data-tone='negative'] strong {
    color: #de7e7e;
  }
  .why-row[data-tone='warning'] strong {
    color: #e0c489;
  }
  .why-row[data-tone='muted'] strong {
    color: #aab4bd;
  }
  .shortcut-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .shortcut-row {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    font-size: 0.76rem;
    color: #d7d7d7;
  }
  .shortcut-copy {
    color: #d2d2d2;
  }
  .shortcut-keys {
    color: #90c4e4;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    white-space: nowrap;
  }
  .overlay[data-ui-mode='mini'] .top-bar {
    max-width: min(360px, calc(100vw - 20px));
    opacity: 0.76;
  }

  .overlay[data-ui-mode='mini'] .utility-label,
  .overlay[data-ui-mode='mini'] .cache-summary {
    display: none;
  }

  .overlay[data-ui-mode='hidden'] .top-bar {
    opacity: 0;
    pointer-events: none;
  }

  @media (max-width: 720px) {
    .utility-cluster {
      width: 100%;
      justify-content: space-between;
    }
    .top-bar-spacer {
      display: none;
    }
    .subreddit {
      margin-right: auto;
    }
    .hover-panel {
      right: auto;
      left: 0;
    }
    .queue-panel {
      min-width: min(88vw, 360px);
    }
    .queue-panel-header {
      flex-direction: column;
    }
    .queue-panel-summary {
      justify-content: flex-start;
    }
    .queue-item {
      grid-template-columns: auto minmax(0, 1fr);
    }
    .queue-item-badges {
      grid-column: 2;
      justify-self: start;
      flex-wrap: wrap;
    }
    .queue-preview-popover {
      display: none;
    }
    .shortcut-row {
      flex-direction: column;
      gap: 4px;
    }

    .overlay[data-ui-mode='mini'] .top-bar {
      top: 62px;
      right: 8px;
      max-width: min(168px, calc(100vw - 16px));
      padding: 5px;
      gap: 4px;
    }

    .overlay[data-ui-mode='mini'] .top-bar-spacer,
    .overlay[data-ui-mode='mini'] .subreddit,
    .overlay[data-ui-mode='mini'] .help-chip,
    .overlay[data-ui-mode='mini'] .cache-summary,
    .overlay[data-ui-mode='mini'] .utility-label {
      display: none;
    }

    .overlay[data-ui-mode='mini'] .utility-cluster {
      width: auto;
      justify-content: flex-start;
      gap: 4px;
    }

    .overlay[data-ui-mode='mini'] .load-cluster {
      max-width: 74px;
      overflow: hidden;
    }

    .overlay[data-ui-mode='mini'] :global(.load-rail .load-chip:nth-child(n + 5)) {
      display: none;
    }

    .overlay[data-ui-mode='hidden'] .top-bar {
      display: none;
    }
  }

  .top-bar {
    display: none !important;
  }
</style>
