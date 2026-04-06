<script lang="ts">
  import type { MediaGroup } from '$lib/types';

  let {
    media,
    itemIndex = 0,
    onevent,
  }: {
    media: MediaGroup;
    itemIndex?: number;
    onevent?: (detail: { type: string; mediaId: string; postId: string }) => void;
  } = $props();

  const item = $derived(media.items[itemIndex]);
  let videoEl = $state<HTMLVideoElement | null>(null);
  let imgLoaded = $state(false);
  let imgError = $state(false);

  $effect(() => {
    // Reset on item change
    void itemIndex;
    void media.id;
    imgLoaded = false;
    imgError = false;
  });

  function onVideoPlay() {
    onevent?.({ type: 'video_play', mediaId: media.id, postId: media.postId });
  }

  function onVideoPause() {
    onevent?.({ type: 'video_pause', mediaId: media.id, postId: media.postId });
  }
</script>

<div class="media-viewer">
  {#if media.kind === 'video'}
    {#if item}
      <video
        bind:this={videoEl}
        src={item.url}
        autoplay
        muted
        loop
        controls
        playsinline
        class="media-video"
        onplay={onVideoPlay}
        onpause={onVideoPause}
      >
        {#if item.dashUrl}
          <source src={item.dashUrl} type="application/dash+xml" />
        {/if}
        {#if item.hlsUrl}
          <source src={item.hlsUrl} type="application/x-mpegURL" />
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
          onload={() => (imgLoaded = true)}
          onerror={() => (imgError = true)}
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
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0a0a0a;
  }
  .media-img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    opacity: 0;
    transition: opacity 0.2s;
  }
  .media-img.loaded {
    opacity: 1;
  }
  .media-video {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
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
