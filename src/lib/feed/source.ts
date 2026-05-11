import {
  getCanonicalListingTime,
  normalizeRedditListingSort,
  redditListingSortUsesTime,
} from '$lib/reddit/listing';
import type { RedditListingSort, RedditListingTime, SourceStats, SubredditRecord } from '$lib/types';

export interface FeedSourceSpec {
  subreddit: string;
  listingSort?: RedditListingSort;
  listingTime?: RedditListingTime;
}

export function normalizeSourceSubreddit(name: string): string {
  return name.trim().replace(/^\/?r\//i, '').toLowerCase();
}

export function isValidFeedSourceSubredditName(name: string): boolean {
  return /^[a-z0-9_]{2,21}$/i.test(normalizeSourceSubreddit(name));
}

export function normalizeFeedSourceSubredditList(names: readonly string[] | undefined): string[] {
  const normalized = new Set<string>();

  for (const name of names ?? []) {
    const subreddit = normalizeSourceSubreddit(name);
    if (!isValidFeedSourceSubredditName(subreddit) || subreddit === 'all') continue;
    normalized.add(subreddit);
  }

  return [...normalized];
}

export function getFeedSourceKey(spec: FeedSourceSpec): string {
  const subreddit = normalizeSourceSubreddit(spec.subreddit);
  const sort = normalizeRedditListingSort(spec.listingSort, 'hot');
  const time = getCanonicalListingTime(sort, spec.listingTime) ?? '';
  return `r/${subreddit}:${sort}:${time}`;
}

export function getFeedSourceLabel(spec: FeedSourceSpec): string {
  const subreddit = normalizeSourceSubreddit(spec.subreddit);
  const sort = normalizeRedditListingSort(spec.listingSort, 'hot');
  const time = getCanonicalListingTime(sort, spec.listingTime);
  const suffix = time
    ? `/${time}`
    : '';
  return `r/${subreddit} ${sort}${suffix}`;
}

export function getFeedSourceRoutePath(spec: FeedSourceSpec): string {
  const subreddit = normalizeSourceSubreddit(spec.subreddit);
  const sort = normalizeRedditListingSort(spec.listingSort, 'hot');
  const path = sort === 'hot' ? `/r/${subreddit}` : `/r/${subreddit}/${sort}`;
  const time = getCanonicalListingTime(sort, spec.listingTime);
  return time ? `${path}?t=${time}` : path;
}

export function getFeedSourcePath(spec: FeedSourceSpec): string {
  const subreddit = normalizeSourceSubreddit(spec.subreddit);
  const sort = normalizeRedditListingSort(spec.listingSort, 'hot');
  return sort === 'hot' ? `/r/${subreddit}` : `/r/${subreddit}/${sort}`;
}

export function feedSourceUsesCursor(spec: Pick<FeedSourceSpec, 'listingSort' | 'listingTime'>): boolean {
  const sort = normalizeRedditListingSort(spec.listingSort, 'hot');
  const time = getCanonicalListingTime(sort, spec.listingTime);

  if (!redditListingSortUsesTime(sort)) return false;
  if (!time) return false;
  return time === 'week' || time === 'month' || time === 'year' || time === 'all';
}

export function getFeedSourceRefetchCooldownMs(
  spec: Pick<FeedSourceSpec, 'listingSort' | 'listingTime'>
): number {
  const sort = normalizeRedditListingSort(spec.listingSort, 'hot');
  const time = getCanonicalListingTime(sort, spec.listingTime);

  if (sort === 'new') return 5 * 60 * 1000;
  if (sort === 'hot' || sort === 'rising') return 10 * 60 * 1000;
  if (time === 'hour' || time === 'day') return 10 * 60 * 1000;
  return 30 * 60 * 1000;
}

export function isFeedSourceAvailable(sub: SubredditRecord): boolean {
  if (!sub.name || sub.name === 'all') return false;
  if (sub.isMuted || sub.discoveryStatus === 'muted') return false;
  if (sub.discoveryStatus === 'failed') return false;
  if (
    sub.availabilityStatus === 'banned' ||
    sub.availabilityStatus === 'private' ||
    sub.availabilityStatus === 'quarantined' ||
    sub.availabilityStatus === 'not_found'
  ) {
    return false;
  }
  return /^[a-z0-9_]{2,21}$/i.test(sub.name);
}

export function getSourceYieldScore(stats: SourceStats | undefined, duplicatePenaltyWeight = 0.7): number {
  if (!stats || stats.fetchCount === 0) return 0.65;
  const mediaRate = stats.postsReturned > 0 ? stats.mediaPostsReturned / stats.postsReturned : 0;
  const duplicateRate = stats.mediaPostsReturned > 0 ? stats.duplicatePostsReturned / stats.mediaPostsReturned : 0;
  return Math.max(0.05, Math.min(1.4, mediaRate * (1 - duplicateRate * duplicatePenaltyWeight)));
}
