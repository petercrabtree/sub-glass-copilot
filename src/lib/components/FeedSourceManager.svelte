<script lang="ts" module>
  import type { SubredditAvailabilityStatus } from '$lib/types';

  export interface FeedSourceRow {
    subreddit: string;
    sourceKey: string;
    sourceLabel: string;
    routePath: string;
    queuedCount: number;
    manual: boolean;
    excluded: boolean;
    muted: boolean;
    unavailableStatus?: SubredditAvailabilityStatus;
    localRating: number;
    lastFetchedAt?: number;
    cooldownUntil?: number;
    lastError?: string;
    fetchCount?: number;
    mediaPostsReturned?: number;
    newPostsReturned?: number;
    duplicatePostsReturned?: number;
    current: boolean;
  }

  export interface FeedSourceSuggestion {
    subreddit: string;
    sourceLabel: string;
    reason: string;
    score: number;
  }
</script>

<script lang="ts">
  import {
    Ban,
    Database,
    Plus,
    RotateCcw,
    Sparkles,
    Trash2,
  } from 'lucide-svelte';

  let {
    rows = [],
    suggestions = [],
    sourceSummary,
    refilling = false,
    actionBusy = '',
    message = '',
    onAddSource,
    onAddSuggestion,
    onRemoveSource,
    onBanSubreddit,
    onRestoreSource,
    onRefillSources,
  }: {
    rows?: FeedSourceRow[];
    suggestions?: FeedSourceSuggestion[];
    sourceSummary: string;
    refilling?: boolean;
    actionBusy?: string;
    message?: string;
    onAddSource?: (source: string) => void | Promise<void>;
    onAddSuggestion?: (suggestion: FeedSourceSuggestion) => void | Promise<void>;
    onRemoveSource?: (row: FeedSourceRow) => void | Promise<void>;
    onBanSubreddit?: (row: FeedSourceRow) => void | Promise<void>;
    onRestoreSource?: (row: FeedSourceRow) => void | Promise<void>;
    onRefillSources?: () => void | Promise<void>;
  } = $props();

  let manualSource = $state('');

  const activeRows = $derived(rows.filter((row) => !isBlocked(row)));
  const blockedRows = $derived(rows.filter(isBlocked));
  const visibleSuggestions = $derived(suggestions.slice(0, 6));
  const busy = $derived(Boolean(actionBusy) || refilling);

  function isBlocked(row: FeedSourceRow): boolean {
    return row.excluded || row.muted || Boolean(row.unavailableStatus);
  }

  function getRowState(row: FeedSourceRow): string {
    if (row.unavailableStatus) return row.unavailableStatus;
    if (row.muted) return 'muted';
    if (row.excluded) return 'removed';
    if (row.manual) return 'manual';
    return row.queuedCount > 0 ? 'queued' : 'known';
  }

  function formatAge(ts: number | undefined): string {
    if (!ts) return 'never';
    const minutes = Math.floor(Math.max(0, Date.now() - ts) / 60000);
    if (minutes < 60) return `${Math.max(1, minutes)}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  }

  function formatYield(row: FeedSourceRow): string {
    const media = row.mediaPostsReturned ?? 0;
    const fresh = row.newPostsReturned ?? 0;
    if (!row.fetchCount) return 'no fetches';
    return `${media} media · ${fresh} new`;
  }

  async function submitManualSource(event: SubmitEvent) {
    event.preventDefault();
    const source = manualSource.trim();
    if (!source || busy) return;
    await onAddSource?.(source);
    manualSource = '';
  }
</script>

<details class="viewer-top-menu source-menu">
  <summary class="source-chip" aria-label={`Feed sources for ${sourceSummary}`}>
    <Database size={13} strokeWidth={2} aria-hidden="true" />
    <span>sources</span>
    <strong>{activeRows.length}</strong>
  </summary>

  <div class="viewer-top-panel source-panel">
    <section class="viewer-menu-section source-section">
      <div class="viewer-menu-label">
        <span>active</span>
        <span>{sourceSummary}</span>
      </div>

      <div class="source-list">
        {#if activeRows.length === 0}
          <p class="source-empty">none</p>
        {:else}
          {#each activeRows as row (row.sourceKey)}
            <article class="source-row" data-state={getRowState(row)} class:current={row.current}>
              <div class="source-main">
                <a href={row.routePath}>r/{row.subreddit}</a>
                <span>{row.manual ? 'manual' : row.queuedCount > 0 ? `${row.queuedCount} queued` : 'known'}</span>
              </div>
              <div class="source-metrics">
                <span>rating {Number(row.localRating.toFixed(2))}</span>
                <span>{formatYield(row)}</span>
                <span>{formatAge(row.lastFetchedAt)} ago</span>
              </div>
              {#if row.lastError}
                <p class="source-error">{row.lastError}</p>
              {/if}
              <div class="source-actions">
                <button
                  type="button"
                  title={`Remove r/${row.subreddit} from this feed`}
                  aria-label={`Remove r/${row.subreddit} from this feed`}
                  disabled={busy}
                  onclick={() => onRemoveSource?.(row)}
                >
                  <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  title={`Ban r/${row.subreddit}`}
                  aria-label={`Ban r/${row.subreddit}`}
                  disabled={busy}
                  onclick={() => onBanSubreddit?.(row)}
                >
                  <Ban size={14} strokeWidth={2} aria-hidden="true" />
                </button>
              </div>
            </article>
          {/each}
        {/if}
      </div>
    </section>

    {#if blockedRows.length > 0}
      <section class="viewer-menu-section source-section">
        <div class="viewer-menu-label">
          <span>removed</span>
          <span>{blockedRows.length}</span>
        </div>
        <div class="source-list source-list--compact">
          {#each blockedRows as row (row.sourceKey)}
            <article class="source-row" data-state={getRowState(row)}>
              <div class="source-main">
                <a href={row.routePath}>r/{row.subreddit}</a>
                <span>{getRowState(row)}</span>
              </div>
              <div class="source-actions">
                <button
                  type="button"
                  title={`Restore r/${row.subreddit}`}
                  aria-label={`Restore r/${row.subreddit}`}
                  disabled={busy}
                  onclick={() => onRestoreSource?.(row)}
                >
                  <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
                </button>
              </div>
            </article>
          {/each}
        </div>
      </section>
    {/if}

    <section class="viewer-menu-section source-section">
      <div class="viewer-menu-label">
        <span>manual</span>
        <span>{refilling ? 'refilling' : 'ready'}</span>
      </div>
      <form class="manual-source-form" onsubmit={submitManualSource}>
        <input
          bind:value={manualSource}
          autocomplete="off"
          spellcheck="false"
          placeholder="r/subreddit"
          aria-label="Subreddit source"
        />
        <button type="submit" disabled={busy || !manualSource.trim()} title="Add source" aria-label="Add source">
          <Plus size={15} strokeWidth={2} aria-hidden="true" />
          <span>add</span>
        </button>
        <button type="button" disabled={busy} title="Refill sources" aria-label="Refill sources" onclick={() => onRefillSources?.()}>
          <Database size={15} strokeWidth={2} aria-hidden="true" />
        </button>
      </form>
      {#if message}
        <p class="source-message">{message}</p>
      {/if}
    </section>

    <section class="viewer-menu-section source-section">
      <div class="viewer-menu-label">
        <span>suggested</span>
        <span>{visibleSuggestions.length}</span>
      </div>
      <div class="suggestion-list">
        {#if visibleSuggestions.length === 0}
          <p class="source-empty">none</p>
        {:else}
          {#each visibleSuggestions as suggestion (suggestion.subreddit)}
            <button
              type="button"
              class="suggestion-row"
              disabled={busy}
              title={suggestion.reason}
              onclick={() => onAddSuggestion?.(suggestion)}
            >
              <Sparkles size={14} strokeWidth={2} aria-hidden="true" />
              <span>r/{suggestion.subreddit}</span>
              <em>{suggestion.reason}</em>
            </button>
          {/each}
        {/if}
      </div>
    </section>
  </div>
</details>

<style>
  :global(.viewer-top-panel.source-panel) {
    width: min(680px, calc(100vw - 12px));
    max-height: calc(100vh - 52px);
    overflow: auto;
  }

  .source-chip {
    gap: 6px;
    padding: 0 8px;
  }

  .source-chip strong {
    color: rgba(154, 211, 247, 0.92);
  }

  .source-section {
    gap: 7px;
  }

  .source-list,
  .suggestion-list {
    display: grid;
    gap: 5px;
  }

  .source-list--compact {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .source-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 6px 8px;
    align-items: center;
    min-width: 0;
    padding: 7px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    background: rgba(255, 255, 255, 0.04);
  }

  .source-row.current {
    border-color: rgba(154, 211, 247, 0.34);
    background: rgba(140, 199, 239, 0.11);
  }

  .source-row[data-state='manual'] {
    border-color: rgba(142, 226, 174, 0.22);
  }

  .source-row[data-state='removed'],
  .source-row[data-state='muted'],
  .source-row[data-state='banned'],
  .source-row[data-state='private'],
  .source-row[data-state='quarantined'],
  .source-row[data-state='not_found'] {
    opacity: 0.72;
  }

  .source-main,
  .source-metrics {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .source-main a {
    min-width: 0;
    overflow: hidden;
    color: #dff2ff;
    font-size: 0.76rem;
    font-weight: 700;
    text-decoration: none;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .source-main span,
  .source-metrics span {
    color: rgba(184, 198, 210, 0.84);
    font-size: 0.66rem;
    white-space: nowrap;
  }

  .source-metrics {
    grid-column: 1 / -1;
    flex-wrap: wrap;
  }

  .source-error,
  .source-message,
  .source-empty {
    margin: 0;
    color: rgba(184, 198, 210, 0.84);
    font-size: 0.7rem;
  }

  .source-error {
    grid-column: 1 / -1;
    color: #f0aaa5;
  }

  .source-message {
    color: #b7d7ea;
  }

  .source-actions {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .source-actions button,
  .manual-source-form button,
  .suggestion-row {
    min-height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.05);
    color: rgba(229, 241, 250, 0.88);
    font: inherit;
  }

  .source-actions button {
    width: 30px;
    padding: 0;
  }

  .source-actions button:hover,
  .source-actions button:focus-visible,
  .manual-source-form button:hover,
  .manual-source-form button:focus-visible,
  .suggestion-row:hover,
  .suggestion-row:focus-visible {
    border-color: rgba(140, 199, 239, 0.28);
    background: rgba(140, 199, 239, 0.13);
    color: #edf6ff;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .manual-source-form {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 6px;
  }

  .manual-source-form input {
    min-width: 0;
    min-height: 30px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(0, 0, 0, 0.2);
    color: #edf5fc;
    font: inherit;
    font-size: 0.74rem;
    padding: 0 9px;
  }

  .manual-source-form button {
    padding: 0 9px;
    font-size: 0.72rem;
  }

  .suggestion-row {
    width: 100%;
    min-width: 0;
    justify-content: flex-start;
    padding: 6px 8px;
    text-align: left;
  }

  .suggestion-row span {
    color: #dff2ff;
    font-size: 0.74rem;
    font-weight: 700;
  }

  .suggestion-row em {
    min-width: 0;
    overflow: hidden;
    color: rgba(184, 198, 210, 0.78);
    font-size: 0.66rem;
    font-style: normal;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 760px) {
    .source-list--compact {
      grid-template-columns: 1fr;
    }

    .source-metrics {
      gap: 5px;
    }
  }
</style>
