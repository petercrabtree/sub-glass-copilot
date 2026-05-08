import type { FeedRecipe, FeedRunItem, PostRecord } from '$lib/types';
import type { FeedCandidate } from '$lib/feed/scoring';

export interface MixFeedQueueOptions {
  recipe: FeedRecipe;
  runId: string;
  existingItems?: FeedRunItem[];
  existingPosts?: PostRecord[];
  currentIndex?: number;
  refreshTail?: boolean;
  now?: number;
}

function createRunItem(
  runId: string,
  position: number,
  candidate: FeedCandidate,
  committed: boolean,
  now: number
): FeedRunItem {
  return {
    id: `${runId}:${position}:${candidate.post.id}`,
    runId,
    position,
    postId: candidate.post.id,
    subreddit: candidate.post.subreddit,
    slot: candidate.slot,
    score: Number(candidate.score.toFixed(3)),
    scoreDetails: candidate.scoreDetails,
    sourceKey: candidate.source?.sourceKey,
    sourceLabel: candidate.source?.sourceLabel,
    committed,
    addedAt: now,
  };
}

function violatesSubredditWindow(
  selected: Array<Pick<FeedRunItem, 'subreddit'>>,
  subreddit: string,
  windowSize: number,
  maxPerWindow: number
): boolean {
  const window = selected.slice(-windowSize);
  return window.filter((item) => item.subreddit === subreddit).length >= maxPerWindow;
}

function pickNextCandidate(
  candidates: FeedCandidate[],
  selected: FeedRunItem[],
  recipe: FeedRecipe
): FeedCandidate | undefined {
  const windowSize = 10;
  const firstAllowed = candidates.find((candidate) =>
    !violatesSubredditWindow(
      selected,
      candidate.post.subreddit,
      windowSize,
      recipe.maxPerSubredditWindow
    )
  );

  return firstAllowed ?? candidates[0];
}

export function mixFeedQueue(candidates: FeedCandidate[], options: MixFeedQueueOptions): FeedRunItem[] {
  const now = options.now ?? Date.now();
  const currentIndex = options.currentIndex ?? 0;
  const committedUntil = currentIndex + options.recipe.committedAheadCount;
  const existingItems = options.existingItems ?? [];
  const preservedItems = options.refreshTail
    ? existingItems.filter((item) => item.position <= committedUntil)
    : existingItems;
  const selectedPostIds = new Set(preservedItems.map((item) => item.postId));
  const selected: FeedRunItem[] = preservedItems
    .sort((a, b) => a.position - b.position)
    .map((item, position) => ({
      ...item,
      id: `${options.runId}:${position}:${item.postId}`,
      runId: options.runId,
      position,
      committed: position <= committedUntil,
    }));
  const remaining = candidates.filter((candidate) => !selectedPostIds.has(candidate.post.id));

  while (selected.length < options.recipe.targetQueueSize && remaining.length > 0) {
    const next = pickNextCandidate(remaining, selected, options.recipe);
    if (!next) break;

    const index = remaining.findIndex((candidate) => candidate.post.id === next.post.id);
    remaining.splice(index, 1);

    selected.push(createRunItem(
      options.runId,
      selected.length,
      next,
      selected.length <= committedUntil,
      now
    ));
  }

  return selected.map((item, position) => ({
    ...item,
    id: `${options.runId}:${position}:${item.postId}`,
    position,
    committed: position <= committedUntil,
  }));
}

