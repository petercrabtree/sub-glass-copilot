import type { FetchSpec } from '$lib/types';

export interface RedditListingResponse {
  kind: string;
  data: {
    after: string | null;
    before: string | null;
    dist: number;
    children: Array<{ kind: string; data: Record<string, unknown> }>;
  };
}

export interface RedditAboutResponse {
  kind: string;
  data: Record<string, unknown>;
}

const BASE = 'https://www.reddit.com';

function buildListingUrl(spec: FetchSpec, limit = 25): string {
  let path = spec.path;
  if (!path.endsWith('.json')) path = path + '.json';
  const params = new URLSearchParams({ raw_json: '1', limit: String(limit) });
  if (spec.after) params.set('after', spec.after);
  if (spec.time) params.set('t', spec.time);
  if (spec.query) params.set('q', spec.query);
  return `${BASE}${path}?${params.toString()}`;
}

export async function fetchListing(spec: FetchSpec, limit = 25): Promise<RedditListingResponse | null> {
  const url = buildListingUrl(spec, limit);
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    return json as RedditListingResponse;
  } catch {
    return null;
  }
}

export async function fetchSubredditAbout(subreddit: string): Promise<RedditAboutResponse | null> {
  try {
    const url = `${BASE}/r/${subreddit}/about.json?raw_json=1`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json() as RedditAboutResponse;
  } catch {
    return null;
  }
}

export async function fetchSubredditSidebar(subreddit: string): Promise<string | null> {
  try {
    const url = `${BASE}/r/${subreddit}/about.json?raw_json=1`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json() as RedditAboutResponse;
    return (json.data?.description as string) || (json.data?.public_description as string) || null;
  } catch {
    return null;
  }
}
