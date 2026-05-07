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
type RouletteWeightKind = 'liked' | 'new' | 'random';
type StoredRouletteSettings = Partial<SubredditRouletteSettings> & {
  includeNsfw?: boolean;
};
const ROULETTE_WEIGHT_KINDS: RouletteWeightKind[] = ['liked', 'new', 'random'];

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

function getRouletteWeightValue(settings: SubredditRouletteSettings, kind: RouletteWeightKind): number {
  if (kind === 'liked') return settings.likedWeight;
  if (kind === 'new') return settings.newWeight;
  return settings.randomWeight;
}

function getRouletteWeightTotal(settings: SubredditRouletteSettings): number {
  return ROULETTE_WEIGHT_KINDS.reduce(
    (total, kind) => total + getRouletteWeightValue(settings, kind),
    0
  );
}

function getStrategyCandidateWeight(sub: SubredditRecord, kind: RouletteWeightKind): number {
  if (kind === 'liked') return getPreferenceScore(sub);
  if (kind === 'new') return getNewnessScore(sub);
  return 1;
}

export function getRouletteCandidateWeight(
  sub: SubredditRecord,
  settings: SubredditRouletteSettings
): number {
  const totalWeight = getRouletteWeightTotal(settings);

  if (totalWeight <= 0) return 1;

  const base = ROULETTE_WEIGHT_KINDS.reduce((score, kind) => {
    const relativeWeight = getRouletteWeightValue(settings, kind) / totalWeight;
    return score + relativeWeight * getStrategyCandidateWeight(sub, kind);
  }, 0);

  return Math.max(0.01, base);
}

function getRouletteSelectionSlots(
  settings: SubredditRouletteSettings,
  targetCount: number
): RouletteWeightKind[] {
  if (targetCount <= 0) return [];

  const weightedKinds = ROULETTE_WEIGHT_KINDS
    .map((kind, index) => ({ kind, index, weight: getRouletteWeightValue(settings, kind) }))
    .filter((entry) => entry.weight > 0);

  if (weightedKinds.length === 0) {
    return Array.from({ length: targetCount }, () => 'random');
  }

  const totalWeight = weightedKinds.reduce((total, entry) => total + entry.weight, 0);
  const quotas = weightedKinds.map((entry) => {
    const exactSlots = (entry.weight / totalWeight) * targetCount;
    const slots = Math.floor(exactSlots);
    return {
      ...entry,
      slots,
      remainder: exactSlots - slots,
    };
  });
  let unassignedSlots = targetCount - quotas.reduce((total, quota) => total + quota.slots, 0);

  quotas
    .sort((a, b) => b.remainder - a.remainder || b.weight - a.weight || a.index - b.index)
    .forEach((quota) => {
      if (unassignedSlots <= 0) return;
      quota.slots += 1;
      unassignedSlots -= 1;
    });

  const slots = quotas.flatMap((quota) => Array.from({ length: quota.slots }, () => quota.kind));

  for (let index = slots.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [slots[index], slots[swapIndex]] = [slots[swapIndex], slots[index]];
  }

  return slots;
}

function chooseWeightedSubredditIndex(
  candidates: SubredditRecord[],
  kind: RouletteWeightKind
): number {
  const totalWeight = candidates.reduce(
    (sum, sub) => sum + Math.max(0.01, getStrategyCandidateWeight(sub, kind)),
    0
  );
  let cursor = Math.random() * totalWeight;

  for (let index = 0; index < candidates.length; index += 1) {
    cursor -= Math.max(0.01, getStrategyCandidateWeight(candidates[index], kind));
    if (cursor <= 0) return index;
  }

  return 0;
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
  const preferredPool = getRouletteCandidates(subreddits, settings).filter(
    (sub) => !avoid.has(sub.name.toLowerCase())
  );
  const fallbackPool = getRouletteCandidates(subreddits, settings);
  const pool = preferredPool.length >= settings.subredditCount ? preferredPool : fallbackPool;
  const targetCount = Math.min(settings.subredditCount, pool.length);
  const selectionSlots = getRouletteSelectionSlots(settings, targetCount);
  const selected: SubredditRecord[] = [];
  const remaining = [...pool];

  for (const slot of selectionSlots) {
    const selectedIndex = chooseWeightedSubredditIndex(remaining, slot);
    const [sub] = remaining.splice(selectedIndex, 1);
    selected.push(sub);
  }

  return selected;
}

export function formatRouletteBundle(subreddits: Pick<SubredditRecord, 'name'>[]): string {
  return subreddits.map((sub) => sub.name).join('+');
}
