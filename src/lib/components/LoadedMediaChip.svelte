<script lang="ts" module>
  import type { MediaKind } from '$lib/types';
  import type { MediaCacheState } from '$lib/service-worker/media-cache';
  import type { VideoPreloadState } from '$lib/media/video-preload';

  export type LoadedMediaChipStatus = 'queued' | 'seen' | 'loading' | 'ready' | 'error';
  export type LoadedMediaChipVideoState = VideoPreloadState | 'skipped' | 'not-planned' | 'visible';
  export type LoadedMediaChipItem = {
    id: string;
    index: number;
    kind: MediaKind | 'unknown';
    title: string;
    rating?: 1 | -1;
    status: LoadedMediaChipStatus;
    cacheState?: MediaCacheState;
    videoPreloadState?: LoadedMediaChipVideoState;
  };
</script>

<script lang="ts">
  let {
    item,
    currentIndex,
    title,
  }: {
    item: LoadedMediaChipItem;
    currentIndex: number;
    title?: string;
  } = $props();
</script>

<span
  class="load-chip"
  class:rating-up={item.rating === 1}
  class:rating-down={item.rating === -1}
  class:current={item.index === currentIndex}
  data-kind={item.kind}
  data-status={item.status}
  data-cache={item.cacheState}
  data-video-preload={item.videoPreloadState}
  title={title}
></span>

<style>
  .load-chip {
    position: relative;
    display: inline-flex;
    flex: 0 0 auto;
    width: 8px;
    height: 16px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.18);
    overflow: hidden;
    transition:
      transform 0.16s ease,
      box-shadow 0.16s ease,
      opacity 0.16s ease;
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

  @keyframes loading-pulse {
    0%, 100% {
      opacity: 0.6;
    }
    50% {
      opacity: 1;
    }
  }
</style>
