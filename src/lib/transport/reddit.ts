import type { FetchSpec } from '$lib/types';

export type RedditSubredditUnavailableReason = 'banned' | 'private' | 'quarantined' | 'not_found';

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
  tooFast?: boolean;
  retryAfterMs?: number;
  rateLimitedUntil?: number;
  subredditUnavailableReason?: RedditSubredditUnavailableReason;
  subredditUnavailableDetail?: string;
}

export type RedditListingResult =
  | { ok: true; data: RedditListingResponse }
  | { ok: false; error: RedditRequestError };

export type RedditAboutResult =
  | { ok: true; data: RedditAboutResponse }
  | { ok: false; error: RedditRequestError };

export interface RedditDebugEntry {
  scope: 'listing' | 'about' | 'sidebar';
  url: string;
  fetchedAt: number;
  durationMs: number;
  waitedMs?: number;
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

export interface RedditRateLimitState {
  active: boolean;
  until: number;
  retryAfterMs: number;
  status?: number;
  url?: string;
}

const BASE = 'https://old.reddit.com';
const DEBUG_STORAGE_KEY = 'subglass:reddit-debug';
const TOO_FAST_HTTP_STATUSES = new Set([420, 429]);
const DEFAULT_TOO_FAST_RETRY_MS = 60 * 1000;
let redditRateLimitedUntil = 0;
let lastRateLimitState: RedditRateLimitState = {
  active: false,
  until: 0,
  retryAfterMs: 0,
};

function getBaseUrl(): string {
  const configuredBase = import.meta.env.VITE_SUBGLASS_REDDIT_BASE_URL as string | undefined;
  return configuredBase?.replace(/\/+$/, '') || BASE;
}

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeUnavailableReason(value: unknown): RedditSubredditUnavailableReason | undefined {
  const raw = asString(value)?.toLowerCase().replace(/[\s-]+/g, '_');
  if (!raw) return undefined;
  if (raw.includes('ban')) return 'banned';
  if (raw.includes('private')) return 'private';
  if (raw.includes('quarantine')) return 'quarantined';
  if (raw === 'not_found' || raw === 'notfound' || raw.includes('not_found') || raw.includes('does_not_exist')) {
    return 'not_found';
  }
  return undefined;
}

function parseErrorJson(body: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(body));
  } catch {
    return undefined;
  }
}

function findUnavailableReasonInJson(record: Record<string, unknown> | undefined): RedditSubredditUnavailableReason | undefined {
  if (!record) return undefined;

  const direct = normalizeUnavailableReason(record.reason)
    ?? normalizeUnavailableReason(record.error)
    ?? normalizeUnavailableReason(record.error_type);
  if (direct) return direct;

  const nested = asRecord(record.data) ?? asRecord(record.response);
  return findUnavailableReasonInJson(nested);
}

function findErrorDetailInJson(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined;
  return asString(record.message)
    ?? asString(record.reason)
    ?? asString(record.error)
    ?? findErrorDetailInJson(asRecord(record.data))
    ?? findErrorDetailInJson(asRecord(record.response));
}

function inferUnavailableReasonFromBody(body: string): RedditSubredditUnavailableReason | undefined {
  const normalized = body.toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return undefined;
  if (normalized.includes('subreddit') && normalized.includes('banned')) return 'banned';
  if (normalized.includes('private community') || normalized.includes('private subreddit')) return 'private';
  if (normalized.includes('quarantined')) return 'quarantined';
  if (
    normalized.includes("there doesn't seem to be anything here")
    || normalized.includes('page not found')
    || normalized.includes('subreddit does not exist')
  ) {
    return 'not_found';
  }
  return undefined;
}

function classifyUnavailableResponse(
  res: Response,
  body: string
): { reason?: RedditSubredditUnavailableReason; detail?: string } {
  const parsed = parseErrorJson(body);
  const reason = findUnavailableReasonInJson(parsed)
    ?? inferUnavailableReasonFromBody(body)
    ?? (res.status === 404 ? 'not_found' : undefined);

  return {
    reason,
    detail: findErrorDetailInJson(parsed),
  };
}

function formatErrorCause(error: unknown): string | undefined {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());

  return undefined;
}

function rememberTooFastResponse(res: Response, url: string): RedditRateLimitState | undefined {
  const retryAfterMsFromHeader = parseRetryAfterMs(res.headers);
  if (!TOO_FAST_HTTP_STATUSES.has(res.status) && retryAfterMsFromHeader === undefined) return undefined;

  const retryAfterMs = retryAfterMsFromHeader ?? DEFAULT_TOO_FAST_RETRY_MS;
  const until = Date.now() + retryAfterMs;
  redditRateLimitedUntil = Math.max(redditRateLimitedUntil, until);
  lastRateLimitState = {
    active: true,
    until: redditRateLimitedUntil,
    retryAfterMs,
    status: res.status,
    url,
  };

  return lastRateLimitState;
}

async function waitForRedditCooldown(): Promise<number> {
  const waitMs = Math.max(0, redditRateLimitedUntil - Date.now());
  if (waitMs <= 0) {
    if (lastRateLimitState.active) {
      lastRateLimitState = {
        ...lastRateLimitState,
        active: false,
        retryAfterMs: 0,
      };
    }
    return 0;
  }

  await sleep(waitMs);
  return waitMs;
}

