<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import {
    DEFAULT_ROULETTE_SETTINGS,
    chooseRouletteSubreddits,
    formatRouletteBundle,
    getRouletteCandidateWeight,
    getRouletteCandidates,
    normalizeRouletteSettings,
    persistRouletteSettings,
    readStoredRouletteSettings,
  } from '$lib/discovery/roulette';
  import { profileScanManager } from '$lib/discovery/profile-scan-manager.svelte.js';
  import { getAllSubreddits } from '$lib/db/store';
  import ProfileScanStatus from '$lib/components/ProfileScanStatus.svelte';
  import type { SubredditRecord, SubredditRouletteSettings } from '$lib/types';

  let subreddits = $state<SubredditRecord[]>([]);
  let settings = $state<SubredditRouletteSettings>(DEFAULT_ROULETTE_SETTINGS);
  let selected = $state<SubredditRecord[]>([]);
  let loading = $state(true);
  let message = $state('');
  let scanning = $derived(profileScanManager.active);

  const candidates = $derived(getRouletteCandidates(subreddits, settings));
  const sortedCandidates = $derived(
    [...candidates]
      .sort((a, b) => getRouletteCandidateWeight(b, settings) - getRouletteCandidateWeight(a, settings))
      .slice(0, 40)
  );
  const selectedBundle = $derived(formatRouletteBundle(selected));

  onMount(async () => {
    settings = readStoredRouletteSettings();
    await loadData();
    loading = false;
  });

  async function loadData() {
    subreddits = await getAllSubreddits();
    reroll();
  }

  function updateSettings(nextSettings: Partial<SubredditRouletteSettings>) {
    settings = normalizeRouletteSettings({ ...settings, ...nextSettings });
    persistRouletteSettings(settings);
    reroll();
  }

  function handleNumberInput(
    key: 'subredditCount' | 'imagesPerRound' | 'likedWeight' | 'newWeight' | 'randomWeight',
    event: Event
  ) {
    updateSettings({ [key]: Number((event.currentTarget as HTMLInputElement).value) });
  }

  function reroll() {
    selected = chooseRouletteSubreddits(subreddits, settings, selected.map((sub) => sub.name));
  }

  async function start() {
    if (selected.length === 0) {
      reroll();
    }
    if (selected.length === 0) {
      message = 'No eligible known subreddits yet. Browse or scan first.';
      return;
    }

    await goto(`/r/${selectedBundle}?roulette=1`);
  }

  async function scanNext() {
    message = '';
    try {
      await profileScanManager.scanNext(20);
      await loadData();
      message = profileScanManager.lastMessage || profileScanManager.detailText;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
  }

  function formatWeight(sub: SubredditRecord) {
    return getRouletteCandidateWeight(sub, settings).toFixed(1);
  }
</script>

<div class="roulette-page">
  <nav class="topbar">
    <a href="/r/all" class="logo">SubGlass</a>
    <div class="nav-links">
      <a href="/r/all">viewer</a>
      <a href="/roulette" class="active">roulette</a>
      <a href="/discover">discover</a>
      <a href="/admin">admin</a>
    </div>
  </nav>

  <main>
    <header class="page-header">
      <div>
        <h1>Roulette</h1>
        <p>Weighted random subreddit bundles from the local catalog.</p>
      </div>
      <div class="header-actions">
        <ProfileScanStatus />
        <button type="button" onclick={scanNext} disabled={scanning}>{scanning ? 'Scanning...' : 'Scan next 20'}</button>
        <button type="button" onclick={reroll} disabled={loading || candidates.length === 0}>Reroll</button>
        <button type="button" class="primary" onclick={start} disabled={loading || selected.length === 0}>Start</button>
      </div>
    </header>

    {#if loading}
      <div class="loading">Loading known subreddits...</div>
    {:else}
      <section class="control-band">
        <label>
          <span>subreddits</span>
          <input
            type="number"
            min="1"
            max="12"
            value={settings.subredditCount}
            oninput={(event) => handleNumberInput('subredditCount', event)}
          />
        </label>
        <label>
          <span>images</span>
          <input
            type="number"
            min="3"
            max="80"
            value={settings.imagesPerRound}
            oninput={(event) => handleNumberInput('imagesPerRound', event)}
          />
        </label>
        <label>
          <span>liked</span>
          <input
            type="range"
            min="0"
            max="10"
            step="0.5"
            value={settings.likedWeight}
            oninput={(event) => handleNumberInput('likedWeight', event)}
          />
          <strong>{settings.likedWeight}</strong>
        </label>
        <label>
          <span>new</span>
          <input
            type="range"
            min="0"
            max="10"
            step="0.5"
            value={settings.newWeight}
            oninput={(event) => handleNumberInput('newWeight', event)}
          />
          <strong>{settings.newWeight}</strong>
        </label>
        <label>
          <span>random</span>
          <input
            type="range"
            min="0"
            max="10"
            step="0.5"
            value={settings.randomWeight}
            oninput={(event) => handleNumberInput('randomWeight', event)}
          />
          <strong>{settings.randomWeight}</strong>
        </label>
        <div class="segmented-row">
          <span>nsfw</span>
          <div class="segmented" role="radiogroup" aria-label="NSFW mode">
            {#each (['only', 'yes', 'no'] as const) as mode}
              <button
                type="button"
                role="radio"
                class:active={settings.nsfwMode === mode}
                aria-checked={settings.nsfwMode === mode}
                onclick={() => updateSettings({ nsfwMode: mode })}
              >
                {mode}
              </button>
            {/each}
          </div>
        </div>
      </section>

      {#if message}
        <p class="message">{message}</p>
      {/if}

      <section class="round-panel">
        <div class="section-heading">
          <h2>Next Round</h2>
          <span>{selected.length}/{settings.subredditCount} subs · {settings.imagesPerRound} images</span>
        </div>
        {#if selected.length > 0}
          <div class="bundle-path">/r/{selectedBundle}</div>
          <div class="selected-list">
            {#each selected as sub}
              <a href="/r/{sub.name}" class="selected-sub">
                <span>r/{sub.name}</span>
                <small>{sub.isNsfw === true ? 'nsfw' : sub.isNsfw === false ? 'sfw' : 'unknown'} · rating {sub.localRating} · weight {formatWeight(sub)}</small>
              </a>
            {/each}
          </div>
        {:else}
          <p class="empty">No eligible subreddit candidates yet.</p>
        {/if}
      </section>

      <section>
        <div class="section-heading">
          <h2>Candidate Pool</h2>
          <span>{candidates.length} eligible / {subreddits.length} known</span>
        </div>
        {#if sortedCandidates.length > 0}
          <div class="candidate-table">
            {#each sortedCandidates as sub}
              <div class="candidate-row">
                <a href="/r/{sub.name}">r/{sub.name}</a>
                <span>rating {sub.localRating}</span>
                <span>{sub.isNsfw === true ? 'nsfw' : sub.isNsfw === false ? 'sfw' : 'unknown'}</span>
                <span>{sub.discoveryStatus ?? 'discovered'}</span>
                <span>weight {formatWeight(sub)}</span>
              </div>
            {/each}
          </div>
        {:else}
          <p class="empty">Browse a subreddit or run a discovery scan to seed the catalog.</p>
        {/if}
      </section>
    {/if}
  </main>
</div>

<style>
  .roulette-page { min-height: 100vh; background: #0a0a0a; }
  .topbar {
    display: flex; align-items: center; gap: 12px;
    padding: 8px 16px; background: #111;
    border-bottom: 1px solid #222;
  }
  .logo { font-weight: 700; font-size: 1.1rem; color: #6ab0de; }
  .nav-links { display: flex; gap: 12px; font-size: 0.85rem; }
  .nav-links a { color: #999; }
  .nav-links a:hover, .nav-links a.active { color: #e0e0e0; }
  main { max-width: 1040px; margin: 0 auto; padding: 32px 16px; display: grid; gap: 24px; }
  h1 { font-size: 1.5rem; margin-bottom: 6px; }
  h2 { font-size: 1rem; color: #d0d0d0; }
  p { color: #888; font-size: 0.9rem; }
  button {
    border: 1px solid #2d4050;
    background: #173045;
    color: #e0e0e0;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 0.86rem;
  }
  button.primary { background: #245239; border-color: #37724f; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .page-header,
  .section-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  .header-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .loading,
  .empty,
  .message { color: #888; }
  .control-band {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
    padding: 14px;
    border: 1px solid #222;
    background: #101010;
    border-radius: 8px;
  }
  .control-band label,
  .segmented-row {
    display: grid;
    grid-template-columns: 74px minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
    color: #aaa;
    font-size: 0.82rem;
  }
  .control-band input[type='number'] {
    width: 100%;
    background: #151515;
    border: 1px solid #333;
    color: #e0e0e0;
    border-radius: 5px;
    padding: 7px 8px;
  }
  .control-band input[type='range'] { width: 100%; }
  .control-band strong { color: #c7d7e4; font-size: 0.78rem; min-width: 2ch; }
  .segmented-row { grid-template-columns: 74px minmax(0, 1fr); }
  .segmented {
    display: inline-grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 4px;
    min-width: 0;
  }
  .segmented button {
    min-width: 0;
    padding: 7px 8px;
    background: #151515;
    border-color: #333;
  }
  .segmented button.active {
    background: #245239;
    border-color: #4c8b65;
    color: #f0fff4;
  }
  .round-panel {
    display: grid;
    gap: 12px;
    padding: 16px;
    border: 1px solid #253445;
    background: #0f1417;
    border-radius: 8px;
  }
  .bundle-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #9fcce8;
    background: #0b0f12;
    border: 1px solid #253445;
    border-radius: 6px;
    padding: 8px 10px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.82rem;
  }
  .selected-list,
  .candidate-table {
    display: grid;
    gap: 6px;
  }
  .selected-sub {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 9px 10px;
    border: 1px solid #222;
    background: #111;
    border-radius: 6px;
  }
  .selected-sub small { color: #777; }
  .candidate-row {
    display: grid;
    grid-template-columns: minmax(130px, 1fr) repeat(4, auto);
    gap: 12px;
    align-items: center;
    padding: 7px 8px;
    background: #101010;
    border-radius: 5px;
    color: #888;
    font-size: 0.82rem;
  }
  .section-heading span { color: #777; font-size: 0.82rem; }

  @media (max-width: 700px) {
    .control-band label,
    .segmented-row,
    .candidate-row,
    .selected-sub {
      grid-template-columns: 1fr;
      flex-direction: column;
    }
  }
</style>
