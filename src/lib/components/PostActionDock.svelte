<script lang="ts">
  import { ExternalLink, Image as ImageIcon, ThumbsDown, ThumbsUp } from 'lucide-svelte';

  type ViewerUiMode = 'full' | 'mini' | 'hidden';

  let {
    rating,
    visible = true,
    uiMode = 'full',
    votePromptActive = false,
    rateUpShortcut,
    rateDownShortcut,
    redditShortcut,
    mediaShortcut,
    onrateUp,
    onrateDown,
    onopenReddit,
    onopenMedia,
  }: {
    rating?: 1 | -1;
    visible?: boolean;
    uiMode?: ViewerUiMode;
    votePromptActive?: boolean;
    rateUpShortcut: string;
    rateDownShortcut: string;
    redditShortcut: string;
    mediaShortcut: string;
    onrateUp?: () => void;
    onrateDown?: () => void;
    onopenReddit?: () => void;
    onopenMedia?: () => void;
  } = $props();
</script>

<div
  class="action-dock"
  class:visible
  class:vote-prompt={votePromptActive}
  data-ui-mode={uiMode}
>
  <button
    class="btn-icon"
    class:active={rating === 1}
    onclick={() => onrateUp?.()}
    title={`Thumbs up (${rateUpShortcut})`}
    aria-label="Rate up"
  ><ThumbsUp size={16} strokeWidth={1.9} aria-hidden="true" /></button>
  <button
    class="btn-icon"
    class:active={rating === -1}
    onclick={() => onrateDown?.()}
    title={`Thumbs down (${rateDownShortcut})`}
    aria-label="Rate down"
  ><ThumbsDown size={16} strokeWidth={1.9} aria-hidden="true" /></button>
  <button
    class="btn-icon"
    onclick={() => onopenReddit?.()}
    title={`Open on Reddit (${redditShortcut})`}
    aria-label="Open Reddit post"
  ><ExternalLink size={16} strokeWidth={1.9} aria-hidden="true" /></button>
  <button
    class="btn-icon"
    onclick={() => onopenMedia?.()}
    title={`Open media (${mediaShortcut})`}
    aria-label="Open media URL"
  ><ImageIcon size={16} strokeWidth={1.9} aria-hidden="true" /></button>
</div>

<style>
  .action-dock {
    position: absolute;
    z-index: 3;
    left: 0;
    bottom: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 5px;
    padding: 6px;
    border: 1px solid rgba(255, 255, 255, 0.055);
    border-left: 0;
    border-bottom: 0;
    border-radius: 0 16px 0 0;
    background: rgba(8, 11, 15, 0.16);
    backdrop-filter: blur(18px) saturate(0.94);
    box-shadow: 0 12px 26px rgba(0, 0, 0, 0.14);
    opacity: 0;
    pointer-events: none;
    transform: translateY(4px);
    transition:
      opacity 0.22s ease,
      transform 0.22s ease,
      background 0.22s ease,
      border-color 0.22s ease;
  }

  .action-dock.visible {
    opacity: 0.88;
    pointer-events: auto;
    transform: translateY(0);
  }

  .action-dock:hover,
  .action-dock:focus-within {
    opacity: 0.98;
    background: rgba(8, 11, 15, 0.32);
    border-color: rgba(255, 255, 255, 0.09);
  }

  .action-dock[data-ui-mode='mini'] {
    left: 0;
    bottom: 0;
    opacity: 0.82;
  }

  .btn-icon {
    width: 32px;
    height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.045);
    border: 1px solid rgba(255, 255, 255, 0.075);
    padding: 0;
    border-radius: 10px;
    color: rgba(229, 241, 250, 0.82);
    pointer-events: all;
    cursor: pointer;
    transition:
      background 0.15s ease,
      border-color 0.15s ease,
      color 0.15s ease,
      transform 0.15s ease;
  }

  .btn-icon:hover {
    background: rgba(255, 255, 255, 0.105);
    border-color: rgba(255, 255, 255, 0.14);
    color: #edf6ff;
  }

  .btn-icon.active {
    background: rgba(106, 176, 222, 0.18);
    border-color: rgba(106, 176, 222, 0.34);
    color: rgba(182, 224, 252, 0.98);
  }

  .btn-icon:focus-visible {
    outline: 2px solid rgba(106, 176, 222, 0.75);
    outline-offset: 2px;
  }

  .btn-icon :global(svg) {
    display: block;
  }

  .action-dock.vote-prompt {
    border-color: rgba(164, 209, 238, 0.2);
    box-shadow:
      0 12px 26px rgba(0, 0, 0, 0.14),
      0 0 0 1px rgba(164, 209, 238, 0.08);
  }

  .action-dock.vote-prompt .btn-icon:nth-child(-n + 2):not(.active) {
    background: rgba(164, 209, 238, 0.095);
    border-color: rgba(164, 209, 238, 0.18);
    animation: vote-prompt-pulse 1.6s ease-in-out infinite;
  }

  @keyframes vote-prompt-pulse {
    0%, 100% {
      box-shadow: none;
    }
    50% {
      box-shadow: 0 0 0 1px rgba(164, 209, 238, 0.18);
    }
  }

  @media (max-width: 720px) {
    .action-dock,
    .action-dock[data-ui-mode='mini'] {
      left: 0;
      bottom: 0;
      border-radius: 0 14px 0 0;
    }
  }
</style>
