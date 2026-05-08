import type { AdjacencyLink, SignalEvent, SubredditAvailabilityStatus, SubredditRecord } from '$lib/types';

const UNAVAILABLE_STATUSES = new Set<SubredditAvailabilityStatus>([
  'banned',
  'private',
  'quarantined',
  'not_found',
]);

export const DEFAULT_PROFILE_SCAN_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const PROFILE_SCAN_FAILURE_COOLDOWN_MS = 15 * 60 * 1000;

export type SubredditHealthStatus =
  | 'healthy'
  | 'stale'
  | 'unscanned'
  | 'failed'
  | 'unavailable'
  | 'muted';

export interface SubredditSignalSummary {
  subreddit: string;
  impressions: number;
  advances: number;
  dwellMs: number;
  dwellEvents: number;
  dwellScore: number;
  opens: number;
  explicitRatings: number;
  lastEventAt?: number;
}

export interface SubredditAdjacencySummary {
  subreddit: string;
  incomingWeight: number;
  outgoingWeight: number;
  linkCount: number;
}

export interface ScanPriorityCandidate {
  sub: SubredditRecord;
  score: number;
  status: SubredditHealthStatus;
  reasons: string[];
  profileAgeMs?: number;
  lastSignalAt?: number;
}

export interface ScanPriorityOptions {
  now?: number;
  staleAfterMs?: number;
  limit?: number;
  includeFresh?: boolean;
  includeUnavailable?: boolean;
  includeRecentlyFailed?: boolean;
}

