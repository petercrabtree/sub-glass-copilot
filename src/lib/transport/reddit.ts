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
  rateLimitRemaining?: number;
  rateLimitResetMs?: number;
  rateLimitUsed?: number;
  subredditUnavailableReason?: RedditSubredditUnavailableReason;
  subredditUnavailableDetail?: string;
}

export type RedditListingResult =
  | { ok: true; data: RedditListingResponse }
  | { ok: false; error: RedditRequestError };

export type RedditAboutResult =
  | { ok: true; data: RedditAboutResponse }
  | { ok: false; error: RedditRequestError };

export type RedditRequestPriority = 'interactive' | 'background';

export interface RedditRequestOptions {
  priority?: RedditRequestPriority;
}

export interface RedditDebugEntry {
  scope: 'listing' | 'about' | 'sidebar';
  url: string;
  fetchedAt: number;
  durationMs: number;
  waitedMs?: number;
  attempt?: number;
  retrying?: boolean;
  ok: boolean;
  status?: number;
  statusText?: string;
  contentType?: string;
  rateLimit?: RedditRateLimitHeaders;
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
  tooFast?: boolean;
  status?: number;
  url?: string;
  priority?: RedditRequestPriority;
  remaining?: number;
  resetMs?: number;
  used?: number;
  observedAt?: number;
  backgroundReserved?: boolean;
  backgroundReserveRequests?: number;
  backgroundReserveWaitMs?: number;
}

export interface RedditRateLimitHeaders {
  remaining?: number;
  resetMs?: number;
  used?: number;
  retryAfterMs?: number;
  exposedHeaderNames: string[];
}

const BASE = 'https://old.reddit.com';
const DEBUG_STORAGE_KEY = 'subglass:reddit-debug';
const RATE_LIMIT_STORAGE_KEY = 'subglass:reddit-rate-limit';
const TOO_FAST_HTTP_STATUSES = new Set([420, 429]);
const MIN_TOO_FAST_RETRY_MS = 5 * 1000;
const DEFAULT_TOO_FAST_RETRY_MS = 60 * 1000;
const MAX_TOO_FAST_RETRY_MS = 15 * 60 * 1000;
const REQUEST_SPACING_MS: Record<RedditRequestPriority, number> = {
  interactive: 2500,
  background: 15 * 1000,
};
// Background consumers share Reddit's browser-visible budget, so keep a foreground slice unspent.
const BACKGROUND_INTERACTIVE_RESERVE_PER_MINUTE = 10;
const BACKGROUND_INTERACTIVE_RESERVE_FRACTION = 0.15;
const BACKGROUND_INTERACTIVE_RESERVE_MAX_FRACTION = 0.5;
const BACKGROUND_RESERVE_RESET_BUFFER_MS = 1000;
const REQUEST_PRIORITY_RANK: Record<RedditRequestPriority, number> = {
  interactive: 0,
  background: 1,
};
const REQUEST_PRIORITIES: RedditRequestPriority[] = ['interactive', 'background'];
let redditRateLimitedUntil: Record<RedditRequestPriority, number> = {
  interactive: 0,
  background: 0,
};
let nextRedditRequestAt: Record<RedditRequestPriority, number> = {
  interactive: 0,
  background: 0,
};
let redditQueueSequence = 0;
let redditRequestActive = false;
let redditQueueTimer: ReturnType<typeof setTimeout> | undefined;
let redditRequestQueue: RedditQueuedRequest[] = [];
let lastRateLimitState: Record<RedditRequestPriority, RedditRateLimitState> = {
  interactive: createInactiveRateLimitState(),
  background: createInactiveRateLimitState(),
};

interface RedditRequestSlot {
  waitedMs: number;
  release: () => void;
}

interface RedditQueuedRequest {
  priority: RedditRequestPriority;
  sequence: number;
  queuedAt: number;
  resolve: (slot: RedditRequestSlot) => void;
}

function createInactiveRateLimitState(): RedditRateLimitState {
  return {
    active: false,
    until: 0,
    retryAfterMs: 0,
  };
}

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

function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());

  return undefined;
}

function parseFiniteHeaderNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (!raw) return undefined;

  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function readRateLimitHeaders(headers: Headers): RedditRateLimitHeaders {
  const resetSeconds = parseFiniteHeaderNumber(headers, 'x-ratelimit-reset');
  const exposedHeaderNames: string[] = [];
  headers.forEach((_, name) => {
    exposedHeaderNames.push(name);
  });

  return {
    remaining: parseFiniteHeaderNumber(headers, 'x-ratelimit-remaining'),
    resetMs: resetSeconds === undefined ? undefined : Math.max(0, Math.ceil(resetSeconds * 1000)),
    used: parseFiniteHeaderNumber(headers, 'x-ratelimit-used'),
    retryAfterMs: parseRetryAfterMs(headers),
    exposedHeaderNames,
  };
}

function getFallbackRetryMs(attempt: number): number {
  return Math.min(MAX_TOO_FAST_RETRY_MS, DEFAULT_TOO_FAST_RETRY_MS * (2 ** Math.min(attempt, 4)));
}

function readStoredRateLimitState(): Partial<Record<RedditRequestPriority, RedditRateLimitState>> {
  if (typeof window === 'undefined') return {};

  try {
    const raw = window.localStorage.getItem(RATE_LIMIT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as RedditRateLimitState | Partial<Record<RedditRequestPriority, RedditRateLimitState>>;
    if ('until' in parsed) {
      return {
        interactive: parsed,
        background: parsed,
      };
    }
    return parsed;
  } catch {
    return {};
  }
}

function writeStoredRateLimitState(): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(RATE_LIMIT_STORAGE_KEY, JSON.stringify(lastRateLimitState));
  } catch {
    // Ignore storage failures in private mode or restricted environments.
  }
}

function syncStoredRateLimitState(): void {
  const stored = readStoredRateLimitState();
  for (const priority of REQUEST_PRIORITIES) {
    const state = stored[priority];
    if (!state) continue;

    if ((state.observedAt ?? 0) > (lastRateLimitState[priority].observedAt ?? 0)) {
      lastRateLimitState[priority] = {
        ...lastRateLimitState[priority],
        ...state,
      };
    }

    if ((!state.active && !state.tooFast) || !state.until || state.until <= redditRateLimitedUntil[priority]) continue;

    const remainingMs = Math.max(0, state.until - Date.now());
    if (remainingMs <= 0) continue;

    redditRateLimitedUntil[priority] = state.until;
    lastRateLimitState[priority] = {
      ...state,
      active: true,
      retryAfterMs: remainingMs,
    };
  }
}

function rememberRateLimitStateForPriority(
  priority: RedditRequestPriority,
  state: RedditRateLimitState
): RedditRateLimitState {
  redditRateLimitedUntil[priority] = Math.max(redditRateLimitedUntil[priority], state.until);
  lastRateLimitState[priority] = {
    ...state,
    until: redditRateLimitedUntil[priority],
    retryAfterMs: Math.max(0, redditRateLimitedUntil[priority] - Date.now()),
  };
  return lastRateLimitState[priority];
}

function rememberRateLimitObservation(
  priority: RedditRequestPriority,
  rateLimit: RedditRateLimitHeaders,
  url: string
): boolean {
  if (
    rateLimit.remaining === undefined
    && rateLimit.resetMs === undefined
    && rateLimit.used === undefined
    && rateLimit.retryAfterMs === undefined
  ) {
    return false;
  }

  lastRateLimitState[priority] = {
    ...lastRateLimitState[priority],
    active: false,
    until: 0,
    retryAfterMs: 0,
    priority,
    url,
    remaining: rateLimit.remaining,
    resetMs: rateLimit.resetMs,
    used: rateLimit.used,
    observedAt: Date.now(),
  };
  return true;
}

function getLatestRateLimitObservation(): RedditRateLimitState | undefined {
  return REQUEST_PRIORITIES
    .map((priority) => lastRateLimitState[priority])
    .filter((state) => state.remaining !== undefined && state.resetMs !== undefined)
    .sort((a, b) => (b.observedAt ?? 0) - (a.observedAt ?? 0))[0];
}

function getBackgroundReserveRequests(state: RedditRateLimitState): number | undefined {
  if (state.remaining === undefined || state.resetMs === undefined || state.resetMs <= 0) return undefined;

  const windowMinutes = Math.max(1 / 60, state.resetMs / 60_000);
  const minuteReserve = Math.ceil(windowMinutes * BACKGROUND_INTERACTIVE_RESERVE_PER_MINUTE);
  const inferredLimit = state.used === undefined ? undefined : Math.max(0, state.remaining + state.used);
  const fractionalReserve = inferredLimit === undefined
    ? 0
    : Math.ceil(inferredLimit * BACKGROUND_INTERACTIVE_RESERVE_FRACTION);
  let reserve = Math.max(1, minuteReserve, fractionalReserve);

  if (inferredLimit !== undefined && inferredLimit > 0) {
    reserve = Math.min(
      reserve,
      Math.max(1, Math.floor(inferredLimit * BACKGROUND_INTERACTIVE_RESERVE_MAX_FRACTION))
    );
  }

  return reserve;
}

