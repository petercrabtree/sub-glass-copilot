import {
  addQueueEvent,
  getActiveFeedRun,
  getAllEvents,
  getAllPostSources,
  getAllPosts,
  getAllSourceStats,
  getAllSubreddits,
  getFeedRunItems,
  getPostsByIds,
  getSeenPostIds,
  upsertFeedRun,
  replaceFeedRunItems,
} from '$lib/db/store';
import { fetchListing } from '$lib/transport/reddit';
import { ensureFeedRecipe, type FeedRecipeInput } from '$lib/feed/recipes';
import { persistListingResponse, markSourceFetchFailed } from '$lib/feed/ingest';
import { readCachedListingPosts, writeListingCache } from '$lib/feed/listing-cache';
import { mixFeedQueue } from '$lib/feed/mixer';
import { planFeedSourceFetches } from '$lib/feed/source-planner';
import {
  feedSourceUsesCursor,
  getFeedSourceKey,
  getFeedSourceLabel,
  getFeedSourcePath,
  getFeedSourceRoutePath,
  normalizeFeedSourceSubredditList,
} from '$lib/feed/source';
import { scoreFeedCandidates } from '$lib/feed/scoring';
import type { FeedRecipe, FeedRun, FeedRunItem, FetchSpec, PostRecord, SourceStats } from '$lib/types';

export interface FeedRunState {
  recipe: FeedRecipe;
  run: FeedRun;
  items: FeedRunItem[];
  posts: PostRecord[];
}

export interface BuildFeedRunOptions {
  refreshTail?: boolean;
  currentIndex?: number;
}

export interface RefillFeedSourcesOptions {
  force?: boolean;
  forceNetwork?: boolean;
  onlySubreddits?: string[];
}

export interface FeedRefillResult {
  attempted: number;
  ok: number;
  failed: number;
  mediaPosts: number;
  newPosts: number;
  cacheHits: number;
  networkRequests: number;
  sources: string[];
  scanTargets: string[];
}

function createRunId(recipeId: string): string {
  return `feed:${recipeId}`;
}

function createRun(recipe: FeedRecipe): FeedRun {
  const now = Date.now();
  return {
    id: createRunId(recipe.id),
    recipeId: recipe.id,
    feedName: recipe.name,
    status: 'active',
    currentIndex: 0,
    locked: false,
    committedUntil: recipe.committedAheadCount,
    seed: `${recipe.id}:${now}`,
    createdAt: now,
    updatedAt: now,
  };
}

async function getRunPosts(items: FeedRunItem[]): Promise<PostRecord[]> {
  const posts = await getPostsByIds(items.map((item) => item.postId));
  const postById = new Map(posts.map((post) => [post.id, post]));
  return items
    .map((item) => postById.get(item.postId))
    .filter((post): post is PostRecord => Boolean(post?.media));
}

export async function loadFeedRun(feedInput: string | FeedRecipeInput): Promise<FeedRunState> {
  const recipe = await ensureFeedRecipe(feedInput);
  const run = await getActiveFeedRun(recipe.id) ?? createRun(recipe);
  const items = await getFeedRunItems(run.id);
  return {
    recipe,
    run,
    items,
    posts: await getRunPosts(items),
  };
}

export async function buildFeedRun(
  feedInput: string | FeedRecipeInput,
  options: BuildFeedRunOptions = {}
): Promise<FeedRunState> {
  const recipe = await ensureFeedRecipe(feedInput);
  const existingRun = await getActiveFeedRun(recipe.id);
  const run = existingRun ?? createRun(recipe);
  const existingItems = existingRun ? await getFeedRunItems(run.id) : [];
  const currentIndex = options.currentIndex ?? run.currentIndex;

  if (run.locked && existingItems.length > 0) {
    return {
      recipe,
      run,
      items: existingItems,
      posts: await getRunPosts(existingItems),
    };
  }

  if (!options.refreshTail && existingItems.length > 0) {
    return {
      recipe,
      run,
      items: existingItems,
      posts: await getRunPosts(existingItems),
    };
  }

  const [posts, subreddits, events, postSources, sourceStats, seenPostIds] = await Promise.all([
    getAllPosts(),
    getAllSubreddits(),
    getAllEvents(),
    getAllPostSources(),
    getAllSourceStats(),
    getSeenPostIds(),
  ]);
  const candidates = scoreFeedCandidates({
    recipe,
    posts,
    subreddits,
    events,
    postSources,
    sourceStats,
    seenPostIds,
  });
  const items = mixFeedQueue(candidates, {
    recipe,
    runId: run.id,
    existingItems,
    currentIndex,
    refreshTail: options.refreshTail || existingItems.length === 0,
  });
  const nextRun: FeedRun = {
    ...run,
    currentIndex: Math.min(currentIndex, Math.max(0, items.length - 1)),
    committedUntil: Math.min(items.length - 1, currentIndex + recipe.committedAheadCount),
    updatedAt: Date.now(),
  };

  await upsertFeedRun(nextRun);
  await replaceFeedRunItems(nextRun.id, items);
  await addQueueEvent({
    runId: nextRun.id,
    type: options.refreshTail ? 'refresh_tail' : 'build',
    value: `${items.length} items`,
    ts: Date.now(),
  });

  return {
    recipe,
    run: nextRun,
    items,
    posts: await getRunPosts(items),
  };
}

