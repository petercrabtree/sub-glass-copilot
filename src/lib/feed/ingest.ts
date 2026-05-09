import {
  getPost,
  getSourceStats,
  getSubreddit,
  upsertAdjacency,
  upsertMedia,
  upsertPost,
  upsertPostSource,
  upsertSourceStats,
  upsertSubreddit,
} from '$lib/db/store';
import { extractLinksFromPost } from '$lib/adjacency/extract';
import { enrichRedgifsPosts } from '$lib/media/redgifs';
import { normalizeListingResponse } from '$lib/normalize/posts';
import { getCanonicalListingTime, normalizeRedditListingSort } from '$lib/reddit/listing';
import {
  getFeedSourceKey,
  getFeedSourceLabel,
  getFeedSourceRoutePath,
  normalizeSourceSubreddit,
  type FeedSourceSpec,
} from '$lib/feed/source';
import type { RedditListingResponse } from '$lib/transport/reddit';
import type { PostRecord, SourceStats } from '$lib/types';

export interface PersistFetchedPostsContext extends FeedSourceSpec {
  routePath?: string;
  recipeId?: string;
  runId?: string;
  batchId?: string;
  fetchedAt?: number;
  afterCursor?: string | null;
  isMultireddit?: boolean;
  rawPostsReturned?: number;
}

export interface PersistFetchedPostsResult {
  mediaPosts: PostRecord[];
  newPostIds: string[];
  duplicatePostIds: string[];
  discoveredSubreddits: string[];
  sourceKey: string;
  sourceLabel: string;
}

export async function ensureSubredditRecord(
  name: string,
  discoveredVia?: string,
  discoveryReason?: string,
  isNsfwHint?: boolean
): Promise<void> {
  const normalizedName = normalizeSourceSubreddit(name);
  const existing = await getSubreddit(normalizedName);
  if (!existing) {
    await upsertSubreddit({
      name: normalizedName,
      prefixedName: `r/${normalizedName}`,
      firstSeenAt: Date.now(),
      localRating: 0,
      isMuted: false,
      isNsfw: isNsfwHint,
      discoveryStatus: 'discovered',
      discoveredVia,
      discoveryReason,
    });
    return;
  }

  const nextIsNsfw = existing.isNsfw === true
    ? true
    : isNsfwHint ?? existing.isNsfw;
  if (!discoveredVia && !discoveryReason && nextIsNsfw === existing.isNsfw) return;

  await upsertSubreddit({
    ...existing,
    isNsfw: nextIsNsfw,
    discoveredVia: existing.discoveredVia ?? discoveredVia,
    discoveryReason: existing.discoveryReason ?? discoveryReason,
  });
}

export async function normalizeListingMediaPosts(listing: RedditListingResponse): Promise<PostRecord[]> {
  const normalized = await enrichRedgifsPosts(normalizeListingResponse(listing.data.children));
  return normalized.filter((post) => post.media);
}

function createFallbackSourceStats(context: PersistFetchedPostsContext, sourceKey: string, sourceLabel: string): SourceStats {
  const listingSort = normalizeRedditListingSort(context.listingSort, 'hot');
  const listingTime = getCanonicalListingTime(listingSort, context.listingTime);

  return {
    sourceKey,
    sourceLabel,
    subreddit: normalizeSourceSubreddit(context.subreddit),
    listingSort,
    listingTime,
    fetchCount: 0,
    postsReturned: 0,
    mediaPostsReturned: 0,
    newPostsReturned: 0,
    duplicatePostsReturned: 0,
    updatedAt: Date.now(),
  };
}