function getBackgroundReserveWaitMs(now = Date.now()): number {
  const state = getLatestRateLimitObservation();
  const reserve = state ? getBackgroundReserveRequests(state) : undefined;
  if (!state || reserve === undefined || state.remaining === undefined || state.resetMs === undefined) return 0;
  if (Math.floor(state.remaining) > reserve) return 0;

  const observedAt = state.observedAt ?? now;
  return Math.max(0, observedAt + state.resetMs - now + BACKGROUND_RESERVE_RESET_BUFFER_MS);
}

function rememberRateLimitResponse(
  res: Response,
  url: string,
  rateLimit: RedditRateLimitHeaders,
  priority: RedditRequestPriority,
  attempt = 0
): RedditRateLimitState | undefined {
  const recordedObservation = rememberRateLimitObservation(priority, rateLimit, url);

  const hasTooFastStatus = TOO_FAST_HTTP_STATUSES.has(res.status);
  const isBudgetExhausted = rateLimit.remaining !== undefined
    && rateLimit.remaining <= 0
    && rateLimit.resetMs !== undefined
    && rateLimit.resetMs > 0;
  const shouldCooldown = hasTooFastStatus || rateLimit.retryAfterMs !== undefined || isBudgetExhausted;
  if (!shouldCooldown) {
    if (rateLimit.remaining !== undefined && rateLimit.resetMs !== undefined && rateLimit.remaining > 0) {
      const pacedDelayMs = Math.ceil(rateLimit.resetMs / Math.max(1, Math.floor(rateLimit.remaining)));
      nextRedditRequestAt[priority] = Math.max(nextRedditRequestAt[priority], Date.now() + pacedDelayMs);
    }
    if (priority === 'background') {
      const reserveWaitMs = getBackgroundReserveWaitMs();
      if (reserveWaitMs > 0) {
        nextRedditRequestAt.background = Math.max(nextRedditRequestAt.background, Date.now() + reserveWaitMs);
      }
    }
    if (recordedObservation) writeStoredRateLimitState();
    return undefined;
  }

  const requestedRetryAfterMs = Math.max(
    MIN_TOO_FAST_RETRY_MS,
    rateLimit.retryAfterMs ?? rateLimit.resetMs ?? getFallbackRetryMs(attempt)
  );
  const until = Date.now() + requestedRetryAfterMs;
  const sharedState = {
    active: true,
    until,
    retryAfterMs: requestedRetryAfterMs,
    tooFast: hasTooFastStatus || rateLimit.retryAfterMs !== undefined,
    status: res.status,
    url,
    priority,
    remaining: rateLimit.remaining,
    resetMs: rateLimit.resetMs,
    used: rateLimit.used,
    observedAt: Date.now(),
  };
  for (const affectedPriority of REQUEST_PRIORITIES) {
    rememberRateLimitStateForPriority(affectedPriority, sharedState);
  }
  writeStoredRateLimitState();

  return lastRateLimitState[priority];
}

function rememberSyntheticRateLimit(
  url: string,
  attempt: number,
  cause: string | undefined,
  priority: RedditRequestPriority
): RedditRateLimitState {
  const requestedRetryAfterMs = getFallbackRetryMs(attempt);
  const until = Date.now() + requestedRetryAfterMs;
  const state = rememberRateLimitStateForPriority(priority, {
    active: true,
    until,
    retryAfterMs: requestedRetryAfterMs,
    tooFast: true,
    url,
  });
  writeStoredRateLimitState();
  console.warn('[reddit] network error; backing off before retrying same request', {
    url,
    priority,
    retryAfterMs: state.retryAfterMs,
    cause,
  });

  return state;
}

function getRedditQueueDelayMs(priority: RedditRequestPriority): number {
  syncStoredRateLimitState();
  const cooldownWaitMs = Math.max(0, redditRateLimitedUntil[priority] - Date.now());
  if (cooldownWaitMs <= 0 && lastRateLimitState[priority].active) {
    lastRateLimitState[priority] = {
      ...lastRateLimitState[priority],
      active: false,
      retryAfterMs: 0,
    };
  }
  const spacingWaitMs = Math.max(0, nextRedditRequestAt[priority] - Date.now());
  const reserveWaitMs = priority === 'background' ? getBackgroundReserveWaitMs() : 0;
  return Math.max(cooldownWaitMs, spacingWaitMs, reserveWaitMs);
}

