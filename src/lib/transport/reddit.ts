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

export interface RedditRequestError {
  kind: 'network' | 'http' | 'parse';
  message: string;
  url: string;
  status?: number;
  statusText?: string;
  contentType?: string;
  cause?: string;
  responseSnippet?: string;
}

export type RedditListingResult =
  | { ok: true; data: RedditListingResponse }
  | { ok: false; error: RedditRequestError };

export interface RedditDebugEntry {
  scope: 'listing' | 'about' | 'sidebar';
  url: string;
  fetchedAt: number;
  durationMs: number;
  ok: boolean;
  status?: number;
  statusText?: string;
  contentType?: string;
  error?: RedditRequestError;
}

export interface RedditDebugState {
  lastUpdatedAt: number;
  lastEntry: RedditDebugEntry;
  recent: RedditDebugEntry[];
}

const BASE = 'https://old.reddit.com';
const DEBUG_STORAGE_KEY = 'subglass:reddit-debug';

function withJsonPath(path: string): string {
  if (path.endsWith('/.json') || path.endsWith('.json')) return path;
  if (path.endsWith('/')) return `${path}.json`;
  return `${path}/.json`;
}

function summarizeResponseBody(body: string): string | undefined {
  const summary = body.replace(/\s+/g, ' ').trim();
  if (!summary) return undefined;
  return summary.slice(0, 400);
}

function formatErrorCause(error: unknown): string | undefined {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  return undefined;
}

function recordDebugEntry(entry: RedditDebugEntry): void {
  if (typeof window === 'undefined') return;

  const globalScope = globalThis as typeof globalThis & {
    __SUBGLASS_REDDIT_DEBUG__?: RedditDebugState;
  };

  const recent = [entry, ...(globalScope.__SUBGLASS_REDDIT_DEBUG__?.recent || [])].slice(0, 12);
  const state: RedditDebugState = {
    lastUpdatedAt: entry.fetchedAt,
    lastEntry: entry,
    recent,
  };

  globalScope.__SUBGLASS_REDDIT_DEBUG__ = state;

  try {
    window.localStorage.setItem(DEBUG_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage failures in private mode or restricted environments.
  }

  if (entry.ok) {
    console.info('[reddit]', entry.scope, entry.status ?? 200, `${entry.durationMs}ms`, entry.url);
  } else {
    console.error('[reddit]', entry.scope, entry.error ?? entry, `${entry.durationMs}ms`, entry.url);
  }
}

export function readRedditDebugState(): RedditDebugState | null {
  if (typeof window === 'undefined') return null;

  const globalScope = globalThis as typeof globalThis & {
    __SUBGLASS_REDDIT_DEBUG__?: RedditDebugState;
  };

  if (globalScope.__SUBGLASS_REDDIT_DEBUG__) return globalScope.__SUBGLASS_REDDIT_DEBUG__;

  try {
    const raw = window.localStorage.getItem(DEBUG_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RedditDebugState;
    globalScope.__SUBGLASS_REDDIT_DEBUG__ = parsed;
    return parsed;
  } catch {
    return null;
  }
}

async function parseJsonResponse<T>(res: Response, url: string): Promise<
  | { ok: true; data: T }
  | { ok: false; error: RedditRequestError }
> {
  const contentType = res.headers.get('content-type') || undefined;
  const body = await res.text();
  const responseSnippet = summarizeResponseBody(body);

  if (!res.ok) {
    return {
      ok: false,
      error: {
        kind: 'http',
        message: `Reddit HTTP ${res.status} ${res.statusText}`,
        url,
        status: res.status,
        statusText: res.statusText,
        contentType,
        responseSnippet,
      },
    };
  }

  try {
    return { ok: true, data: JSON.parse(body) as T };
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: 'parse',
        message: 'Failed to parse Reddit JSON response',
        url,
        contentType,
        cause: formatErrorCause(error),
        responseSnippet,
      },
    };
  }
}

function buildListingUrl(spec: FetchSpec, limit = 25): string {
  const path = withJsonPath(spec.path);
  const params = new URLSearchParams({ raw_json: '1', limit: String(limit) });
  if (spec.after) params.set('after', spec.after);
  if (spec.time) params.set('t', spec.time);
  if (spec.query) params.set('q', spec.query);
  return `${BASE}${path}?${params.toString()}`;
}

export async function fetchListing(spec: FetchSpec, limit = 25): Promise<RedditListingResult> {
  const url = buildListingUrl(spec, limit);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json'
      }
    });
    const parsed = await parseJsonResponse<RedditListingResponse>(res, url);
    const fetchedAt = Date.now();
    recordDebugEntry({
      scope: 'listing',
      url,
      fetchedAt,
      durationMs: fetchedAt - startedAt,
      ok: parsed.ok,
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get('content-type') || undefined,
      error: parsed.ok ? undefined : parsed.error,
    });
    return parsed;
  } catch (error) {
    const fetchError = {
      ok: false,
      error: {
        kind: 'network',
        message: 'Network error while fetching Reddit JSON',
        url,
        cause: formatErrorCause(error),
      },
    } as const;
    const fetchedAt = Date.now();
    recordDebugEntry({
      scope: 'listing',
      url,
      fetchedAt,
      durationMs: fetchedAt - startedAt,
      ok: false,
      error: fetchError.error,
    });
    return fetchError;
  }
}

export async function fetchSubredditAbout(subreddit: string): Promise<RedditAboutResponse | null> {
  const startedAt = Date.now();
  try {
    const url = `${BASE}${withJsonPath(`/r/${subreddit}/about`)}?raw_json=1`;
    const res = await fetch(url, {
      headers: {
        accept: 'application/json'
      }
    });
    const parsed = await parseJsonResponse<RedditAboutResponse>(res, url);
    const fetchedAt = Date.now();
    recordDebugEntry({
      scope: 'about',
      url,
      fetchedAt,
      durationMs: fetchedAt - startedAt,
      ok: parsed.ok,
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get('content-type') || undefined,
      error: parsed.ok ? undefined : parsed.error,
    });
    return parsed.ok ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function fetchSubredditSidebar(subreddit: string): Promise<string | null> {
  const startedAt = Date.now();
  try {
    const url = `${BASE}${withJsonPath(`/r/${subreddit}/about`)}?raw_json=1`;
    const res = await fetch(url, {
      headers: {
        accept: 'application/json'
      }
    });
    const parsed = await parseJsonResponse<RedditAboutResponse>(res, url);
    const fetchedAt = Date.now();
    recordDebugEntry({
      scope: 'sidebar',
      url,
      fetchedAt,
      durationMs: fetchedAt - startedAt,
      ok: parsed.ok,
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get('content-type') || undefined,
      error: parsed.ok ? undefined : parsed.error,
    });
    if (!parsed.ok) return null;
    const json = parsed.data;
    return (json.data?.description as string) || (json.data?.public_description as string) || null;
  } catch {
    return null;
  }
}
