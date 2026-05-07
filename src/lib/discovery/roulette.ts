import type { SubredditRecord, SubredditRouletteSettings } from '$lib/types';

export const DEFAULT_ROULETTE_SETTINGS: SubredditRouletteSettings = {
  subredditCount: 10,
  imagesPerRound: 25,
  likedWeight: 4,
  newWeight: 2,
  randomWeight: 1,
  nsfwMode: 'only',
};

export const ROULETTE_SETTINGS_STORAGE_KEY = 'subglass:roulette-settings';
type NsfwMode = SubredditRouletteSettings['nsfwMode'];
type StoredRouletteSettings = Partial<SubredditRouletteSettings> & {
  includeNsfw?: boolean;
};

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampWeight(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(10, Math.max(0, Number(value.toFixed(1))));
}

export function normalizeRouletteSettings(
  settings: StoredRouletteSettings | null | undefined
): SubredditRouletteSettings {
  return {
    subredditCount: clampNumber(
      settings?.subredditCount ?? DEFAULT_ROULETTE_SETTINGS.subredditCount,
      1,
      12,
      DEFAULT_ROULETTE_SETTINGS.subredditCount
    ),
    imagesPerRound: clampNumber(
      settings?.imagesPerRound ?? DEFAULT_ROULETTE_SETTINGS.imagesPerRound,
      3,
      80,
      DEFAULT_ROULETTE_SETTINGS.imagesPerRound
    ),
    likedWeight: clampWeight(
      settings?.likedWeight ?? DEFAULT_ROULETTE_SETTINGS.likedWeight,
      DEFAULT_ROULETTE_SETTINGS.likedWeight
    ),
    newWeight: clampWeight(
      settings?.newWeight ?? DEFAULT_ROULETTE_SETTINGS.newWeight,
      DEFAULT_ROULETTE_SETTINGS.newWeight
    ),
    randomWeight: clampWeight(
      settings?.randomWeight ?? DEFAULT_ROULETTE_SETTINGS.randomWeight,
      DEFAULT_ROULETTE_SETTINGS.randomWeight
    ),
    nsfwMode: normalizeNsfwMode(settings),
  };
}

function isNsfwMode(value: unknown): value is NsfwMode {
  return value === 'yes' || value === 'no' || value === 'only';
}

function normalizeNsfwMode(settings: StoredRouletteSettings | null | undefined): NsfwMode {
  if (isNsfwMode(settings?.nsfwMode)) return settings.nsfwMode;
  if (settings?.includeNsfw === false) return 'no';
  return DEFAULT_ROULETTE_SETTINGS.nsfwMode;
}

export function readStoredRouletteSettings(): SubredditRouletteSettings {
  if (typeof window === 'undefined') return DEFAULT_ROULETTE_SETTINGS;

  try {
    const raw = window.localStorage.getItem(ROULETTE_SETTINGS_STORAGE_KEY);
    return normalizeRouletteSettings(raw ? JSON.parse(raw) as StoredRouletteSettings : null);
  } catch {
    return DEFAULT_ROULETTE_SETTINGS;
  }
}

export function persistRouletteSettings(settings: SubredditRouletteSettings): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(ROULETTE_SETTINGS_STORAGE_KEY, JSON.stringify(normalizeRouletteSettings(settings)));
  } catch {
    // Ignore storage failures in private mode or restricted environments.
  }
}

function getNewnessScore(sub: SubredditRecord): number {
  if (!sub.profileFetchedAt || sub.discoveryStatus === 'discovered') return 1;
  if ((sub.localRating ?? 0) === 0) return 0.7;
  return 0.15;
}

function getPreferenceScore(sub: SubredditRecord): number {
  const rating = sub.localRating ?? 0;
  if (rating > 0) return 1 + rating;
  if (rating < 0) return Math.max(0.08, 1 / (Math.abs(rating) + 1));
  return 0.7;
}

export function getRouletteCandidateWeight(
  sub: SubredditRecord,
  settings: SubredditRouletteSettings
): number {
  const preference = getPreferenceScore(sub);
  const newness = getNewnessScore(sub);
  const base =
    settings.randomWeight +
    settings.likedWeight * preference +
    settings.newWeight * newness;

  return Math.max(0.01, base);
}

function isRouletteCandidate(sub: SubredditRecord, settings: SubredditRouletteSettings): boolean {
  if (!sub.name || sub.name === 'all') return false;
  if (sub.isMuted || sub.discoveryStatus === 'muted') return false;
  if (sub.discoveryStatus === 'failed') return false;
  if (settings.nsfwMode === 'only' && sub.isNsfw !== true) return false;
  if (settings.nsfwMode === 'no' && sub.isNsfw === true) return false;
  return /^[a-z0-9_]{2,21}$/i.test(sub.name);
}

export function getRouletteCandidates(
  subreddits: SubredditRecord[],
  settings: SubredditRouletteSettings
): SubredditRecord[] {
  return subreddits.filter((sub) => isRouletteCandidate(sub, settings));
}

export function chooseRouletteSubreddits(
  subreddits: SubredditRecord[],
  settingsInput: SubredditRouletteSettings,
  avoidNames: string[] = []
): SubredditRecord[] {
  const settings = normalizeRouletteSettings(settingsInput);
  const avoid = new Set(avoidNames.map((name) => name.toLowerCase()));
  const preferredPool = getRouletteCandidates(subreddits, settings).filter((sub) => !avoid.has(sub.name));
  const fallbackPool = getRouletteCandidates(subreddits, settings);
  const pool = preferredPool.length >= settings.subredditCount ? preferredPool : fallbackPool;
  const selected: SubredditRecord[] = [];
  const remaining = [...pool];

  while (selected.length < settings.subredditCount && remaining.length > 0) {
    const totalWeight = remaining.reduce(
      (sum, sub) => sum + getRouletteCandidateWeight(sub, settings),
      0
    );
    let cursor = Math.random() * totalWeight;
    let selectedIndex = 0;

    for (let index = 0; index < remaining.length; index += 1) {
      cursor -= getRouletteCandidateWeight(remaining[index], settings);
      if (cursor <= 0) {
        selectedIndex = index;
        break;
      }
    }

    const [sub] = remaining.splice(selectedIndex, 1);
    selected.push(sub);
  }

  return selected;
}

export function formatRouletteBundle(subreddits: Pick<SubredditRecord, 'name'>[]): string {
  return subreddits.map((sub) => sub.name).join('+');
}
