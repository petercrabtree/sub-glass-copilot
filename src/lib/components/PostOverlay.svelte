<script lang="ts">
  import type { MediaKind, PostRecord } from '$lib/types';
  import {
    VIEWER_SHORTCUT_GROUPS,
    formatViewerShortcutKeys,
  } from '$lib/viewer/keyboard';

  type OverlayNavAction = 'retreat' | 'advance' | 'gallery_back' | 'gallery_forward' | 'none';
  type OverlayNavZone = {
    id: string;
    className: string;
    glyph: string;
    action: OverlayNavAction;
    title?: string;
    label: string;
  };

  let {
    post,
    mediaIndex = 0,
    totalMedia = 1,
    postIndex = 0,
    totalPosts = 0,
    isSeen = false,
    loadedMedia = [],
    onadvance,
    onretreat,
    onadvanceGallery,
    onretreatGallery,
    onrateUp,
    onrateDown,
    onopenReddit,
    onopenMedia,
  }: {
    post: PostRecord;
    mediaIndex?: number;
    totalMedia?: number;
    postIndex?: number;
    totalPosts?: number;
    isSeen?: boolean;
    loadedMedia?: Array<{
      id: string;
      index: number;
      kind: MediaKind | 'unknown';
      title: string;
      itemCount: number;
      rating?: 1 | -1;
      status: 'queued' | 'seen' | 'loading' | 'ready' | 'error';
    }>;
    onadvance?: () => void;
    onretreat?: () => void;
    onadvanceGallery?: () => void;
    onretreatGallery?: () => void;
    onrateUp?: () => void;
    onrateDown?: () => void;
    onopenReddit?: () => void;
    onopenMedia?: () => void;
  } = $props();

  let showInfo = $state(true);
  let activeZoneId = $state<string | null>(null);
  let overlayEl = $state<HTMLDivElement | null>(null);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const OVERLAY_HIDE_DELAY_MS = 3000;
  const OVERLAY_HOVER_HIDE_DELAY_MS = 4000;

  function resetHideTimer(delayMs: number) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      showInfo = false;
    }, delayMs);
  }

  $effect(() => {
    // Reset timer whenever post changes
    void post.id;
    showInfo = true;
    activeZoneId = null;
    resetHideTimer(OVERLAY_HIDE_DELAY_MS);
    return () => clearTimeout(hideTimer);
  });

  function showOverlay() {
    showInfo = true;
    resetHideTimer(OVERLAY_HOVER_HIDE_DELAY_MS);
  }

  function hideOverlay() {
    clearTimeout(hideTimer);
    showInfo = false;
    activeZoneId = null;
  }

  const rating = $derived(post.localRating);
  const stepBackShortcut = formatViewerShortcutKeys('step_backward');
  const stepForwardShortcut = formatViewerShortcutKeys('step_forward');
  const skipBackShortcut = formatViewerShortcutKeys('skip_backward');
  const skipForwardShortcut = formatViewerShortcutKeys('skip_forward');
  const redditShortcut = formatViewerShortcutKeys('open_reddit');
  const mediaShortcut = formatViewerShortcutKeys('open_media');
  const rateUpShortcut = formatViewerShortcutKeys('rate_up');
  const rateDownShortcut = formatViewerShortcutKeys('rate_down');
  const canMoveGalleryBack = $derived(totalMedia > 1 && mediaIndex > 0);
  const canMoveGalleryForward = $derived(totalMedia > 1 && mediaIndex < totalMedia - 1);
  const navZones = $derived<OverlayNavZone[]>([
    {
      id: 'top-left',
      className: 'top-left',
      glyph: '↑',
      action: canMoveGalleryBack ? 'gallery_back' : 'retreat',
      label: canMoveGalleryBack ? 'Previous gallery item' : 'Previous post',
      title: canMoveGalleryBack
        ? `Previous gallery item (${stepBackShortcut})`
        : `Previous post (${stepBackShortcut})`,
    },
    {
      id: 'top',
      className: 'top',
      glyph: '↑',
      action: canMoveGalleryBack ? 'gallery_back' : 'none',
      label: 'Previous gallery item',
      title: canMoveGalleryBack ? `Previous gallery item (${stepBackShortcut})` : undefined,
    },
    {
      id: 'top-right',
      className: 'top-right',
      glyph: '↑',
      action: canMoveGalleryBack ? 'gallery_back' : 'retreat',
      label: canMoveGalleryBack ? 'Previous gallery item' : 'Previous post',
      title: canMoveGalleryBack
        ? `Previous gallery item (${stepBackShortcut})`
        : `Previous post (${stepBackShortcut})`,
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
      id: 'bottom-left',
      className: 'bottom-left',
      glyph: '↓',
      action: canMoveGalleryForward ? 'gallery_forward' : 'advance',
      label: canMoveGalleryForward ? 'Next gallery item' : 'Next post',
      title: canMoveGalleryForward
        ? `Next gallery item (${stepForwardShortcut})`
        : `Next post (${stepForwardShortcut})`,
    },
    {
      id: 'bottom',
      className: 'bottom',
      glyph: '↓',
      action: canMoveGalleryForward ? 'gallery_forward' : 'none',
      label: 'Next gallery item',
      title: canMoveGalleryForward ? `Next gallery item (${stepForwardShortcut})` : undefined,
    },
    {
      id: 'bottom-right',
      className: 'bottom-right',
      glyph: '↓',
      action: canMoveGalleryForward ? 'gallery_forward' : 'advance',
      label: canMoveGalleryForward ? 'Next gallery item' : 'Next post',
      title: canMoveGalleryForward
        ? `Next gallery item (${stepForwardShortcut})`
        : `Next post (${stepForwardShortcut})`,
    },
  ]);

  function describeLoadedMedia(item: {
    index: number;
    kind: MediaKind | 'unknown';
    status: 'queued' | 'seen' | 'loading' | 'ready' | 'error';
    itemCount: number;
    rating?: 1 | -1;
    title: string;
  }) {
    const parts = [
      `#${item.index + 1}`,
      item.kind.replaceAll('_', ' '),
      item.status,
    ];

    if (item.itemCount > 1) {
      parts.push(`${item.itemCount} items`);
    }

    if (item.rating === 1) {
      parts.push('rated up');
    } else if (item.rating === -1) {
      parts.push('rated down');
    }

    parts.push(item.title);
    return parts.join(' · ');
  }

  function activateZone(action: OverlayNavAction) {
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

  function handleOverlayMouseMove(event: MouseEvent) {
    const rect = overlayEl?.getBoundingClientRect();
    if (!rect) return;

    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    let closestZoneId: string | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;

    for (const zone of navZones) {
      if (zone.action === 'none') continue;
      const point = getZoneAnchor(zone.id, rect.width, rect.height);
      const distance = Math.hypot(pointerX - point.x, pointerY - point.y);

      if (distance < closestDistance) {
        closestDistance = distance;
        closestZoneId = zone.id;
      }
    }

    const activationRadius = Math.min(rect.width, rect.height) * 0.28;
    const topRevealBand = Math.min(118, rect.height * 0.18);
    const bottomRevealBand = Math.min(138, rect.height * 0.22);
    const revealUi =
      closestDistance <= activationRadius ||
      pointerY <= topRevealBand ||
      pointerY >= rect.height - bottomRevealBand;

    if (!revealUi) {
      hideOverlay();
      return;
    }

    showOverlay();
    activeZoneId = closestDistance <= activationRadius ? closestZoneId : null;
  }

  function handleOverlayMouseLeave() {
    hideOverlay();
  }

  function getZoneAnchor(zoneId: string, width: number, height: number) {
    switch (zoneId) {
      case 'top-left':
        return { x: 0, y: 0 };
      case 'top':
        return { x: width / 2, y: 0 };
      case 'top-right':
        return { x: width, y: 0 };
      case 'left':
        return { x: 0, y: height / 2 };
      case 'right':
        return { x: width, y: height / 2 };
      case 'bottom-left':
        return { x: 0, y: height };
      case 'bottom':
        return { x: width / 2, y: height };
      case 'bottom-right':
        return { x: width, y: height };
      default:
        return { x: width / 2, y: height / 2 };
    }
  }
</script>

<div
  bind:this={overlayEl}
  class="overlay"
  role="region"
  aria-label="Post controls"
  onmousemove={handleOverlayMouseMove}
  onmouseleave={handleOverlayMouseLeave}
>
  <!-- Top bar: counter + seen indicator -->
  <div class="top-bar" class:visible={showInfo}>
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
            aria-label={`Loaded media rail showing ${loadedMedia.length} items`}
          >
            <span class="utility-label">load</span>
            <span class="load-rail" aria-hidden="true">
              {#each loadedMedia as item (item.id)}
                <span
                  class="load-chip"
                  class:rating-up={item.rating === 1}
                  class:rating-down={item.rating === -1}
                  data-kind={item.kind}
                  data-status={item.status}
                  title={describeLoadedMedia(item)}
                ></span>
              {/each}
            </span>
          </button>
          <div class="hover-panel legend-panel">
            <p class="panel-title">Loaded Media</p>
            <p class="panel-copy">Queue overview for the media currently loaded into this feed.</p>
            <div class="legend-grid">
              <span class="legend-swatch" data-status="queued"></span>
              <span class="legend-text">Queued</span>
              <span class="legend-swatch" data-status="seen"></span>
              <span class="legend-text">Seen</span>
              <span class="legend-swatch" data-status="loading"></span>
              <span class="legend-text">Current loading</span>
              <span class="legend-swatch" data-status="ready"></span>
              <span class="legend-text">Current ready</span>
              <span class="legend-swatch" data-status="error"></span>
              <span class="legend-text">Current error</span>
              <span class="legend-swatch rating-up" data-status="queued"></span>
              <span class="legend-text">Rated up</span>
              <span class="legend-swatch rating-down" data-status="queued"></span>
              <span class="legend-text">Rated down</span>
            </div>
            <p class="panel-copy muted">Hover a chip for the post number, media type, and title.</p>
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

  <!-- Bottom info bar -->
  <div class="bottom-bar" class:visible={showInfo}>
    <div class="post-info">
      <p class="post-title">{post.title}</p>
      <p class="post-meta">
        <span>by u/{post.author}</span>
        <span>· {post.score} pts</span>
        {#if post.flair}<span class="flair">· {post.flair}</span>{/if}
      </p>
    </div>
    <div class="controls">
      <button
        class="btn-icon"
        class:active={rating === 1}
        onclick={() => onrateUp?.()}
        title={`Thumbs up (${rateUpShortcut})`}
        aria-label="Rate up"
      >👍</button>
      <button
        class="btn-icon"
        class:active={rating === -1}
        onclick={() => onrateDown?.()}
        title={`Thumbs down (${rateDownShortcut})`}
        aria-label="Rate down"
      >👎</button>
      <button
        class="btn-icon"
        onclick={() => onopenReddit?.()}
        title={`Open on Reddit (${redditShortcut})`}
        aria-label="Open Reddit post"
      >🔗</button>
      <button
        class="btn-icon"
        onclick={() => onopenMedia?.()}
        title={`Open media (${mediaShortcut})`}
        aria-label="Open media URL"
      >🖼️</button>
    </div>
  </div>

  <div class="nav-grid" role="group" aria-label="Overlay navigation">
    {#each navZones as zone (zone.id)}
      <button
        type="button"
        class={`nav-zone ${zone.className}`}
        data-action={zone.action}
        data-active={zone.id === activeZoneId}
        disabled={zone.action === 'none'}
        aria-label={zone.label}
        title={zone.title}
        onclick={() => activateZone(zone.action)}
        onfocus={() => {
          showOverlay();
          activeZoneId = zone.id;
        }}
        onblur={() => {
          activeZoneId = null;
        }}
      >
        <span class="zone-glyph" aria-hidden="true">{zone.glyph}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
  .top-bar,
  .bottom-bar {
    pointer-events: all;
    opacity: 0;
    transition: opacity 0.3s;
    padding: 8px 10px;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    position: relative;
    z-index: 3;
  }
  .top-bar {
    background: linear-gradient(to bottom, rgba(0, 0, 0, 0.7), transparent);
  }
  .bottom-bar {
    background: linear-gradient(to top, rgba(0, 0, 0, 0.8), transparent);
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .top-bar.visible,
  .bottom-bar.visible {
    opacity: 1;
  }
  .counter { font-size: 0.7rem; color: #aaa; }
  .gallery-counter { font-size: 0.7rem; color: #888; }
  .top-bar-spacer {
    flex: 1;
    min-width: 0;
  }
  .seen-badge {
    font-size: 0.62rem;
    background: rgba(255, 255, 255, 0.15);
    padding: 2px 6px;
    border-radius: 3px;
    color: #aaa;
  }
  .subreddit { font-size: 0.72rem; color: #6ab0de; }
  .utility-cluster {
    display: flex;
    align-items: center;
    gap: 8px;
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
    padding: 4px 7px;
    cursor: help;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(12, 12, 12, 0.42);
    backdrop-filter: blur(12px);
    color: inherit;
  }
  .load-cluster:focus-visible,
  .help-chip:focus-visible,
  .nav-zone:focus-visible,
  .btn-icon:focus-visible {
    outline: 2px solid rgba(106, 176, 222, 0.75);
    outline-offset: 2px;
  }
  .utility-label {
    font-size: 0.62rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #9d9d9d;
  }
  .load-rail {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .load-chip,
  .legend-swatch {
    position: relative;
    display: inline-flex;
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
  .load-chip[data-status='queued'],
  .legend-swatch[data-status='queued'] {
    background: rgba(255, 255, 255, 0.16);
  }
  .load-chip[data-status='seen'],
  .legend-swatch[data-status='seen'] {
    background: rgba(255, 255, 255, 0.34);
  }
  .load-chip[data-status='loading'],
  .legend-swatch[data-status='loading'] {
    background: rgba(214, 176, 103, 0.68);
  }
  .load-chip[data-status='loading'] {
    animation: loading-pulse 1.4s ease-in-out infinite;
  }
  .load-chip[data-status='ready'],
  .legend-swatch[data-status='ready'] {
    background: rgba(106, 176, 222, 0.82);
  }
  .load-chip[data-status='error'],
  .legend-swatch[data-status='error'] {
    background: rgba(190, 101, 101, 0.82);
  }
  .load-chip::after,
  .legend-swatch::after {
    content: '';
    position: absolute;
    inset: auto 0 0;
    height: 3px;
    background: transparent;
  }
  .load-chip.rating-up::after,
  .legend-swatch.rating-up::after {
    background: #71d488;
  }
  .load-chip.rating-down::after,
  .legend-swatch.rating-down::after {
    background: #de7e7e;
  }
  .hover-panel {
    position: absolute;
    top: calc(100% + 10px);
    right: 0;
    min-width: 240px;
    max-width: min(92vw, 360px);
    padding: 12px 14px;
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(14, 14, 14, 0.94);
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
  .legend-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px 10px;
    align-items: center;
    margin-top: 12px;
  }
  .legend-text {
    font-size: 0.74rem;
    color: #d7d7d7;
  }
  .shortcuts-panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
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
  .post-info { width: 100%; }
  .post-title {
    font-size: 0.78rem;
    font-weight: 500;
    color: #e0e0e0;
    line-height: 1.3;
    max-width: 520px;
  }
  .post-meta {
    font-size: 0.68rem;
    color: #888;
    margin-top: 4px;
    display: flex;
    gap: 6px;
  }
  .flair { color: #aaa; }
  .controls { display: flex; gap: 6px; }
  .btn-icon {
    background: rgba(255, 255, 255, 0.1);
    border: none;
    padding: 5px 8px;
    border-radius: 6px;
    font-size: 0.92rem;
    color: #e0e0e0;
    pointer-events: all;
    transition: background 0.15s;
  }
  .btn-icon:hover { background: rgba(255, 255, 255, 0.2); }
  .btn-icon.active { background: rgba(106, 176, 222, 0.3); }
  .nav-grid {
    position: absolute;
    inset: 0;
    display: grid;
    grid-template-columns: minmax(108px, 24vw) 1fr minmax(108px, 24vw);
    grid-template-rows: minmax(84px, 18vh) 1fr minmax(84px, 18vh);
    grid-template-areas:
      'top-left top top-right'
      'left . right'
      'bottom-left bottom bottom-right';
    z-index: 1;
  }
  .nav-zone {
    display: flex;
    border: none;
    background: transparent;
    pointer-events: all;
    color: inherit;
    padding: 16px;
    position: relative;
  }
  .nav-zone:disabled {
    pointer-events: none;
  }
  .nav-zone::before {
    content: '';
    position: absolute;
    inset: 0;
    opacity: 0;
    transition: opacity 0.18s ease;
  }
  .nav-zone.top-left { grid-area: top-left; justify-content: flex-start; align-items: flex-start; }
  .nav-zone.top {
    grid-area: top;
    justify-content: center;
    align-items: flex-start;
  }
  .nav-zone.top-right { grid-area: top-right; justify-content: flex-end; align-items: flex-start; }
  .nav-zone.left {
    grid-area: left;
    justify-content: flex-start;
    align-items: center;
  }
  .nav-zone.right {
    grid-area: right;
    justify-content: flex-end;
    align-items: center;
  }
  .nav-zone.bottom-left {
    grid-area: bottom-left;
    justify-content: flex-start;
    align-items: flex-end;
  }
  .nav-zone.bottom {
    grid-area: bottom;
    justify-content: center;
    align-items: flex-end;
  }
  .nav-zone.bottom-right {
    grid-area: bottom-right;
    justify-content: flex-end;
    align-items: flex-end;
  }
  .nav-zone.top-left::before {
    background: radial-gradient(circle at top left, rgba(255, 255, 255, 0.045), transparent 60%);
  }
  .nav-zone.top::before {
    background: linear-gradient(to bottom, rgba(255, 255, 255, 0.035), transparent 70%);
  }
  .nav-zone.top-right::before {
    background: radial-gradient(circle at top right, rgba(255, 255, 255, 0.045), transparent 60%);
  }
  .nav-zone.left::before {
    background: linear-gradient(to right, rgba(255, 255, 255, 0.035), transparent 70%);
  }
  .nav-zone.right::before {
    background: linear-gradient(to left, rgba(255, 255, 255, 0.035), transparent 70%);
  }
  .nav-zone.bottom-left::before {
    background: radial-gradient(circle at bottom left, rgba(255, 255, 255, 0.045), transparent 60%);
  }
  .nav-zone.bottom::before {
    background: linear-gradient(to top, rgba(255, 255, 255, 0.035), transparent 70%);
  }
  .nav-zone.bottom-right::before {
    background: radial-gradient(circle at bottom right, rgba(255, 255, 255, 0.045), transparent 60%);
  }
  .nav-zone[data-active='true']::before,
  .nav-zone:hover::before,
  .nav-zone:focus-visible::before {
    opacity: 0.56;
  }
  .zone-glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    min-height: 28px;
    color: rgba(233, 233, 233, 0.2);
    font-size: 1.2rem;
    line-height: 1;
    transition: color 0.18s ease, transform 0.18s ease, text-shadow 0.18s ease;
    text-shadow: 0 0 8px rgba(0, 0, 0, 0.18);
  }
  .nav-zone[data-active='true'] .zone-glyph,
  .nav-zone:not(:disabled):hover .zone-glyph,
  .nav-zone:not(:disabled):focus-visible .zone-glyph {
    color: rgba(233, 233, 233, 0.58);
    transform: scale(1.03);
    text-shadow: 0 0 14px rgba(255, 255, 255, 0.08);
  }
  .nav-zone:disabled .zone-glyph {
    color: rgba(233, 233, 233, 0.08);
  }

  @keyframes loading-pulse {
    0%, 100% {
      opacity: 0.6;
    }
    50% {
      opacity: 1;
    }
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
    .nav-grid {
      grid-template-columns: minmax(76px, 26vw) 1fr minmax(76px, 26vw);
      grid-template-rows: minmax(64px, 15vh) 1fr minmax(64px, 15vh);
    }
    .nav-zone {
      padding: 12px;
    }
    .hover-panel {
      right: auto;
      left: 0;
    }
    .shortcut-row {
      flex-direction: column;
      gap: 4px;
    }
  }
</style>
