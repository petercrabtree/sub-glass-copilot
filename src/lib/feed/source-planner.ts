import {
  chooseRouletteSubreddits,
  getRouletteCandidates,
} from '$lib/discovery/roulette';
import { getFeedSourceKey, isFeedSourceAvailable, type FeedSourceSpec } from '$lib/feed/source';
import type { FeedRecipe, SourceStats, SubredditRecord, SubredditRouletteSettings } from '$lib/types';

const SOURCE_REFETCH_COOLDOWN_MS = 30 * 60 * 1000;

function getRecipeRouletteWeights(recipe: FeedRecipe): Pick<
  SubredditRouletteSettings,
  'likedWeight' | 'newWeight' | 'randomWeight'
> {
  switch (recipe.sourceMode) {
    case 'comfort':
      return { likedWeight: 8, newWeight: 0.5, randomWeight: 0.5 };
    case 'fresh':
      return { likedWeight: 2, newWeight: 5, randomWeight: 2 };
    case 'explore':
      return { likedWeight: 1, newWeight: 5, randomWeight: 4 };
    case 'liked':
      return { likedWeight: 8, newWeight: 1, randomWeight: 1 };
    case 'random':
    default:
      return { likedWeight: 2, newWeight: 2, randomWeight: 5 };
  }
}

function asRouletteSettings(recipe: FeedRecipe): SubredditRouletteSettings {
  return {
    subredditCount: recipe.sourceCount,
    imagesPerRound: recipe.targetQueueSize,
    nsfwMode: recipe.nsfwMode,
    listingSort: recipe.listingSort,
    listingTime: recipe.listingTime,
    ...getRecipeRouletteWeights(recipe),
  };
}

function getStatsMap(sourceStats: SourceStats[]): Map<string, SourceStats> {
  return new Map(sourceStats.map((stats) => [stats.sourceKey, stats]));
}

export function getEligibleFeedSourceCount(
  subreddits: SubredditRecord[],
  recipe: FeedRecipe
): number {
  return getRouletteCandidates(subreddits.filter(isFeedSourceAvailable), asRouletteSettings(recipe)).length;
}

export function planFeedSourceFetches(
  subreddits: SubredditRecord[],
  recipe: FeedRecipe,
  sourceStats: SourceStats[],
  avoidSubreddits: string[] = []
): FeedSourceSpec[] {
  const now = Date.now();
  const statsByKey = getStatsMap(sourceStats);
  const settings = asRouletteSettings(recipe);
  const avoided = new Set(avoidSubreddits.map((name) => name.toLowerCase()));
  const candidates = subreddits
    .filter(isFeedSourceAvailable)
    .filter((sub) => !avoided.has(sub.name.toLowerCase()))
    .filter((sub) => {
      const sourceKey = getFeedSourceKey({
        subreddit: sub.name,
        listingSort: recipe.listingSort,
        listingTime: recipe.listingTime,
      });
      const stats = statsByKey.get(sourceKey);
      if (stats?.cooldownUntil && stats.cooldownUntil > now) return false;
      if (stats?.lastFetchedAt && now - stats.lastFetchedAt < SOURCE_REFETCH_COOLDOWN_MS) return false;
      return true;
    });

  const selected = chooseRouletteSubreddits(candidates, settings);

  return selected.map((sub) => ({
    subreddit: sub.name,
    listingSort: recipe.listingSort,
    listingTime: recipe.listingTime,
  }));
}