function pickNextQueuedRequest(): RedditQueuedRequest | undefined {
  let bestIndex = -1;
  let bestRequest: RedditQueuedRequest | undefined;

  redditRequestQueue.forEach((request, index) => {
    if (getRedditQueueDelayMs(request.priority) > 0) return;

    if (!bestRequest) {
      bestIndex = index;
      bestRequest = request;
      return;
    }

    const requestRank = REQUEST_PRIORITY_RANK[request.priority];
    const bestRank = REQUEST_PRIORITY_RANK[bestRequest.priority];
    if (requestRank < bestRank || (requestRank === bestRank && request.sequence < bestRequest.sequence)) {
      bestIndex = index;
      bestRequest = request;
    }
  });

  if (bestIndex < 0) return undefined;

  redditRequestQueue.splice(bestIndex, 1);
  return bestRequest;
}

function scheduleRedditQueuePump(): void {
  if (redditRequestActive || redditRequestQueue.length === 0) return;

  clearTimeout(redditQueueTimer);
  const delayMs = Math.min(...redditRequestQueue.map((request) => getRedditQueueDelayMs(request.priority)));
  redditQueueTimer = setTimeout(pumpRedditRequestQueue, delayMs);
}

function pumpRedditRequestQueue(): void {
  if (redditRequestActive || redditRequestQueue.length === 0) return;

  const request = pickNextQueuedRequest();
  if (!request) {
    scheduleRedditQueuePump();
    return;
  }

  redditRequestActive = true;
  let released = false;
  request.resolve({
    waitedMs: Date.now() - request.queuedAt,
    release: () => {
      if (released) return;
      released = true;
      nextRedditRequestAt[request.priority] = Math.max(
        nextRedditRequestAt[request.priority],
        Date.now() + REQUEST_SPACING_MS[request.priority]
      );
      redditRequestActive = false;
      scheduleRedditQueuePump();
    },
  });
}

function acquireRedditRequestSlot(priority: RedditRequestPriority): Promise<RedditRequestSlot> {
  return new Promise((resolve) => {
    redditRequestQueue = [
      ...redditRequestQueue,
      {
        priority,
        sequence: redditQueueSequence++,
        queuedAt: Date.now(),
        resolve,
      },
    ];
    scheduleRedditQueuePump();
  });
}

