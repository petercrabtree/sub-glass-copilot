import { getCacheEntry, getPostsByIds, setCacheEntry } from '$lib/db/store';
import {
  getCanonicalListingTime,
  isRedditListingSort,
  normalizeRedditListingSort,
} from '$lib/reddit/listing';
import type { FetchSpec, PostRecord, RedditListingSort, RedditListingTime } from '$lib/types';

const LISTING_CACHE_PREFIX = 'reddit-listing:v1';
const DEFAULT_LIMIT = 25;

export interface ListingCacheHit {
  specKey: string;
  fetchedAt: number;
  ageMs: number;
  ttlMs: number;
  after: string | null;
  posts: PostRecord[];
  postIds: string[];
}

export interface ListingCacheReadOptions {
  maxAgeMs?: number;
  allowStale?: boolean;
}

function getBaseCacheScope(): string {
  const configuredBase = import.meta.env.VITE_SUBGLASS_REDDIT_BASE_URL as string | undefined;
  return configuredBase?.replace(/\/+$/, '') || 'https://old.reddit.com';
}

function withJsonPath(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  if (normalized.endsWith('/.json') || normalized.endsWith('.json')) return normalized;
  if (normalized.endsWith('/')) return `${normalized}.json`;
  return `${normalized}/.json`;
}

function getPathListingSort(path: string): RedditListingSort | undefined {
  const pathOnly = path.split('?')[0];
  const cleanPath = pathOnly
    .replace(/\/\.json$/i, '')
    .replace(/\.json$/i, '');
  const lastSegment = cleanPath
    .split('/')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .at(-1);

  return isRedditListingSort(lastSegment) ? lastSegment : undefined;
}

function resolveListingSort(spec: FetchSpec): RedditListingSort {
  return normalizeRedditListingSort(spec.sort ?? getPathListingSort(spec.path), 'hot');
}

function resolveListingTime(spec: FetchSpec): RedditListingTime | undefined {
  const sort = resolveListingSort(spec);
  return getCanonicalListingTime(sort, spec.time);
}

function buildListingCacheUrl(spec: FetchSpec, limit = DEFAULT_LIMIT): string {
  const params = new URLSearchParams({ raw_json: '1', limit: String(limit) });
  if (spec.after) params.set('after', spec.after);
  if (spec.time) params.set('t', spec.time);
  if (spec.query) params.set('q', spec.query);
  return `${getBaseCacheScope()}${withJsonPath(spec.path)}?${params.toString()}`;
}

export function getListingCacheKey(spec: FetchSpec, limit = DEFAULT_LIMIT): string {
  return `${LISTING_CACHE_PREFIX}:${buildListingCacheUrl(spec, limit)}`;
}

export function getListingCacheTtlMs(spec: FetchSpec): number {
  const sort = resolveListingSort(spec);
  const time = resolveListingTime(spec);

  if (sort === 'new') return 5 * 60 * 1000;
  if (sort === 'hot' || sort === 'rising') return 10 * 60 * 1000;
  if (time === 'hour' || time === 'day') return 30 * 60 * 1000;
  if (time === 'week') return 2 * 60 * 60 * 1000;
  return 12 * 60 * 60 * 1000;
}

export async function readCachedListingPosts(
  spec: FetchSpec,
  limit = DEFAULT_LIMIT,
  options: ListingCacheReadOptions = {}
): Promise<ListingCacheHit | null> {
  const specKey = getListingCacheKey(spec, limit);
  const entry = await getCacheEntry(specKey);
  if (!entry) return null;

  const ttlMs = options.maxAgeMs ?? getListingCacheTtlMs(spec);
  const ageMs = Date.now() - entry.fetchedAt;
  if (!options.allowStale && ageMs > ttlMs) return null;

  const posts = entry.postIds.length > 0 ? await getPostsByIds(entry.postIds) : [];
  if (posts.length !== entry.postIds.length) return null;

  return {
    specKey,
    fetchedAt: entry.fetchedAt,
    ageMs,
    ttlMs,
    after: entry.after ?? null,
    posts,
    postIds: entry.postIds,
  };
}

export async function writeListingCache(
  spec: FetchSpec,
  posts: PostRecord[],
  after: string | null | undefined,
  limit = DEFAULT_LIMIT
): Promise<void> {
  await setCacheEntry({
    specKey: getListingCacheKey(spec, limit),
    fetchedAt: Date.now(),
    after: after ?? undefined,
    postIds: posts.map((post) => post.id),
  });
}