export function readRedditRateLimitState(): RedditRateLimitState {
  const remainingMs = Math.max(0, redditRateLimitedUntil - Date.now());
  if (remainingMs <= 0) {
    return {
      ...lastRateLimitState,
      active: false,
      retryAfterMs: 0,
    };
  }

  return {
    ...lastRateLimitState,
    active: true,
    until: redditRateLimitedUntil,
    retryAfterMs: remainingMs,
  };
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

async function parseJsonResponse<T>(
  res: Response,
  url: string,
  rateLimitState?: RedditRateLimitState
): Promise<
  | { ok: true; data: T }
  | { ok: false; error: RedditRequestError }
> {
  const contentType = res.headers.get('content-type') || undefined;
  const body = await res.text();
  const responseSnippet = summarizeResponseBody(body);

  if (!res.ok) {
    const unavailable = classifyUnavailableResponse(res, body);
    return {
      ok: false,
      error: {
        kind: 'http',
        message: rateLimitState?.active
          ? `Reddit HTTP ${res.status} ${res.statusText}; waiting before more requests`
          : `Reddit HTTP ${res.status} ${res.statusText}`,
        url,
        status: res.status,
        statusText: res.statusText,
        contentType,
        responseSnippet,
        tooFast: Boolean(rateLimitState?.active),
        retryAfterMs: rateLimitState?.retryAfterMs,
        rateLimitedUntil: rateLimitState?.until,
        subredditUnavailableReason: unavailable.reason,
        subredditUnavailableDetail: unavailable.detail,
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
  return `${getBaseUrl()}${path}?${params.toString()}`;
}

export async function fetchListing(spec: FetchSpec, limit = 25): Promise<RedditListingResult> {
  const url = buildListingUrl(spec, limit);
  const startedAt = Date.now();
  const waitedMs = await waitForRedditCooldown();
  try {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json'
      }
    });
    const rateLimitState = rememberTooFastResponse(res, url);
    const parsed = await parseJsonResponse<RedditListingResponse>(res, url, rateLimitState);
    const fetchedAt = Date.now();
    recordDebugEntry({
      scope: 'listing',
      url,
      fetchedAt,
      durationMs: fetchedAt - startedAt,
      waitedMs,
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
      waitedMs,
      ok: false,
      error: fetchError.error,
    });
    return fetchError;
  }
}

export async function fetchSubredditAboutResult(subreddit: string): Promise<RedditAboutResult> {
  const startedAt = Date.now();
  const url = `${getBaseUrl()}${withJsonPath(`/r/${subreddit}/about`)}?raw_json=1`;
  const waitedMs = await waitForRedditCooldown();
  try {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json'
      }
    });
    const rateLimitState = rememberTooFastResponse(res, url);
    const parsed = await parseJsonResponse<RedditAboutResponse>(res, url, rateLimitState);
    const fetchedAt = Date.now();
    recordDebugEntry({
      scope: 'about',
      url,
      fetchedAt,
      durationMs: fetchedAt - startedAt,
      waitedMs,
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
        message: 'Network error while fetching subreddit profile',
        url,
        cause: formatErrorCause(error),
      },
    } as const;
    const fetchedAt = Date.now();
    recordDebugEntry({
      scope: 'about',
      url,
      fetchedAt,
      durationMs: fetchedAt - startedAt,
      waitedMs,
      ok: false,
      error: fetchError.error,
    });
    return fetchError;
  }
}

export async function fetchSubredditAbout(subreddit: string): Promise<RedditAboutResponse | null> {
  const result = await fetchSubredditAboutResult(subreddit);
  return result.ok ? result.data : null;
}

export async function fetchSubredditSidebar(subreddit: string): Promise<string | null> {
  const startedAt = Date.now();
  const url = `${getBaseUrl()}${withJsonPath(`/r/${subreddit}/about`)}?raw_json=1`;
  const waitedMs = await waitForRedditCooldown();
  try {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json'
      }
    });
    const rateLimitState = rememberTooFastResponse(res, url);
    const parsed = await parseJsonResponse<RedditAboutResponse>(res, url, rateLimitState);
    const fetchedAt = Date.now();
    recordDebugEntry({
      scope: 'sidebar',
      url,
      fetchedAt,
      durationMs: fetchedAt - startedAt,
      waitedMs,
      ok: parsed.ok,
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get('content-type') || undefined,
      error: parsed.ok ? undefined : parsed.error,
    });
    if (!parsed.ok) return null;
    const json = parsed.data;
    return (json.data?.description as string) || (json.data?.public_description as string) || null;
  } catch (error) {
    const fetchError = {
      kind: 'network',
      message: 'Network error while fetching subreddit sidebar',
      url,
      cause: formatErrorCause(error),
    } satisfies RedditRequestError;
    const fetchedAt = Date.now();
    recordDebugEntry({
      scope: 'sidebar',
      url,
      fetchedAt,
      durationMs: fetchedAt - startedAt,
      waitedMs,
      ok: false,
      error: fetchError,
    });
    return null;
  }
}
