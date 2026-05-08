import {
  chooseRouletteSubreddits,
  getRouletteCandidates,
} from '$lib/discovery/roulette';
import {
  getFeedSourceKey,
  isFeedSourceAvailable,
  normalizeSourceSubreddit,
  type FeedSourceSpec,
} from '$lib/feed/source';
import type {
  FeedRecipe,
  PostRecord,
  SourceStats,
  SubredditRecord,
  SubredditRouletteSettings,
} from '$lib/types';

const SOURCE_REFETCH_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_BOOTSTRAP_SOURCE = 'nsfw';

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

function createBootstrapSourceSubreddit(): SubredditRecord {
  return {
    name: DEFAULT_BOOTSTRAP_SOURCE,
    prefixedName: `r/${DEFAULT_BOOTSTRAP_SOURCE}`,
    firstSeenAt: Date.now(),
    localRating: 0,
    isMuted: false,
    isNsfw: true,
    discoveryStatus: 'discovered',
    discoveredVia: 'feed-bootstrap',
    discoveryReason: 'default local feed source',
  };
}

function isFeedNsfwCompatible(sub: SubredditRecord, recipe: FeedRecipe): boolean {
  if (recipe.nsfwMode === 'yes') return true;
  if (recipe.nsfwMode === 'no') return sub.isNsfw !== true;
  return sub.isNsfw !== false;
}

function mergePostDerivedSubreddits(
  subreddits: SubredditRecord[],
  posts: PostRecord[] = []
): SubredditRecord[] {
  const byName = new Map(subreddits.map((sub) => [normalizeSourceSubreddit(sub.name), sub]));

  for (const post of posts) {
    const name = normalizeSourceSubreddit(post.subreddit);
    if (!name || name === 'all') continue;

    const existing = byName.get(name);
    if (existing) {
      if (post.isNsfw && existing.isNsfw !== true) {
        byName.set(name, { ...existing, isNsfw: true });
      } else if (existing.isNsfw === undefined) {
        byName.set(name, { ...existing, isNsfw: post.isNsfw });
      }
      continue;
    }

    byName.set(name, {
      name,
      prefixedName: `r/${name}`,
      firstSeenAt: post.createdAt || Date.now(),
      localRating: 0,
      isMuted: false,
      isNsfw: post.isNsfw,
      discoveryStatus: 'discovered',
      discoveredVia: 'local-posts',
      discoveryReason: 'derived from local post inventory',
    });
  }

  return [...byName.values()];
}

export function getEligibleFeedSourceCount(
  subreddits: SubredditRecord[],
  recipe: FeedRecipe
): number {
  const eligible = getRouletteCandidates(
    subreddits
      .filter(isFeedSourceAvailable)
      .filter((sub) => isFeedNsfwCompatible(sub, recipe)),
    { ...asRouletteSettings(recipe), nsfwMode: 'yes' }
  );

  if (eligible.length > 0 || recipe.nsfwMode === 'no') return eligible.length;
  return 1;
}

export function planFeedSourceFetches(
  subreddits: SubredditRecord[],
  recipe: FeedRecipe,
  sourceStats: SourceStats[],
  avoidSubreddits: string[] = [],
  posts: PostRecord[] = []
): FeedSourceSpec[] {
  const now = Date.now();
  const statsByKey = getStatsMap(sourceStats);
  const settings = asRouletteSettings(recipe);
  const avoided = new Set(avoidSubreddits.map((name) => name.toLowerCase()));
  const sourcePool = mergePostDerivedSubreddits(subreddits, posts)
    .filter(isFeedSourceAvailable)
    .filter((sub) => isFeedNsfwCompatible(sub, recipe))
    .filter((sub) => !avoided.has(sub.name.toLowerCase()));
  const fallbackPool = recipe.nsfwMode === 'no' ? [] : [createBootstrapSourceSubreddit()];
  const candidates = (sourcePool.length > 0 ? sourcePool : fallbackPool)
    .filter((sub) => {
      const sourceKey = getFeedSourceKey({
        subreddit: sub.name,
        listingSort: recipe.listingSort,
        listingTime: recipe.listingTime,
      });
      const stats = statsByKey.get(sourceKey);
      if (stats?.cooldownUntil && stats.cooldownUntil > now) return false;
      if (
        stats?.lastFetchedAt &&
        !stats.afterCursor &&
        now - stats.lastFetchedAt < SOURCE_REFETCH_COOLDOWN_MS
      ) {
        return false;
      }
      return true;
    });

  const selected = chooseRouletteSubreddits(candidates, { ...settings, nsfwMode: 'yes' });

  return selected.map((sub) => ({
    subreddit: sub.name,
    listingSort: recipe.listingSort,
    listingTime: recipe.listingTime,
  }));
}
