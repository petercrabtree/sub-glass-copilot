import type { RedditListingSort, RedditListingTime } from '$lib/types';

export const REDDIT_LISTING_SORTS = ['hot', 'new', 'top', 'rising', 'controversial'] as const satisfies readonly RedditListingSort[];
export const REDDIT_LISTING_TIMES = ['hour', 'day', 'week', 'month', 'year', 'all'] as const satisfies readonly RedditListingTime[];
export const DEFAULT_REDDIT_LISTING_SORT: RedditListingSort = 'top';
export const DEFAULT_REDDIT_LISTING_TIME: RedditListingTime = 'month';

export function isRedditListingSort(value: unknown): value is RedditListingSort {
  return REDDIT_LISTING_SORTS.includes(value as RedditListingSort);
}

export function isRedditListingTime(value: unknown): value is RedditListingTime {
  return REDDIT_LISTING_TIMES.includes(value as RedditListingTime);
}

export function normalizeRedditListingSort(
  value: unknown,
  fallback: RedditListingSort = DEFAULT_REDDIT_LISTING_SORT
): RedditListingSort {
  return isRedditListingSort(value) ? value : fallback;
}

export function normalizeRedditListingTime(
  value: unknown,
  fallback: RedditListingTime = DEFAULT_REDDIT_LISTING_TIME
): RedditListingTime {
  return isRedditListingTime(value) ? value : fallback;
}

export function redditListingSortUsesTime(sort: RedditListingSort): boolean {
  return sort === 'top' || sort === 'controversial';
}

export function getCanonicalListingTime(
  sort: RedditListingSort,
  time: unknown,
  fallback: RedditListingTime = DEFAULT_REDDIT_LISTING_TIME
): RedditListingTime | undefined {
  return redditListingSortUsesTime(sort)
    ? normalizeRedditListingTime(time, fallback)
    : undefined;
}

export function formatRedditListingSummary(
  sort: RedditListingSort,
  time: RedditListingTime = DEFAULT_REDDIT_LISTING_TIME
): string {
  return redditListingSortUsesTime(sort) ? `${sort}/${time}` : sort;
}
