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
import { ensureFeedRecipe } from '$lib/feed/recipes';
import { persistListingResponse, markSourceFetchFailed } from '$lib/feed/ingest';
import { mixFeedQueue } from '$lib/feed/mixer';
import { planFeedSourceFetches } from '$lib/feed/source-planner';
import { getFeedSourceKey, getFeedSourceLabel, getFeedSourcePath, getFeedSourceRoutePath } from '$lib/feed/source';
import { scoreFeedCandidates } from '$lib/feed/scoring';
import type { FeedRecipe, FeedRun, FeedRunItem, PostRecord, SourceStats } from '$lib/types';

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

export interface FeedRefillResult {
  attempted: number;
  ok: number;
  failed: number;
  mediaPosts: number;
  newPosts: number;
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

export async function loadFeedRun(feedName: string): Promise<FeedRunState> {
  const recipe = await ensureFeedRecipe(feedName);
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
  feedName: string,
  options: BuildFeedRunOptions = {}
): Promise<FeedRunState> {
  const recipe = await ensureFeedRecipe(feedName);
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

export async function refillFeedSources(feedName: string): Promise<FeedRefillResult> {
  const recipe = await ensureFeedRecipe(feedName);
  const [posts, subreddits, sourceStats] = await Promise.all([
    getAllPosts(),
    getAllSubreddits(),
    getAllSourceStats(),
  ]);
  const statsByKey = getSourceStatsMap(sourceStats);
  const plans = planFeedSourceFetches(subreddits, recipe, sourceStats, [], posts);
  const batchId = `${recipe.id}:${Date.now()}`;
  const result: FeedRefillResult = {
    attempted: plans.length,
    ok: 0,
    failed: 0,
    mediaPosts: 0,
    newPosts: 0,
    sources: [],
    scanTargets: [],
  };
  const scanTargets = new Set<string>();

  for (const plan of plans) {
    const sourceKey = getFeedSourceKey(plan);
    const sourceLabel = getFeedSourceLabel(plan);
    const stats = statsByKey.get(sourceKey);
    scanTargets.add(plan.subreddit);
    const fetchResult = await fetchListing({
      path: getFeedSourcePath(plan),
      subreddits: [plan.subreddit],
      time: sourceUsesTime(recipe) ? recipe.listingTime : undefined,
      after: stats?.afterCursor ?? undefined,
    }, 25, { priority: 'background' });

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
      afterCursor: fetchResult.data.data.after,
      isMultireddit: false,
      rawPostsReturned: fetchResult.data.data.children.length,
    });
    result.ok += 1;
    result.mediaPosts += persisted.mediaPosts.length;
    result.newPosts += persisted.newPostIds.length;
    result.sources.push(sourceLabel);
    persisted.discoveredSubreddits.forEach((name) => scanTargets.add(name));
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
