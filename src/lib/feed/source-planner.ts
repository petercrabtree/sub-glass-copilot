import {
  chooseRouletteSubreddits,
  getRouletteCandidates,
} from '$lib/discovery/roulette';
import {
  getFeedSourceKey,
  getFeedSourceRefetchCooldownMs,
  isFeedSourceAvailable,
  normalizeFeedSourceSubredditList,
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

function createManualSourceSubreddit(name: string): SubredditRecord {
  return {
    name,
    prefixedName: `r/${name}`,
    firstSeenAt: Date.now(),
    localRating: 0,
    isMuted: false,
    discoveryStatus: 'discovered',
    discoveredVia: 'feed-manual',
    discoveryReason: 'manual feed source',
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

function sourceIsReadyToFetch(
  sub: SubredditRecord,
  recipe: FeedRecipe,
  statsByKey: Map<string, SourceStats>,
  force = false
): boolean {
  const sourceKey = getFeedSourceKey({
    subreddit: sub.name,
    listingSort: recipe.listingSort,
    listingTime: recipe.listingTime,
  });
  const stats = statsByKey.get(sourceKey);
  const cooldownMs = getFeedSourceRefetchCooldownMs({
    listingSort: recipe.listingSort,
    listingTime: recipe.listingTime,
  });

  if (force) return true;
  if (stats?.cooldownUntil && stats.cooldownUntil > Date.now()) return false;
  if (stats?.lastFetchedAt && Date.now() - stats.lastFetchedAt < cooldownMs) return false;
  return true;
}

export function getEligibleFeedSourceCount(
  subreddits: SubredditRecord[],
  recipe: FeedRecipe
): number {
  const excludedSourceSet = new Set(normalizeFeedSourceSubredditList(recipe.excludedSourceSubreddits));
  const eligible = getRouletteCandidates(
    subreddits
      .filter(isFeedSourceAvailable)
      .filter((sub) => !excludedSourceSet.has(normalizeSourceSubreddit(sub.name)))
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
  posts: PostRecord[] = [],
  options: { force?: boolean } = {}
): FeedSourceSpec[] {
  const statsByKey = getStatsMap(sourceStats);
  const settings = asRouletteSettings(recipe);
  const avoided = new Set(avoidSubreddits.map((name) => name.toLowerCase()));
  const manualSourceSubreddits = normalizeFeedSourceSubredditList(recipe.manualSourceSubreddits);
  const manualSourceSet = new Set(manualSourceSubreddits);
  const excludedSourceSet = new Set(normalizeFeedSourceSubredditList(recipe.excludedSourceSubreddits));
  const allSources = mergePostDerivedSubreddits(subreddits, posts);
  const sourcePool = allSources
    .filter(isFeedSourceAvailable)
    .filter((sub) => isFeedNsfwCompatible(sub, recipe))
    .filter((sub) => !excludedSourceSet.has(normalizeSourceSubreddit(sub.name)))
    .filter((sub) => !avoided.has(sub.name.toLowerCase()));
  const fallbackPool = recipe.nsfwMode === 'no' ? [] : [createBootstrapSourceSubreddit()];
  const poolByName = new Map(allSources.map((sub) => [normalizeSourceSubreddit(sub.name), sub]));
  const manualCandidates = manualSourceSubreddits
    .map((name) => poolByName.get(name) ?? createManualSourceSubreddit(name))
    .filter(isFeedSourceAvailable)
    .filter((sub) => isFeedNsfwCompatible(sub, recipe))
    .filter((sub) => !avoided.has(sub.name.toLowerCase()))
    .filter((sub) => sourceIsReadyToFetch(sub, recipe, statsByKey, options.force));
  const automaticCandidates = (sourcePool.length > 0 ? sourcePool : fallbackPool)
    .filter((sub) => !manualSourceSet.has(normalizeSourceSubreddit(sub.name)))
    .filter((sub) => sourceIsReadyToFetch(sub, recipe, statsByKey, options.force));
  const remainingSourceCount = Math.max(0, recipe.sourceCount - manualCandidates.length);
  const selectedAutomatic = remainingSourceCount > 0
    ? chooseRouletteSubreddits(
      automaticCandidates,
      { ...settings, subredditCount: remainingSourceCount, nsfwMode: 'yes' }
    )
    : [];
  const selected = [...manualCandidates, ...selectedAutomatic];

  return selected.map((sub) => ({
    subreddit: sub.name,
    listingSort: recipe.listingSort,
    listingTime: recipe.listingTime,
  }));
}
