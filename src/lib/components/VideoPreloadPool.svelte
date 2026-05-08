<script lang="ts">
  import type { VideoPreloadState, VideoPreloadTarget, VideoPreloadUpdate } from '$lib/media/video-preload';

  let {
    targets = [],
    maxActive = 2,
    onupdate,
  }: {
    targets?: VideoPreloadTarget[];
    maxActive?: number;
    onupdate?: (detail: VideoPreloadUpdate) => void;
  } = $props();

  const activeTargets = $derived(targets.slice(0, Math.max(0, maxActive)));
  const lastStateByKey = new Map<string, string>();

  $effect(() => {
    for (const target of activeTargets) {
      emitUpdate(target, 'queued');
    }
  });

  function getBufferedSeconds(video: HTMLVideoElement | null): number {
    if (!video) return 0;

    let bufferedSeconds = 0;
    for (let index = 0; index < video.buffered.length; index += 1) {
      bufferedSeconds = Math.max(bufferedSeconds, video.buffered.end(index));
    }

    return Math.max(0, bufferedSeconds);
  }

  function getDurationSeconds(video: HTMLVideoElement | null): number | undefined {
    const duration = video?.duration;
    return duration && Number.isFinite(duration) ? Math.max(0, duration) : undefined;
  }

  function emitUpdate(
    target: VideoPreloadTarget,
    state: VideoPreloadState,
    video?: HTMLVideoElement | null,
    error?: string
  ) {
    const bufferedSeconds = getBufferedSeconds(video ?? null);
    const durationSeconds = getDurationSeconds(video ?? null);
    const signature = [
      state,
      Math.floor(bufferedSeconds),
      durationSeconds ? Math.floor(durationSeconds) : '',
      error ?? '',
    ].join(':');

    if (lastStateByKey.get(target.key) === signature) return;
    lastStateByKey.set(target.key, signature);

    onupdate?.({
      ...target,
      state,
      bufferedSeconds,
      durationSeconds,
      error,
      updatedAt: Date.now(),
    });
  }

  function emitProgress(target: VideoPreloadTarget, video: HTMLVideoElement) {
    const bufferedSeconds = getBufferedSeconds(video);
    const durationSeconds = getDurationSeconds(video);
    const hasUsefulBuffer = bufferedSeconds >= 6 ||
      (durationSeconds !== undefined && bufferedSeconds >= Math.max(1, durationSeconds - 0.25));

    emitUpdate(target, hasUsefulBuffer ? 'buffered' : 'warming', video);
  }

  function eventVideo(event: Event): HTMLVideoElement {
    return event.currentTarget as HTMLVideoElement;
  }
</script>

<div class="video-preload-pool" aria-hidden="true">
  {#each activeTargets as target (target.key)}
    <video
      src={target.url}
      muted
      playsinline
      preload="auto"
      tabindex="-1"
      title={target.title}
      onloadstart={(event) => emitUpdate(target, 'warming', eventVideo(event))}
      onloadedmetadata={(event) => emitUpdate(target, 'metadata', eventVideo(event))}
      onloadeddata={(event) => emitUpdate(target, 'ready', eventVideo(event))}
      oncanplay={(event) => emitUpdate(target, 'ready', eventVideo(event))}
      onprogress={(event) => emitProgress(target, eventVideo(event))}
      onerror={(event) => emitUpdate(target, 'error', eventVideo(event), 'video preload failed')}
    ></video>
  {/each}
</div>

<style>
  .video-preload-pool {
    position: fixed;
    width: 1px;
    height: 1px;
    overflow: hidden;
    opacity: 0;
    pointer-events: none;
    visibility: hidden;
  }

  .video-preload-pool video {
    width: 1px;
    height: 1px;
  }
</style>
