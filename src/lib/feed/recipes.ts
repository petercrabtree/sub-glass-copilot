import { getFeedRecipe, upsertFeedRecipe } from '$lib/db/store';
import type { FeedRecipe, FeedRecipeSourceMode, RedditListingSort, RedditListingTime } from '$lib/types';

const FEED_NAME_PATTERN = /^[a-z0-9_-]{1,40}$/i;

type RecipePreset = Omit<FeedRecipe, 'id' | 'name' | 'createdAt' | 'updatedAt'> & {
  name: string;
};

const RECIPE_PRESETS: Record<string, RecipePreset> = {
  random: {
    name: 'random',
    description: 'A fair random mix from eligible known subreddits, with local quality checks.',
    sourceMode: 'random',
    nsfwMode: 'only',
    listingSort: 'top',
    listingTime: 'month',
    sourceCount: 10,
    targetQueueSize: 40,
    committedAheadCount: 4,
    maxPerSubredditWindow: 2,
    qualityWeight: 0.9,
    diversityWeight: 1.15,
    noveltyWeight: 0.9,
  },
  comfort: {
    name: 'comfort',
    description: 'Bias toward subreddits with strong local ratings and positive history.',
    sourceMode: 'comfort',
    nsfwMode: 'only',
    listingSort: 'top',
    listingTime: 'month',
    sourceCount: 8,
    targetQueueSize: 36,
    committedAheadCount: 5,
    maxPerSubredditWindow: 3,
    qualityWeight: 1.25,
    diversityWeight: 0.8,
    noveltyWeight: 0.35,
  },
  fresh: {
    name: 'fresh',
    description: 'Favor newer posts from known available sources.',
    sourceMode: 'fresh',
    nsfwMode: 'only',
    listingSort: 'new',
    listingTime: 'day',
    sourceCount: 12,
    targetQueueSize: 40,
    committedAheadCount: 4,
    maxPerSubredditWindow: 2,
    qualityWeight: 0.7,
    diversityWeight: 1,
    noveltyWeight: 1.2,
  },
  explore: {
    name: 'explore',
    description: 'Lean into unvisited and weakly rated sources while keeping quality guardrails.',
    sourceMode: 'explore',
    nsfwMode: 'only',
    listingSort: 'top',
    listingTime: 'month',
    sourceCount: 12,
    targetQueueSize: 44,
    committedAheadCount: 4,
    maxPerSubredditWindow: 2,
    qualityWeight: 0.85,
    diversityWeight: 1.3,
    noveltyWeight: 1.4,
  },
};

export function normalizeFeedName(feedName: string | undefined): string {
  const normalized = (feedName || 'random').trim().toLowerCase();
  if (!FEED_NAME_PATTERN.test(normalized)) return 'random';
  return normalized;
}

function getPreset(feedName: string): RecipePreset {
  return RECIPE_PRESETS[feedName] ?? {
    ...RECIPE_PRESETS.random,
    name: feedName,
    description: `${feedName} local feed using the random mix defaults.`,
  };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampWeight(value: number): number {
  return Math.min(2, Math.max(0, Number(value.toFixed(2))));
}

function normalizeSort(sort: RedditListingSort): RedditListingSort {
  return sort;
}

function normalizeTime(time: RedditListingTime): RedditListingTime {
  return time;
}

function normalizeSourceMode(mode: FeedRecipeSourceMode): FeedRecipeSourceMode {
  return mode;
}

export function normalizeFeedRecipe(recipe: FeedRecipe): FeedRecipe {
  return {
    ...recipe,
    name: normalizeFeedName(recipe.name),
    sourceMode: normalizeSourceMode(recipe.sourceMode),
    listingSort: normalizeSort(recipe.listingSort),
    listingTime: normalizeTime(recipe.listingTime),
    sourceCount: clampInt(recipe.sourceCount, 1, 24),
    targetQueueSize: clampInt(recipe.targetQueueSize, 8, 120),
    committedAheadCount: clampInt(recipe.committedAheadCount, 1, 12),
    maxPerSubredditWindow: clampInt(recipe.maxPerSubredditWindow, 1, 8),
    qualityWeight: clampWeight(recipe.qualityWeight),
    diversityWeight: clampWeight(recipe.diversityWeight),
    noveltyWeight: clampWeight(recipe.noveltyWeight),
  };
}

export async function ensureFeedRecipe(feedNameInput: string | undefined): Promise<FeedRecipe> {
  const feedName = normalizeFeedName(feedNameInput);
  const existing = await getFeedRecipe(feedName);
  if (existing) return normalizeFeedRecipe(existing);

  const preset = getPreset(feedName);
  const now = Date.now();
  const recipe = normalizeFeedRecipe({
    id: feedName,
    ...preset,
    createdAt: now,
    updatedAt: now,
  });
  await upsertFeedRecipe(recipe);
  return recipe;
}

