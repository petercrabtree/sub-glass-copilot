import { extractLinksFromDescription } from '$lib/adjacency/extract';
import {
  getSubreddit,
  getSubredditsDueForProfileScan,
  markSubredditUnavailable,
  markSubredditProfileFailed,
  upsertAdjacency,
  upsertSubreddit,
} from '$lib/db/store';
import { fetchSubredditAboutResult } from '$lib/transport/reddit';
import type { AdjacencyLink, SubredditAvailabilityStatus, SubredditRecord } from '$lib/types';

export interface SubredditProfileScanResult {
  name: string;
  ok: boolean;
  linksDiscovered: number;
  error?: string;
  tooFast?: boolean;
  rateLimitedUntil?: number;
  availabilityStatus?: SubredditAvailabilityStatus;
}

function normalizeSubredditName(name: string): string {
  return name.trim().replace(/^\/?r\//i, '').toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function buildDiscoveredRecord(
  name: string,
  discoveredVia?: string,
  discoveryReason?: string
): SubredditRecord {
  const normalizedName = normalizeSubredditName(name);
  return {
    name: normalizedName,
    prefixedName: `r/${normalizedName}`,
    firstSeenAt: Date.now(),
    localRating: 0,
    isMuted: false,
    discoveryStatus: 'discovered',
    discoveredVia,
    discoveryReason,
  };
}

async function ensureDiscoveredSubreddit(
  name: string,
  discoveredVia?: string,
  discoveryReason?: string
) {
  const normalizedName = normalizeSubredditName(name);
  if (!normalizedName || normalizedName === 'all') return;

  const existing = await getSubreddit(normalizedName);
  if (existing) {
    await upsertSubreddit({
      ...existing,
      discoveredVia: existing.discoveredVia ?? discoveredVia,
      discoveryReason: existing.discoveryReason ?? discoveryReason,
    });
    return;
  }

  await upsertSubreddit(buildDiscoveredRecord(normalizedName, discoveredVia, discoveryReason));
}

function extractProfileRecord(
  name: string,
  data: Record<string, unknown>,
  existing: SubredditRecord | undefined
): SubredditRecord {
  const normalizedName = normalizeSubredditName(
    asString(data.display_name) ?? asString(data.display_name_prefixed)?.replace(/^r\//i, '') ?? name
  );
  const now = Date.now();
  const description = asString(data.description);
  const publicDescription = asString(data.public_description);

  return {
    ...(existing ?? buildDiscoveredRecord(normalizedName)),
    name: normalizedName,
    prefixedName: `r/${normalizedName}`,
    displayName: asString(data.display_name) ?? existing?.displayName,
    title: asString(data.title) ?? existing?.title,
    description: description ?? existing?.description,
    publicDescription: publicDescription ?? existing?.publicDescription,
    subscribers: asNumber(data.subscribers) ?? existing?.subscribers,
    isNsfw: typeof data.over18 === 'boolean' ? data.over18 : existing?.isNsfw,
    lastFetchedAt: now,
    discoveryStatus: existing?.isMuted ? 'muted' : 'verified',
    profileFetchedAt: now,
    profileFetchError: undefined,
    availabilityStatus: 'available',
    availabilityCheckedAt: now,
    availabilityReason: undefined,
    availabilityDetail: undefined,
    unavailableSince: undefined,
    adjacencyScannedAt: now,
  };
}

async function persistDiscoveredLinks(fromSubreddit: string, links: AdjacencyLink[]) {
  await Promise.all(links.map(async (link) => {
    await upsertAdjacency(link);
    await ensureDiscoveredSubreddit(
      link.toSubreddit,
      `${link.source}:r/${fromSubreddit}`,
      link.evidence
    );
  }));
}

export async function scanSubredditProfile(name: string): Promise<SubredditProfileScanResult> {
  const normalizedName = normalizeSubredditName(name);
  if (!normalizedName || normalizedName === 'all') {
    return { name: normalizedName, ok: false, linksDiscovered: 0, error: 'not a scan target' };
  }

  const existing = await getSubreddit(normalizedName);
  const response = await fetchSubredditAboutResult(normalizedName);

  if (!response.ok) {
    if (response.error.tooFast) {
      return {
        name: normalizedName,
        ok: false,
        linksDiscovered: 0,
        error: response.error.message,
        tooFast: true,
        rateLimitedUntil: response.error.rateLimitedUntil,
      };
    }

    const error = response.error.message || 'subreddit profile fetch failed';
    if (response.error.subredditUnavailableReason) {
      await markSubredditUnavailable(
        normalizedName,
        response.error.subredditUnavailableReason,
        error,
        response.error.subredditUnavailableDetail
      );
      return {
        name: normalizedName,
        ok: false,
        linksDiscovered: 0,
        error,
        availabilityStatus: response.error.subredditUnavailableReason,
      };
    }

    await markSubredditProfileFailed(normalizedName, error);
    return { name: normalizedName, ok: false, linksDiscovered: 0, error };
  }

  const data = asRecord(response.data.data);
  if (!data) {
    const error = 'subreddit profile response did not include profile data';
    await markSubredditProfileFailed(normalizedName, error);
    return { name: normalizedName, ok: false, linksDiscovered: 0, error };
  }

  const record = extractProfileRecord(normalizedName, data, existing);
  await upsertSubreddit(record);

  const scanText = [record.description, record.publicDescription].filter(Boolean).join('\n');
  const links = scanText ? extractLinksFromDescription(scanText, record.name) : [];
  await persistDiscoveredLinks(record.name, links);

  return { name: record.name, ok: true, linksDiscovered: links.length };
}

export async function scanSubredditProfiles(
  names: string[],
  options: { force?: boolean } = {}
): Promise<SubredditProfileScanResult[]> {
  const uniqueNames = [...new Set(names.map(normalizeSubredditName).filter((name) => name && name !== 'all'))];
  const results: SubredditProfileScanResult[] = [];

  for (const name of uniqueNames) {
    if (!options.force) {
      const existing = await getSubreddit(name);
      if (existing?.profileFetchedAt && Date.now() - existing.profileFetchedAt < 24 * 60 * 60 * 1000) {
        continue;
      }
    }
    results.push(await scanSubredditProfile(name));
  }

  return results;
}

export async function scanNextSubredditProfiles(limit = 20): Promise<SubredditProfileScanResult[]> {
  const due = await getSubredditsDueForProfileScan(limit);
  return scanSubredditProfiles(due.map((sub) => sub.name), { force: true });
}
