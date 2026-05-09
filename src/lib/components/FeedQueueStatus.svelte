<script lang="ts">
  import { Database, Lock, RefreshCw, RotateCcw, Unlock } from 'lucide-svelte';
  import LoadedMediaRail from '$lib/components/LoadedMediaRail.svelte';
  import type { LoadedMediaChipItem } from '$lib/components/LoadedMediaChip.svelte';
  import type { FeedRunItem } from '$lib/types';

  type LoadedMediaQueueItem = LoadedMediaChipItem & {
    sourceLabel?: string;
    slot?: string;
  };

  let {
    feedStatus,
    queueHealth,
    postsLength,
    currentIndex,
    currentSubreddit,
    locked = false,
    canToggleLock = false,
    canRefreshTail = false,
    loading = false,
    refilling = false,
    refreshingTail = false,
    loadedMedia = [],
    items = [],
    onToggleLock,
    onRefreshTail,
    onRefillNow,
    onReloadRun,
  }: {
    feedStatus: string;
    queueHealth: string;
    postsLength: number;
    currentIndex: number;
    currentSubreddit?: string;
    locked?: boolean;
    canToggleLock?: boolean;
    canRefreshTail?: boolean;
    loading?: boolean;
    refilling?: boolean;
    refreshingTail?: boolean;
    loadedMedia?: LoadedMediaQueueItem[];
    items?: FeedRunItem[];
    onToggleLock?: () => void | Promise<void>;
    onRefreshTail?: () => void | Promise<void>;
    onRefillNow?: () => void | Promise<void>;
    onReloadRun?: () => void | Promise<void>;
  } = $props();

  const visibleLoadedMedia = $derived(
    loadedMedia.slice(Math.max(0, currentIndex - 3), currentIndex + 13)
  );
  const committedCount = $derived(items.filter((item) => item.committed).length);
  const tailCount = $derived(items.filter((item) => !item.committed).length);
  const sourceCount = $derived(new Set(items.map((item) => item.sourceKey).filter(Boolean)).size);
  const activityLabel = $derived(refilling ? 'refilling' : refreshingTail ? 'refreshing' : 'ready');
  const positionLabel = $derived(postsLength > 0 ? `${currentIndex + 1} / ${postsLength}` : feedStatus);

  function formatRailTitle(item: LoadedMediaQueueItem): string {
    return `#${item.index + 1} - ${item.slot ?? 'tail'} - ${item.sourceLabel ?? 'local'} - ${item.title}`;
  }
</script>

<div class="feed-queue-status" role="group" aria-label="Feed queue controls" data-locked={locked}>
  <span class="viewer-top-chip status-count counter">{positionLabel}</span>
  <span class="feed-summary smoke-metadata" aria-hidden="true">{queueHealth}</span>
  {#if currentSubreddit}
    <span class="viewer-top-chip status-subreddit">r/{currentSubreddit}</span>
  {/if}
  <span class="viewer-top-chip status-chip lock-state" data-locked={locked}>
    {#if locked}
      <Lock size={13} strokeWidth={2} aria-hidden="true" />
      locked
    {:else}
      open
    {/if}
  </span>

  <details class="viewer-top-menu status-menu">
    <summary aria-label={`Feed queue: ${queueHealth}`}>
      <span class="status-label">queue</span>
      <LoadedMediaRail
        items={visibleLoadedMedia}
        {currentIndex}
        titleForItem={formatRailTitle}
      />
    </summary>
    <div class="status-menu-panel">
      <section class="status-panel-section">
        <div class="status-panel-heading">
          <span>queue</span>
          <span>{queueHealth}</span>
        </div>
        <div class="queue-facts">
          <span>run</span>
          <strong>{locked ? 'locked' : 'open'}</strong>
          <span>committed</span>
          <strong>{committedCount}</strong>
          <span>tail</span>
          <strong>{tailCount}</strong>
          <span>sources</span>
          <strong>{sourceCount}</strong>
        </div>
      </section>

      <section class="status-panel-section">
        <div class="status-panel-heading">
          <span>feed actions</span>
          <span>{activityLabel}</span>
        </div>
        <div class="feed-action-grid">
          <button type="button" onclick={() => onToggleLock?.()} disabled={!canToggleLock}>
            {#if locked}
              <Unlock size={15} strokeWidth={2} aria-hidden="true" />
              <span>unlock</span>
            {:else}
              <Lock size={15} strokeWidth={2} aria-hidden="true" />
              <span>lock</span>
            {/if}
          </button>
          <button type="button" onclick={() => onRefreshTail?.()} disabled={!canRefreshTail || refreshingTail}>
            <RefreshCw size={15} strokeWidth={2} aria-hidden="true" />
            <span>{refreshingTail ? 'refreshing' : 'refresh tail'}</span>
          </button>
          <button type="button" onclick={() => onRefillNow?.()} disabled={refilling}>
            <Database size={15} strokeWidth={2} aria-hidden="true" />
            <span>{refilling ? 'refilling' : 'refill sources'}</span>
          </button>
          <button type="button" onclick={() => onReloadRun?.()} disabled={loading}>
            <RotateCcw size={15} strokeWidth={2} aria-hidden="true" />
            <span>reload</span>
          </button>
        </div>
      </section>
    </div>
  </details>
</div>

<style>
  .feed-queue-status {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    justify-content: flex-end;
    min-width: 0;
    gap: 4px;
  }

  .smoke-metadata {
    position: fixed;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
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

  .status-subreddit {
    color: rgba(154, 211, 247, 0.92);
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
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(190px, 0.75fr);
    gap: 12px;
    width: min(500px, 100vw);
    padding: 10px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-top: 0;
    border-radius: 0 0 0 16px;
    background: rgba(8, 11, 15, 0.9);
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
    text-transform: uppercase;
  }

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

  .queue-facts strong {
    min-width: 0;
    overflow: hidden;
    color: #edf5fc;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .feed-action-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
  }

  .feed-action-grid button {
    min-height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: flex-start;
    gap: 6px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.05);
    color: #e8f2fa;
    font-size: 0.74rem;
    padding: 0 9px;
    cursor: pointer;
  }

  .feed-action-grid button:disabled {
    cursor: not-allowed;
    opacity: 0.42;
  }

  @media (max-width: 760px) {
    .feed-queue-status {
      width: 100%;
      justify-content: flex-start;
    }

    .status-menu-panel {
      left: 0;
      right: auto;
      width: 100vw;
      grid-template-columns: 1fr;
      border-radius: 0 0 16px 0;
    }

    .status-subreddit {
      display: none;
    }
  }
</style>