export function readRedditRateLimitState(): RedditRateLimitState {
  syncStoredRateLimitState();
  let selectedPriority: RedditRequestPriority = 'interactive';
  let selectedRemainingMs = 0;

  for (const priority of REQUEST_PRIORITIES) {
    const remainingMs = Math.max(0, redditRateLimitedUntil[priority] - Date.now());
    if (remainingMs > selectedRemainingMs) {
      selectedPriority = priority;
      selectedRemainingMs = remainingMs;
    }
  }
  const latestObservation = getLatestRateLimitObservation();
  const backgroundReserveWaitMs = getBackgroundReserveWaitMs();
  const backgroundReserveRequests = latestObservation ? getBackgroundReserveRequests(latestObservation) : undefined;

  if (selectedRemainingMs <= 0) {
    const state = latestObservation ?? lastRateLimitState[selectedPriority];
    return {
      ...state,
      active: false,
      until: 0,
      retryAfterMs: 0,
      backgroundReserved: backgroundReserveWaitMs > 0,
      backgroundReserveRequests,
      backgroundReserveWaitMs,
    };
  }

  return {
    ...lastRateLimitState[selectedPriority],
    active: true,
    until: redditRateLimitedUntil[selectedPriority],
    retryAfterMs: selectedRemainingMs,
    backgroundReserved: backgroundReserveWaitMs > 0,
    backgroundReserveRequests,
    backgroundReserveWaitMs,
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
  } else if (entry.retrying || entry.error?.tooFast) {
    console.warn('[reddit]', entry.scope, entry.error ?? entry, `${entry.durationMs}ms`, entry.url);
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
        tooFast: Boolean(rateLimitState?.tooFast),
        retryAfterMs: rateLimitState?.retryAfterMs,
        rateLimitedUntil: rateLimitState?.until,
        rateLimitRemaining: rateLimitState?.remaining,
        rateLimitResetMs: rateLimitState?.resetMs,
        rateLimitUsed: rateLimitState?.used,
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

async function fetchRedditJsonWithRetry<T>(
  scope: RedditDebugEntry['scope'],
  url: string,
  networkErrorMessage: string,
  options: RedditRequestOptions = {}
): Promise<
  | { ok: true; data: T }
  | { ok: false; error: RedditRequestError }
> {
  const startedAt = Date.now();
  const priority = options.priority ?? 'background';
  let waitedMs = 0;
  let attempt = 0;
  let slot = await acquireRedditRequestSlot(priority);
  waitedMs += slot.waitedMs;

  try {
    while (true) {
      try {
        const res = await fetch(url, {
          headers: {
            accept: 'application/json'
          }
        });
        const rateLimit = readRateLimitHeaders(res.headers);
        const rateLimitState = rememberRateLimitResponse(res, url, rateLimit, priority, attempt);
        const parsed = await parseJsonResponse<T>(res, url, rateLimitState);
        const fetchedAt = Date.now();
        const retrying = !parsed.ok && parsed.error.tooFast;
        recordDebugEntry({
          scope,
          url,
          fetchedAt,
          durationMs: fetchedAt - startedAt,
          waitedMs,
          attempt: attempt + 1,
          retrying,
          ok: parsed.ok,
          status: res.status,
          statusText: res.statusText,
          contentType: res.headers.get('content-type') || undefined,
          rateLimit,
          error: parsed.ok ? undefined : parsed.error,
        });

        if (!retrying) return parsed;

        attempt += 1;
        slot.release();
        slot = await acquireRedditRequestSlot(priority);
        waitedMs += slot.waitedMs;
      } catch (error) {
        const cause = formatErrorCause(error);
        const rateLimitState = rememberSyntheticRateLimit(url, attempt, cause, priority);
        const fetchError = {
          ok: false,
          error: {
            kind: 'network',
            message: `${networkErrorMessage}; backing off before retrying`,
            url,
            cause,
            tooFast: true,
            retryAfterMs: rateLimitState.retryAfterMs,
            rateLimitedUntil: rateLimitState.until,
          },
        } as const;
        const fetchedAt = Date.now();
        recordDebugEntry({
          scope,
          url,
          fetchedAt,
          durationMs: fetchedAt - startedAt,
          waitedMs,
          attempt: attempt + 1,
          retrying: true,
          ok: false,
          error: fetchError.error,
        });
        attempt += 1;
        slot.release();
        slot = await acquireRedditRequestSlot(priority);
        waitedMs += slot.waitedMs;
      }
    }
  } finally {
    slot.release();
  }
}

export async function fetchListing(
  spec: FetchSpec,
  limit = 25,
  options: RedditRequestOptions = {}
): Promise<RedditListingResult> {
  const url = buildListingUrl(spec, limit);
  return fetchRedditJsonWithRetry<RedditListingResponse>(
    'listing',
    url,
    'Network error while fetching Reddit JSON',
    { priority: options.priority ?? 'interactive' }
  );
}

export async function fetchSubredditAboutResult(
  subreddit: string,
  options: RedditRequestOptions = {}
): Promise<RedditAboutResult> {
  const url = `${getBaseUrl()}${withJsonPath(`/r/${subreddit}/about`)}?raw_json=1`;
  return fetchRedditJsonWithRetry<RedditAboutResponse>(
    'about',
    url,
    'Network error while fetching subreddit profile',
    { priority: options.priority ?? 'background' }
  );
}

export async function fetchSubredditAbout(subreddit: string): Promise<RedditAboutResponse | null> {
  const result = await fetchSubredditAboutResult(subreddit);
  return result.ok ? result.data : null;
}

export async function fetchSubredditSidebar(
  subreddit: string,
  options: RedditRequestOptions = {}
): Promise<string | null> {
  const url = `${getBaseUrl()}${withJsonPath(`/r/${subreddit}/about`)}?raw_json=1`;
  const parsed = await fetchRedditJsonWithRetry<RedditAboutResponse>(
    'sidebar',
    url,
    'Network error while fetching subreddit sidebar',
    { priority: options.priority ?? 'background' }
  );
  if (!parsed.ok) return null;
  const json = parsed.data;
  return (json.data?.description as string) || (json.data?.public_description as string) || null;
}
