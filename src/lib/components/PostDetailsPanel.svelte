<script lang="ts">
  import type { PostRecord } from '$lib/types';

  type ViewerUiMode = 'full' | 'mini' | 'hidden';

  let {
    post,
    visible = true,
    uiMode = 'full',
    mediaIndex = 0,
    totalMedia = 1,
    postIndex = 0,
    totalPosts = 0,
  }: {
    post: PostRecord;
    visible?: boolean;
    uiMode?: ViewerUiMode;
    mediaIndex?: number;
    totalMedia?: number;
    postIndex?: number;
    totalPosts?: number;
  } = $props();
</script>

<div class="post-details" class:visible data-ui-mode={uiMode}>
  <p class="post-subreddit">r/{post.subreddit}</p>
  <p class="post-title">{post.title}</p>
  <p class="post-meta">
    <span>{postIndex + 1} / {totalPosts}</span>
    {#if totalMedia > 1}
      <span>img {mediaIndex + 1}/{totalMedia}</span>
    {/if}
    <span>by u/{post.author}</span>
    <span>{post.score} pts</span>
    {#if post.flair}<span class="flair">{post.flair}</span>{/if}
  </p>
</div>

<style>
  .post-details {
    position: absolute;
    z-index: 3;
    left: 0;
    top: 37px;
    width: min(390px, calc(100vw - 44px));
    display: grid;
    align-items: start;
    gap: 5px;
    padding: 9px 10px;
    border: 1px solid rgba(255, 255, 255, 0.055);
    border-left: 0;
    border-top: 0;
    border-radius: 0 0 16px 0;
    background: rgba(8, 11, 15, 0.16);
    backdrop-filter: blur(18px) saturate(0.94);
    box-shadow: 0 12px 26px rgba(0, 0, 0, 0.14);
    opacity: 0;
    pointer-events: none;
    transform: translateY(-4px);
    user-select: text;
    transition:
      opacity 0.22s ease,
      transform 0.22s ease,
      background 0.22s ease,
      border-color 0.22s ease;
  }

  .post-details.visible {
    opacity: 0.88;
    pointer-events: auto;
    transform: translateY(0);
  }

  .post-details:hover,
  .post-details:focus-within {
    opacity: 0.98;
    background: rgba(8, 11, 15, 0.32);
    border-color: rgba(255, 255, 255, 0.09);
  }

  .post-subreddit {
    width: fit-content;
    max-width: 100%;
    padding: 3px 8px;
    border-radius: 999px;
    background: rgba(140, 199, 239, 0.1);
    border: 1px solid rgba(140, 199, 239, 0.13);
    color: rgba(158, 216, 250, 0.94);
    font-size: 0.78rem;
    font-weight: 700;
    line-height: 1.1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .post-title {
    max-width: 100%;
    display: -webkit-box;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
    color: #edf6ff;
    font-size: 0.82rem;
    font-weight: 500;
    line-height: 1.3;
  }

  .post-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    color: rgba(172, 186, 199, 0.78);
    font-size: 0.68rem;
    line-height: 1.3;
    transition:
      opacity 0.2s ease,
      max-height 0.2s ease,
      transform 0.2s ease;
  }

  .flair {
    color: #aaa;
  }

  .post-details[data-ui-mode='mini'] {
    left: 0;
    top: 37px;
    width: min(300px, calc(56vw - 4px));
    gap: 4px;
    opacity: 0.78;
  }

  .post-details[data-ui-mode='mini'] .post-title {
    -webkit-line-clamp: 1;
    line-clamp: 1;
  }

  .post-details[data-ui-mode='mini'] .post-meta {
    max-height: 0;
    opacity: 0;
    transform: translateY(4px);
    overflow: hidden;
  }

  .post-details[data-ui-mode='mini']:hover .post-title,
  .post-details[data-ui-mode='mini']:focus-within .post-title {
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  .post-details[data-ui-mode='mini']:hover .post-meta,
  .post-details[data-ui-mode='mini']:focus-within .post-meta {
    max-height: 72px;
    opacity: 1;
    transform: translateY(0);
  }

  @media (max-width: 720px) {
    .post-details,
    .post-details[data-ui-mode='mini'] {
      left: 0;
      top: 74px;
      width: min(280px, calc(100vw - 44px));
      border-radius: 0 0 14px 0;
    }

    .post-details[data-ui-mode='mini'] .post-title {
      font-size: 0.72rem;
    }
  }
</style>
