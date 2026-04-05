<script lang="ts">
  import type { PostRecord } from '$lib/types';

  let {
    post,
    mediaIndex = 0,
    totalMedia = 1,
    postIndex = 0,
    totalPosts = 0,
    isSeen = false,
    onadvance,
    onretreat,
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
    onadvance?: () => void;
    onretreat?: () => void;
    onrateUp?: () => void;
    onrateDown?: () => void;
    onopenReddit?: () => void;
    onopenMedia?: () => void;
  } = $props();

  let showInfo = $state(true);
  let hideTimer: ReturnType<typeof setTimeout>;

  $effect(() => {
    // Reset timer whenever post changes
    void post.id;
    showInfo = true;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { showInfo = false; }, 3000);
    return () => clearTimeout(hideTimer);
  });

  function showOverlay() {
    showInfo = true;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { showInfo = false; }, 4000);
  }

  const rating = $derived(post.localRating);
</script>

<div
  class="overlay"
  role="region"
  aria-label="Post controls"
  onmousemove={showOverlay}
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
    <span class="subreddit">r/{post.subreddit}</span>
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
        title="Thumbs up (U)"
        aria-label="Rate up"
      >👍</button>
      <button
        class="btn-icon"
        class:active={rating === -1}
        onclick={() => onrateDown?.()}
        title="Thumbs down (D)"
        aria-label="Rate down"
      >👎</button>
      <button
        class="btn-icon"
        onclick={() => onopenReddit?.()}
        title="Open on Reddit (R)"
        aria-label="Open Reddit post"
      >🔗</button>
      <button
        class="btn-icon"
        onclick={() => onopenMedia?.()}
        title="Open media (O)"
        aria-label="Open media URL"
      >🖼️</button>
    </div>
  </div>

  <!-- Navigation arrows -->
  <button class="nav-btn prev" onclick={() => onretreat?.()} aria-label="Previous" title="Previous (↑/K)">‹</button>
  <button class="nav-btn next" onclick={() => onadvance?.()} aria-label="Next" title="Next (↓/J/Space)">›</button>
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
    padding: 12px 16px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
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
  .counter { font-size: 0.8rem; color: #aaa; }
  .gallery-counter { font-size: 0.8rem; color: #888; }
  .seen-badge {
    font-size: 0.7rem;
    background: rgba(255, 255, 255, 0.15);
    padding: 2px 6px;
    border-radius: 3px;
    color: #aaa;
  }
  .subreddit { font-size: 0.8rem; color: #6ab0de; margin-left: auto; }
  .post-info { width: 100%; }
  .post-title {
    font-size: 0.9rem;
    font-weight: 500;
    color: #e0e0e0;
    line-height: 1.3;
    max-width: 600px;
  }
  .post-meta {
    font-size: 0.75rem;
    color: #888;
    margin-top: 4px;
    display: flex;
    gap: 6px;
  }
  .flair { color: #aaa; }
  .controls { display: flex; gap: 8px; }
  .btn-icon {
    background: rgba(255, 255, 255, 0.1);
    border: none;
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 1rem;
    color: #e0e0e0;
    pointer-events: all;
    transition: background 0.15s;
  }
  .btn-icon:hover { background: rgba(255, 255, 255, 0.2); }
  .btn-icon.active { background: rgba(106, 176, 222, 0.3); }
  .nav-btn {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    background: rgba(255, 255, 255, 0.1);
    border: none;
    color: #e0e0e0;
    font-size: 2rem;
    padding: 12px 8px;
    pointer-events: all;
    border-radius: 4px;
    opacity: 0;
    transition: opacity 0.2s;
  }
  .overlay:hover .nav-btn { opacity: 1; }
  .nav-btn.prev { left: 12px; }
  .nav-btn.next { right: 12px; }
  .nav-btn:hover { background: rgba(255, 255, 255, 0.2); }
</style>