export async function persistFetchedPosts(
  mediaPosts: PostRecord[],
  context: PersistFetchedPostsContext
): Promise<PersistFetchedPostsResult> {
  const sourceKey = getFeedSourceKey(context);
  const sourceLabel = getFeedSourceLabel(context);
  const routePath = context.routePath ?? getFeedSourceRoutePath(context);
  const fetchedAt = context.fetchedAt ?? Date.now();
  const batchId = context.batchId ?? `${sourceKey}:${fetchedAt}`;
  const rawPostsReturned = context.rawPostsReturned ?? mediaPosts.length;
  const listingSort = normalizeRedditListingSort(context.listingSort, 'hot');
  const listingTime = getCanonicalListingTime(listingSort, context.listingTime);
  const newPostIds: string[] = [];
  const duplicatePostIds: string[] = [];
  const discoveredSubreddits = new Set<string>();

  await Promise.all(mediaPosts.map(async (post, listingPosition) => {
    const existing = await getPost(post.id);
    if (existing) {
      duplicatePostIds.push(post.id);
    } else {
      newPostIds.push(post.id);
    }

    const routedPost = { ...post, fetchedInRoute: routePath };
    await upsertPost(routedPost);
    if (routedPost.media) await upsertMedia(routedPost.media);
    await ensureSubredditRecord(routedPost.subreddit, undefined, undefined, routedPost.isNsfw);
    discoveredSubreddits.add(normalizeSourceSubreddit(routedPost.subreddit));

    await upsertPostSource({
      id: `${post.id}:${sourceKey}`,
      postId: post.id,
      sourceKey,
      sourceLabel,
      subreddit: routedPost.subreddit,
      routePath,
      listingSort,
      listingTime,
      listingPosition,
      fetchedAt,
      isMultireddit: context.isMultireddit ?? false,
      recipeId: context.recipeId,
      runId: context.runId,
      batchId,
    });

    const links = extractLinksFromPost(
      routedPost.title,
      routedPost.selftext ?? '',
      routedPost.subreddit,
      routedPost.crosspostParentSubreddit
    );
    for (const link of links) {
      await upsertAdjacency(link);
      await ensureSubredditRecord(link.toSubreddit, `${link.source}:r/${routedPost.subreddit}`, link.evidence);
      discoveredSubreddits.add(normalizeSourceSubreddit(link.toSubreddit));
    }
  }));

  const existingStats = await getSourceStats(sourceKey);
  await upsertSourceStats({
    ...(existingStats ?? createFallbackSourceStats(context, sourceKey, sourceLabel)),
    sourceLabel,
    subreddit: normalizeSourceSubreddit(context.subreddit),
    listingSort,
    listingTime,
    afterCursor: context.afterCursor,
    lastFetchedAt: fetchedAt,
    lastError: undefined,
    fetchCount: (existingStats?.fetchCount ?? 0) + 1,
    postsReturned: (existingStats?.postsReturned ?? 0) + rawPostsReturned,
    mediaPostsReturned: (existingStats?.mediaPostsReturned ?? 0) + mediaPosts.length,
    newPostsReturned: (existingStats?.newPostsReturned ?? 0) + newPostIds.length,
    duplicatePostsReturned: (existingStats?.duplicatePostsReturned ?? 0) + duplicatePostIds.length,
    updatedAt: Date.now(),
  });

  return {
    mediaPosts,
    newPostIds,
    duplicatePostIds,
    discoveredSubreddits: [...discoveredSubreddits],
    sourceKey,
    sourceLabel,
  };
}

export async function persistListingResponse(
  listing: RedditListingResponse,
  context: PersistFetchedPostsContext
): Promise<PersistFetchedPostsResult> {
  const mediaPosts = await normalizeListingMediaPosts(listing);
  return persistFetchedPosts(mediaPosts, {
    ...context,
    afterCursor: context.afterCursor === undefined ? listing.data.after : context.afterCursor,
    rawPostsReturned: context.rawPostsReturned ?? listing.data.children.length,
  });
}

export async function markSourceFetchFailed(
  context: FeedSourceSpec,
  error: string,
  cooldownUntil?: number
): Promise<void> {
  const sourceKey = getFeedSourceKey(context);
  const sourceLabel = getFeedSourceLabel(context);
  const existingStats = await getSourceStats(sourceKey);
  const listingSort = normalizeRedditListingSort(context.listingSort, 'hot');
  const listingTime = getCanonicalListingTime(listingSort, context.listingTime);

  await upsertSourceStats({
    ...(existingStats ?? createFallbackSourceStats(context, sourceKey, sourceLabel)),
    sourceLabel,
    subreddit: normalizeSourceSubreddit(context.subreddit),
    listingSort,
    listingTime,
    lastError: error,
    cooldownUntil,
    updatedAt: Date.now(),
  });
}