function sourceUsesTime(recipe: FeedRecipe): boolean {
  return recipe.listingSort === 'top' || recipe.listingSort === 'controversial';
}

function getSourceStatsMap(stats: SourceStats[]): Map<string, SourceStats> {
  return new Map(stats.map((entry) => [entry.sourceKey, entry]));
}

export async function refillFeedSources(
  feedInput: string | FeedRecipeInput,
  options: RefillFeedSourcesOptions = {}
): Promise<FeedRefillResult> {
  const recipe = await ensureFeedRecipe(feedInput);
  const [posts, subreddits, sourceStats] = await Promise.all([
    getAllPosts(),
    getAllSubreddits(),
    getAllSourceStats(),
  ]);
  const statsByKey = getSourceStatsMap(sourceStats);
  const explicitSubreddits = normalizeFeedSourceSubredditList(options.onlySubreddits);
  const plans = explicitSubreddits.length > 0
    ? explicitSubreddits.map((subreddit) => ({
      subreddit,
      listingSort: recipe.listingSort,
      listingTime: recipe.listingTime,
    }))
    : planFeedSourceFetches(subreddits, recipe, sourceStats, [], posts, { force: options.force });
  const batchId = `${recipe.id}:${Date.now()}`;
  const result: FeedRefillResult = {
    attempted: plans.length,
    ok: 0,
    failed: 0,
    mediaPosts: 0,
    newPosts: 0,
    cacheHits: 0,
    networkRequests: 0,
    sources: [],
    scanTargets: [],
  };
  const scanTargets = new Set<string>();

  for (const plan of plans) {
    const sourceKey = getFeedSourceKey(plan);
    const sourceLabel = getFeedSourceLabel(plan);
    const stats = statsByKey.get(sourceKey);
    const useAfterCursor = feedSourceUsesCursor(plan);
    scanTargets.add(plan.subreddit);
    const fetchSpec: FetchSpec = {
      path: getFeedSourcePath(plan),
      subreddits: [plan.subreddit],
      sort: recipe.listingSort,
      time: sourceUsesTime(recipe) ? recipe.listingTime : undefined,
      after: useAfterCursor ? stats?.afterCursor ?? undefined : undefined,
    };

    if (!options.forceNetwork) {
      const cached = await readCachedListingPosts(fetchSpec, 25);
      if (cached) {
        result.ok += 1;
        result.cacheHits += 1;
        result.mediaPosts += cached.posts.length;
        result.sources.push(`${sourceLabel} cached`);
        continue;
      }
    }

    result.networkRequests += 1;
    const fetchResult = await fetchListing(fetchSpec, 25, { priority: 'background' });

    if (!fetchResult.ok) {
      result.failed += 1;
      await markSourceFetchFailed(plan, fetchResult.error.message, fetchResult.error.rateLimitedUntil);
      continue;
    }

    const persisted = await persistListingResponse(fetchResult.data, {
      ...plan,
      routePath: getFeedSourceRoutePath(plan),
      recipeId: recipe.id,
      batchId,
      afterCursor: useAfterCursor ? fetchResult.data.data.after : null,
      isMultireddit: false,
      rawPostsReturned: fetchResult.data.data.children.length,
    });
    result.ok += 1;
    result.mediaPosts += persisted.mediaPosts.length;
    result.newPosts += persisted.newPostIds.length;
    result.sources.push(sourceLabel);
    persisted.discoveredSubreddits.forEach((name) => scanTargets.add(name));
    await writeListingCache(fetchSpec, persisted.mediaPosts, fetchResult.data.data.after, 25);
  }

  result.scanTargets = [...scanTargets];

  await addQueueEvent({
    runId: createRunId(recipe.id),
    type: 'refill',
    value: `${result.ok}/${result.attempted} sources · ${result.mediaPosts} media`,
    ts: Date.now(),
  });

  return result;
}

export async function setFeedRunIndex(run: FeedRun, currentIndex: number): Promise<FeedRun> {
  const nextRun = {
    ...run,
    currentIndex,
    committedUntil: Math.max(run.committedUntil, currentIndex + 1),
    updatedAt: Date.now(),
  };
  await upsertFeedRun(nextRun);
  return nextRun;
}

export async function setFeedRunLocked(run: FeedRun, locked: boolean): Promise<FeedRun> {
  const nextRun = {
    ...run,
    locked,
    updatedAt: Date.now(),
  };
  await upsertFeedRun(nextRun);
  await addQueueEvent({
    runId: run.id,
    type: locked ? 'lock' : 'unlock',
    ts: Date.now(),
  });
  return nextRun;
}
