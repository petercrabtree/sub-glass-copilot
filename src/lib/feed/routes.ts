import {
  DEFAULT_REDDIT_LISTING_SORT,
  DEFAULT_REDDIT_LISTING_TIME,
  formatRedditListingSummary,
  getCanonicalListingTime,
  isRedditListingSort,
  normalizeRedditListingSort,
  normalizeRedditListingTime,
  redditListingSortUsesTime,
} from '$lib/reddit/listing';
import { normalizeFeedName, type FeedRecipeInput } from '$lib/feed/recipes';
import type { RedditListingSort, RedditListingTime } from '$lib/types';

export interface FeedRouteSpec extends FeedRecipeInput {
  feedName: string;
  listingSort: RedditListingSort;
  listingTime: RedditListingTime;
  routeKey: string;
  sourceSummary: string;
}

type FeedRoutePathInput = {
  feedName: string;
  listingSort?: RedditListingSort;
  listingTime?: RedditListingTime;
};

function splitRouteParam(param: string | undefined): string[] {
  return (param || 'random')
    .split('/')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

export function createFeedRouteSpec(
  feedNameInput: string | undefined,
  listingSortInput?: unknown,
  listingTimeInput?: unknown
): FeedRouteSpec {
  const feedName = normalizeFeedName(feedNameInput);
  const listingSort = normalizeRedditListingSort(listingSortInput);
  const listingTime = getCanonicalListingTime(listingSort, listingTimeInput) ?? DEFAULT_REDDIT_LISTING_TIME;

  return {
    feedName,
    listingSort,
    listingTime,
    routeKey: `${feedName}:${listingSort}:${redditListingSortUsesTime(listingSort) ? listingTime : ''}`,
    sourceSummary: formatRedditListingSummary(listingSort, listingTime),
  };
}

export function parseFeedRouteSpec(
  routeParam: string | undefined,
  searchParams: URLSearchParams = new URLSearchParams()
): FeedRouteSpec {
  const parts = splitRouteParam(routeParam);
  const queryTime = searchParams.get('t');
  const firstPart = parts[0];
  const secondPart = parts[1];
  const thirdPart = parts[2];

  if (parts.length === 1 && isRedditListingSort(firstPart)) {
    return createFeedRouteSpec(
      'random',
      firstPart,
      getCanonicalListingTime(firstPart, queryTime ?? thirdPart)
    );
  }

  const listingSort = isRedditListingSort(secondPart)
    ? secondPart
    : DEFAULT_REDDIT_LISTING_SORT;
  const listingTime = getCanonicalListingTime(listingSort, queryTime ?? thirdPart);

  return createFeedRouteSpec(firstPart, listingSort, listingTime);
}

export function getFeedRoutePath(input: FeedRoutePathInput): string {
  const feedName = normalizeFeedName(input.feedName);
  const listingSort = normalizeRedditListingSort(input.listingSort);
  const listingTime = normalizeRedditListingTime(input.listingTime);
  const params = new URLSearchParams();
  const path = `/feed/${feedName}/${listingSort}`;

  if (redditListingSortUsesTime(listingSort)) {
    params.set('t', listingTime);
  }

  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function getDefaultFeedRoutePath(feedName: string): string {
  return `/feed/${normalizeFeedName(feedName)}`;
}
