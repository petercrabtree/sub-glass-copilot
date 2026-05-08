import type { RedditListingSort, RedditListingTime, SourceStats, SubredditRecord } from '$lib/types';

export interface FeedSourceSpec {
  subreddit: string;
  listingSort?: RedditListingSort;
  listingTime?: RedditListingTime;
}

export function normalizeSourceSubreddit(name: string): string {
  return name.trim().replace(/^\/?r\//i, '').toLowerCase();
}

export function getFeedSourceKey(spec: FeedSourceSpec): string {
  const subreddit = normalizeSourceSubreddit(spec.subreddit);
  const sort = spec.listingSort ?? 'hot';
  const time = spec.listingTime ?? '';
  return `r/${subreddit}:${sort}:${time}`;
}

export function getFeedSourceLabel(spec: FeedSourceSpec): string {
  const subreddit = normalizeSourceSubreddit(spec.subreddit);
  const sort = spec.listingSort ?? 'hot';
  const time = spec.listingTime && (sort === 'top' || sort === 'controversial')
    ? `/${spec.listingTime}`
    : '';
  return `r/${subreddit} ${sort}${time}`;
}

export function getFeedSourceRoutePath(spec: FeedSourceSpec): string {
  const subreddit = normalizeSourceSubreddit(spec.subreddit);
  const sort = spec.listingSort ?? 'hot';
  return sort === 'hot' ? `/r/${subreddit}` : `/r/${subreddit}/${sort}`;
}

export function getFeedSourcePath(spec: FeedSourceSpec): string {
  const subreddit = normalizeSourceSubreddit(spec.subreddit);
  const sort = spec.listingSort ?? 'hot';
  return sort === 'hot' ? `/r/${subreddit}` : `/r/${subreddit}/${sort}`;
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

export function getSourceYieldScore(stats: SourceStats | undefined): number {
  if (!stats || stats.fetchCount === 0) return 0.65;
  const mediaRate = stats.postsReturned > 0 ? stats.mediaPostsReturned / stats.postsReturned : 0;
  const duplicateRate = stats.mediaPostsReturned > 0 ? stats.duplicatePostsReturned / stats.mediaPostsReturned : 0;
  return Math.max(0.05, Math.min(1.4, mediaRate * (1 - duplicateRate * 0.7)));
}