function normalizeSubredditName(name: string): string {
  return name.trim().replace(/^\/?r\//i, '').toLowerCase();
}

function isScanTargetName(name: string): boolean {
  return Boolean(name) && name !== 'all' && /^[a-z0-9_]{2,21}$/i.test(name);
}

function isUnavailableStatus(status: SubredditAvailabilityStatus | undefined): boolean {
  return Boolean(status && UNAVAILABLE_STATUSES.has(status));
}

function formatCompactNumber(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

function getSignalSummary(
  summaries: Map<string, SubredditSignalSummary>,
  subreddit: string
): SubredditSignalSummary {
  const normalized = normalizeSubredditName(subreddit);
  const existing = summaries.get(normalized);
  if (existing) return existing;

  const summary: SubredditSignalSummary = {
    subreddit: normalized,
    impressions: 0,
    advances: 0,
    dwellMs: 0,
    dwellEvents: 0,
    dwellScore: 0,
    opens: 0,
    explicitRatings: 0,
  };
  summaries.set(normalized, summary);
  return summary;
}

function getAdjacencySummary(
  summaries: Map<string, SubredditAdjacencySummary>,
  subreddit: string
): SubredditAdjacencySummary {
  const normalized = normalizeSubredditName(subreddit);
  const existing = summaries.get(normalized);
  if (existing) return existing;

  const summary: SubredditAdjacencySummary = {
    subreddit: normalized,
    incomingWeight: 0,
    outgoingWeight: 0,
    linkCount: 0,
  };
  summaries.set(normalized, summary);
  return summary;
}

export function buildSubredditSignalSummaries(events: SignalEvent[]): Map<string, SubredditSignalSummary> {
  const summaries = new Map<string, SubredditSignalSummary>();

  for (const event of events) {
    if (!event.subreddit) continue;

    const summary = getSignalSummary(summaries, event.subreddit);
    summary.lastEventAt = Math.max(summary.lastEventAt ?? 0, event.ts);

    if (event.type === 'impression') {
      summary.impressions += 1;
    } else if (event.type === 'advance_next') {
      summary.advances += 1;
    } else if (event.type === 'dwell' && typeof event.value === 'number') {
      summary.dwellMs += Math.max(0, event.value);
      summary.dwellEvents += 1;
    } else if (event.type === 'dwell_score' && typeof event.value === 'number') {
      summary.dwellScore += event.value;
    } else if (event.type === 'open_reddit' || event.type === 'open_media') {
      summary.opens += 1;
    } else if (event.type === 'rating_explicit') {
      summary.explicitRatings += 1;
    }
  }

  return summaries;
}

export function buildSubredditAdjacencySummaries(
  links: AdjacencyLink[]
): Map<string, SubredditAdjacencySummary> {
  const summaries = new Map<string, SubredditAdjacencySummary>();

  for (const link of links) {
    const weight = Math.max(0.1, link.weight ?? 1);
    const from = getAdjacencySummary(summaries, link.fromSubreddit);
    from.outgoingWeight += weight;
    from.linkCount += 1;

    const to = getAdjacencySummary(summaries, link.toSubreddit);
    to.incomingWeight += weight;
    to.linkCount += 1;
  }

  return summaries;
}

export function getSubredditHealthStatus(
  sub: SubredditRecord,
  now = Date.now(),
  staleAfterMs = DEFAULT_PROFILE_SCAN_STALE_AFTER_MS
): SubredditHealthStatus {
  if (sub.isMuted || sub.discoveryStatus === 'muted') return 'muted';
  if (isUnavailableStatus(sub.availabilityStatus)) return 'unavailable';
  if (sub.discoveryStatus === 'failed' || sub.profileFetchError) return 'failed';
  if (!sub.profileFetchedAt) return 'unscanned';
  if (now - sub.profileFetchedAt > staleAfterMs) return 'stale';
  return 'healthy';
}

export function scoreSubredditForProfileScan(
  sub: SubredditRecord,
  signalSummaries = new Map<string, SubredditSignalSummary>(),
  adjacencySummaries = new Map<string, SubredditAdjacencySummary>(),
  options: ScanPriorityOptions = {}
): ScanPriorityCandidate | null {
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_PROFILE_SCAN_STALE_AFTER_MS;
  const normalizedName = normalizeSubredditName(sub.name);

  if (!isScanTargetName(normalizedName)) return null;
  if (sub.isMuted || sub.discoveryStatus === 'muted') return null;
  if (isUnavailableStatus(sub.availabilityStatus) && !options.includeUnavailable) return null;
  if (
    sub.profileFetchFailedAt &&
    now - sub.profileFetchFailedAt < PROFILE_SCAN_FAILURE_COOLDOWN_MS &&
    !options.includeRecentlyFailed
  ) {
    return null;
  }

  const status = getSubredditHealthStatus(sub, now, staleAfterMs);
  const profileAgeMs = sub.profileFetchedAt ? Math.max(0, now - sub.profileFetchedAt) : undefined;
  const due = !sub.profileFetchedAt || Boolean(profileAgeMs && profileAgeMs > staleAfterMs);
  if (!due && !options.includeFresh) return null;

  const signals = signalSummaries.get(normalizedName);
  const adjacency = adjacencySummaries.get(normalizedName);
  const reasons: string[] = [];
  let score = 0;

  if (!sub.profileFetchedAt) {
    score += 60;
    reasons.push('unscanned');
  } else if (profileAgeMs) {
    const staleRatio = Math.min(3, profileAgeMs / staleAfterMs);
    score += 18 + staleRatio * 8;
    reasons.push(`stale ${Math.max(1, Math.round(profileAgeMs / 86400000))}d`);
  }

  if (!sub.availabilityCheckedAt || sub.availabilityStatus === 'unknown') {
    score += 8;
    reasons.push('availability unknown');
  }

  if (sub.profileFetchError || sub.discoveryStatus === 'failed') {
    score += 6;
    reasons.push('previous failure');
  }

  const rating = sub.localRating ?? 0;
  if (rating !== 0) {
    const ratingScore = rating > 0 ? rating * 9 : rating * 3;
    score += ratingScore;
    reasons.push(`rating ${rating > 0 ? '+' : ''}${Number(rating.toFixed(2))}`);
  }

  if (signals) {
    const dwellSeconds = signals.dwellMs / 1000;
    if (dwellSeconds > 0) {
      score += Math.min(20, Math.log2(dwellSeconds + 1) * 3);
      reasons.push(`dwell ${formatCompactNumber(dwellSeconds)}s`);
    }

    if (signals.dwellScore !== 0) {
      score += Math.max(-8, Math.min(14, signals.dwellScore * 18));
      reasons.push(`passive ${signals.dwellScore > 0 ? '+' : ''}${signals.dwellScore.toFixed(2)}`);
    }

    if (signals.opens > 0) {
      score += Math.min(12, signals.opens * 4);
      reasons.push(`${signals.opens} opens`);
    }

    if (signals.explicitRatings > 0) {
      score += Math.min(10, signals.explicitRatings * 3);
      reasons.push(`${signals.explicitRatings} ratings`);
    }

    if (signals.lastEventAt && now - signals.lastEventAt < 24 * 60 * 60 * 1000) {
      score += 4;
      reasons.push('recently active');
    }
  }

  if (adjacency && adjacency.linkCount > 0) {
    const adjacencyScore = Math.min(
      16,
      Math.sqrt(adjacency.incomingWeight + adjacency.outgoingWeight) * 2.4
    );
    score += adjacencyScore;
    reasons.push(`${adjacency.linkCount} graph links`);
  }

  if (sub.isNsfw === undefined) {
    score += 3;
    reasons.push('nsfw unknown');
  }

  return {
    sub,
    score,
    status,
    reasons,
    profileAgeMs,
    lastSignalAt: signals?.lastEventAt,
  };
}

export function prioritizeProfileScanCandidates(
  subreddits: SubredditRecord[],
  events: SignalEvent[] = [],
  adjacency: AdjacencyLink[] = [],
  options: ScanPriorityOptions = {}
): ScanPriorityCandidate[] {
  const signalSummaries = buildSubredditSignalSummaries(events);
  const adjacencySummaries = buildSubredditAdjacencySummaries(adjacency);
  const candidates = subreddits
    .map((sub) => scoreSubredditForProfileScan(sub, signalSummaries, adjacencySummaries, options))
    .filter((candidate): candidate is ScanPriorityCandidate => candidate !== null)
    .sort((a, b) =>
      b.score - a.score ||
      (a.sub.profileFetchedAt ?? 0) - (b.sub.profileFetchedAt ?? 0) ||
      a.sub.name.localeCompare(b.sub.name)
    );

  return options.limit ? candidates.slice(0, options.limit) : candidates;
}
