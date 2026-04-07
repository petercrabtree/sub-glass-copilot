<script lang="ts">
  import type { MediaGroup } from '$lib/types';

  let {
    media,
    itemIndex = 0,
    fit = 'cover',
    ambient = false,
    onevent,
    onstatechange,
    ontimingchange,
  }: {
    media: MediaGroup;
    itemIndex?: number;
    fit?: 'contain' | 'cover';
    ambient?: boolean;
    onevent?: (detail: { type: string; mediaId: string; postId: string }) => void;
    onstatechange?: (detail: {
      state: 'loading' | 'ready' | 'error';
      mediaId: string;
      postId: string;
      itemIndex: number;
    }) => void;
    ontimingchange?: (detail: {
      currentTime: number;
      duration: number;
      paused: boolean;
    }) => void;
  } = $props();

  const item = $derived(media.items[itemIndex]);
  const backdropUrl = $derived(
    media.kind === 'video'
      ? media.thumbnailUrl
      : item?.url
  );
  let videoEl = $state<HTMLVideoElement | null>(null);
  let imgLoaded = $state(false);
  let imgError = $state(false);
  let embedError = $state(false);
  let lastResetKey = '';

  $effect(() => {
    const resetKey = `${media.id}:${itemIndex}`;
    if (resetKey === lastResetKey) return;
    lastResetKey = resetKey;

    // Reset on item change
    void itemIndex;
    void media.id;
    imgLoaded = false;
    imgError = false;
    embedError = false;
    emitTimingChange(0, 0, true);

    if (!item) {
      emitStateChange('error');
      return;
    }

    emitStateChange(
      media.kind === 'image' ||
      media.kind === 'external_image' ||
      media.kind === 'external_video' ||
      media.kind === 'gallery' ||
      media.kind === 'video'
        ? 'loading'
        : 'error'
    );
  });

  function onVideoPlay() {
    onevent?.({ type: 'video_play', mediaId: media.id, postId: media.postId });
  }

  function onVideoPause() {
    onevent?.({ type: 'video_pause', mediaId: media.id, postId: media.postId });
  }

  function emitStateChange(state: 'loading' | 'ready' | 'error') {
    onstatechange?.({ state, mediaId: media.id, postId: media.postId, itemIndex });
  }

  function emitTimingChange(currentTime: number, duration: number, paused: boolean) {
    ontimingchange?.({ currentTime, duration, paused });
  }
</script>

<div class="media-viewer" data-ambient={ambient} style={`--media-fit:${fit};`}>
  {#if ambient && backdropUrl}
    <img
      src={backdropUrl}
      alt=""
      class="media-backdrop"
      aria-hidden="true"
    />
    <div class="media-backdrop-veil" aria-hidden="true"></div>
  {/if}

  {#if media.kind === 'external_video'}
    {#if item?.embedUrl && !embedError}
      <iframe
        src={item.embedUrl}
        title="Embedded external video"
        class="media-embed-frame"
        allow="autoplay; fullscreen; picture-in-picture"
        allowfullscreen
        referrerpolicy="strict-origin-when-cross-origin"
        scrolling="no"
        onload={() => emitStateChange('ready')}
        onerror={() => {
          embedError = true;
          emitStateChange('error');
        }}
      ></iframe>
    {:else if item}
      <div class="media-error">
        <p>Embedded video unavailable</p>
        <a href={item.openUrl ?? item.url} target="_blank" rel="noreferrer">Open source</a>
      </div>
    {/if}
  {:else if media.kind === 'video'}
    {#if item}
      <video
        bind:this={videoEl}
        autoplay
        muted
        loop
        controls
        playsinline
        class="media-video"
        onplay={onVideoPlay}
        onpause={onVideoPause}
        onloadedmetadata={() => {
          emitTimingChange(videoEl?.currentTime ?? 0, videoEl?.duration ?? 0, videoEl?.paused ?? false);
        }}
        onloadeddata={() => emitStateChange('ready')}
        ontimeupdate={() => {
          emitTimingChange(videoEl?.currentTime ?? 0, videoEl?.duration ?? 0, videoEl?.paused ?? false);
        }}
        onerror={() => emitStateChange('error')}
      >
        {#if item.url}
          <source src={item.url} type={item.mimeType} />
        {/if}
        {#if item.dashUrl}
          <source src={item.dashUrl} type="application/dash+xml" />
        {/if}
        {#if item.hlsUrl}
          <source src={item.hlsUrl} type="application/vnd.apple.mpegurl" />
        {/if}
      </video>
    {/if}
  {:else if media.kind === 'image' || media.kind === 'external_image' || media.kind === 'gallery'}
    {#if item}
      {#if !imgError}
        <img
          src={item.url}
          alt="Post media"
          class="media-img"
          class:loaded={imgLoaded}
          onload={() => {
            imgLoaded = true;
            emitStateChange('ready');
          }}
          onerror={() => {
            imgError = true;
            emitStateChange('error');
          }}
        />
      {:else}
        <div class="media-error">
          <p>Media failed to load</p>
          <a href={item.url} target="_blank" rel="noreferrer">Open URL</a>
        </div>
      {/if}
    {/if}
  {:else}
    <div class="media-unknown">
      <p>Media preview not available</p>
    </div>
  {/if}
</div>

<style>
  .media-viewer {
    position: relative;
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0a0a0a;
    overflow: hidden;
  }
  .media-backdrop,
  .media-backdrop-veil {
    position: absolute;
    inset: -6%;
    pointer-events: none;
  }
  .media-backdrop {
    width: calc(100% + 12%);
    height: calc(100% + 12%);
    object-fit: cover;
    filter: blur(26px) saturate(1.2);
    opacity: 0.58;
    transform: scale(1.04);
  }
  .media-backdrop-veil {
    inset: 0;
    background:
      radial-gradient(circle at center, rgba(255, 255, 255, 0.05), transparent 36%),
      linear-gradient(180deg, rgba(4, 6, 10, 0.24) 0%, rgba(4, 6, 10, 0.62) 100%);
  }
  .media-img {
    position: relative;
    z-index: 1;
    width: 100%;
    height: 100%;
    object-fit: contain;
    opacity: 1;
    transition: opacity 0.2s;
  }
  .media-img.loaded {
    opacity: 1;
  }
  .media-video {
    position: relative;
    z-index: 1;
    width: 100%;
    height: 100%;
    object-fit: var(--media-fit, contain);
  }
  .media-embed-frame {
    position: relative;
    z-index: 1;
    width: 100%;
    height: 100%;
    border: 0;
    background: #050505;
  }
  .media-img {
    object-fit: var(--media-fit, contain);
  }
  .media-error,
  .media-unknown {
    color: #666;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
  }
  .media-error a {
    color: #6ab0de;
    font-size: 0.85rem;
  }
</style>
