import {
  getAllSubreddits,
  getSubreddit,
  getSubredditsDueForProfileScan,
} from '$lib/db/store';
import { scanSubredditProfile, type SubredditProfileScanResult } from '$lib/discovery/subreddits';
import { readRedditRateLimitState } from '$lib/transport/reddit';
import type { SubredditRecord } from '$lib/types';

type ProfileScanMode = 'idle' | 'background' | 'single' | 'batch' | 'full' | 'rescan' | 'failed';

type EnqueueOptions = {
  mode: ProfileScanMode;
  replaceQueue?: boolean;
  total?: number;
};

type NavigatorWithLocks = Navigator & {
  locks?: {
    request<T>(
      name: string,
      options: { ifAvailable: true },
      callback: (lock: unknown | null) => T | Promise<T>
    ): Promise<T>;
  };
};

const AUTO_ENABLED_STORAGE_KEY = 'subglass:profile-scan-auto';
const BACKGROUND_QUEUE_TARGET = 8;
const BACKGROUND_REFILL_DELAY_MS = 10 * 1000;
const PROFILE_SCAN_SPACING_MS = 1500;
const RECENT_STATUS_MS = 15 * 1000;
const LOCK_RETRY_MS = 5 * 1000;

function normalizeSubredditName(name: string): string {
  return name.trim().replace(/^\/?r\//i, '').toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isScanTargetName(name: string): boolean {
  return Boolean(name) && name !== 'all' && /^[a-z0-9_]{2,21}$/i.test(name);
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

function formatDuration(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes}m`;
}

function readStoredAutoEnabled(): boolean {
  if (typeof window === 'undefined') return true;

  try {
    return window.localStorage.getItem(AUTO_ENABLED_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeStoredAutoEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(AUTO_ENABLED_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // Ignore storage failures in private mode or restricted environments.
  }
}

function shouldShowInDueQueue(sub: SubredditRecord): boolean {
  return !sub.isMuted && sub.discoveryStatus !== 'muted' && isScanTargetName(sub.name);
}

class ProfileScanManager {
  active = $state(false);
  paused = $state(false);
  autoEnabled = $state(true);
  lockedElsewhere = $state(false);
  mode = $state<ProfileScanMode>('idle');
  queue = $state<string[]>([]);
  currentName = $state('');
  scannedCount = $state(0);
  totalCount = $state(0);
  okCount = $state(0);
  failedCount = $state(0);
  linksDiscovered = $state(0);
  lastResult = $state<SubredditProfileScanResult | null>(null);
  lastMessage = $state('');
  lastActivityAt = $state(0);
  now = $state(Date.now());

  private initialized = false;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private runningPromise: Promise<void> | null = null;
  private refillTimer: ReturnType<typeof setTimeout> | undefined;
  private lockRetryTimer: ReturnType<typeof setTimeout> | undefined;

  initialize(): () => void {
    if (this.initialized) return () => {};

    this.initialized = true;
    this.autoEnabled = readStoredAutoEnabled();
    this.ticker = setInterval(() => {
      this.now = Date.now();
    }, 1000);

    if (this.autoEnabled) {
      this.scheduleBackgroundRefill(800);
    }

    return () => {
      clearInterval(this.ticker);
      clearTimeout(this.refillTimer);
      clearTimeout(this.lockRetryTimer);
      this.initialized = false;
    };
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  get rateLimitRemainingMs(): number {
    void this.now;
    const rateLimit = readRedditRateLimitState();
    return rateLimit.active ? rateLimit.retryAfterMs : 0;
  }

  get fixedTotalProgress(): boolean {
    return this.totalCount > 0 && this.mode !== 'background';
  }

  get shortText(): string {
    void this.now;

    if (!this.autoEnabled && !this.active && this.queue.length === 0) return 'scan off';
    if (this.paused) return this.queue.length > 0 ? `paused ${this.queue.length}` : 'paused';
    if (this.lockedElsewhere && !this.active) return 'scan tab';
    if (this.rateLimitRemainingMs > 0) return `wait ${formatDuration(this.rateLimitRemainingMs)}`;
    if (this.active && this.fixedTotalProgress) {
      return `scan ${Math.min(this.scannedCount + 1, this.totalCount)}/${this.totalCount}`;
    }
    if (this.active && this.currentName) return `scan r/${this.currentName}`;
    if (this.queue.length > 0) return `${this.queue.length} queued`;
    if (this.lastResult && this.now - this.lastActivityAt < RECENT_STATUS_MS) {
      return this.lastResult.ok ? `scanned r/${this.lastResult.name}` : `scan failed`;
    }
    return 'scan';
  }

  get detailText(): string {
    void this.now;

    const parts = [
      `mode: ${this.mode}`,
      `auto: ${this.autoEnabled ? 'on' : 'off'}`,
      `queued: ${formatCount(this.queue.length)}`,
      `scanned: ${formatCount(this.scannedCount)}${this.totalCount > 0 ? `/${formatCount(this.totalCount)}` : ''}`,
      `ok: ${formatCount(this.okCount)}`,
      `failed: ${formatCount(this.failedCount)}`,
      `links: ${formatCount(this.linksDiscovered)}`,
    ];

    if (this.paused) parts.unshift('paused');
    if (this.active && this.currentName) parts.unshift(`scanning r/${this.currentName}`);
    if (this.lockedElsewhere && !this.active) parts.unshift('another tab has the scanner lock');
    if (this.rateLimitRemainingMs > 0) parts.unshift(`reddit asked us to wait ${formatDuration(this.rateLimitRemainingMs)}`);
    if (this.lastResult) {
      parts.push(
        this.lastResult.ok
          ? `last: r/${this.lastResult.name} found ${this.lastResult.linksDiscovered} links`
          : `last: r/${this.lastResult.name} failed${this.lastResult.error ? ` (${this.lastResult.error})` : ''}`
      );
    } else {
      parts.push('last: none this session');
    }

    return parts.join(' · ');
  }

  get progressPercent(): number | null {
    if (!this.fixedTotalProgress || this.totalCount <= 0) return null;
    return Math.min(100, Math.round((this.scannedCount / this.totalCount) * 100));
  }

  setAutoEnabled(enabled: boolean): void {
    this.autoEnabled = enabled;
    writeStoredAutoEnabled(enabled);
    if (enabled && !this.paused) {
      this.scheduleBackgroundRefill(100);
    }
  }

  pause(): void {
    this.paused = true;
    this.lastMessage = 'Discovery scanning paused.';
  }

  resume(): void {
    this.paused = false;
    this.lastMessage = 'Discovery scanning resumed.';
    this.kick();
    if (this.autoEnabled) this.scheduleBackgroundRefill(100);
  }

  async scanOne(name: string): Promise<void> {
    const normalized = normalizeSubredditName(name);
    if (!isScanTargetName(normalized)) return;

    this.enqueue([normalized], { mode: 'single', replaceQueue: false, total: 1 });
    await this.waitForCurrentRun();
  }

  async scanNext(limit = 20): Promise<void> {
    const due = await getSubredditsDueForProfileScan(limit);
    this.enqueue(due.map((sub) => sub.name), { mode: 'batch', replaceQueue: true, total: due.length });
    await this.waitForCurrentRun();
  }

  async scanAllDue(): Promise<void> {
    const due = await getSubredditsDueForProfileScan(Number.MAX_SAFE_INTEGER);
    this.enqueue(due.map((sub) => sub.name), { mode: 'full', replaceQueue: true, total: due.length });
    await this.waitForCurrentRun();
  }

  async rescanAll(): Promise<void> {
    const subs = (await getAllSubreddits())
      .filter(shouldShowInDueQueue)
      .sort((a, b) => (b.localRating || 0) - (a.localRating || 0));

    this.enqueue(subs.map((sub) => sub.name), { mode: 'rescan', replaceQueue: true, total: subs.length });
    await this.waitForCurrentRun();
  }

  async scanFailed(): Promise<void> {
    const failed = (await getAllSubreddits())
      .filter((sub) => shouldShowInDueQueue(sub) && (sub.discoveryStatus === 'failed' || Boolean(sub.profileFetchError)))
      .sort((a, b) => (a.profileFetchFailedAt ?? 0) - (b.profileFetchFailedAt ?? 0));

    this.enqueue(failed.map((sub) => sub.name), { mode: 'failed', replaceQueue: true, total: failed.length });
    await this.waitForCurrentRun();
  }

  async enqueueBackgroundTargets(names: string[]): Promise<void> {
    if (!this.autoEnabled || this.paused) return;

    const targets: string[] = [];
    for (const rawName of names) {
      const name = normalizeSubredditName(rawName);
      if (!isScanTargetName(name)) continue;
      if (this.queue.includes(name) || this.currentName === name) continue;

      const existing = await getSubreddit(name);
      if (!existing || existing.isMuted || existing.discoveryStatus === 'muted') continue;
      if (existing.profileFetchedAt || existing.profileFetchError) continue;

      targets.push(name);
    }

    this.enqueue(targets, { mode: this.mode === 'idle' ? 'background' : this.mode });
  }

  async refreshBackgroundQueue(): Promise<void> {
    if (!this.autoEnabled || this.paused) return;

    const openSlots = Math.max(0, BACKGROUND_QUEUE_TARGET - this.queue.length - (this.currentName ? 1 : 0));
    if (openSlots === 0) return;

    const due = await getSubredditsDueForProfileScan(openSlots, Number.MAX_SAFE_INTEGER);
    const names = due
      .filter((sub) => !sub.profileFetchedAt)
      .map((sub) => sub.name);

    this.enqueue(names, { mode: this.mode === 'idle' ? 'background' : this.mode });
  }

  private enqueue(names: string[], options: EnqueueOptions): void {
    const normalized = [...new Set(names.map(normalizeSubredditName).filter(isScanTargetName))];

    if (options.replaceQueue) {
      this.queue = [];
      this.resetRunStats(options.mode, options.total ?? normalized.length);
    } else if (this.mode === 'idle' || !this.active) {
      this.mode = options.mode;
      if (options.total !== undefined) this.totalCount = options.total;
    }

    if (normalized.length === 0) {
      this.lastMessage = options.mode === 'background'
        ? 'No background subreddit profiles are due.'
        : 'No subreddit profiles are due for scanning.';
      this.lastActivityAt = Date.now();
      return;
    }

    const existing = new Set([...this.queue, this.currentName].filter(Boolean));
    const next = normalized.filter((name) => !existing.has(name));
    if (next.length === 0) return;

    this.queue = [...this.queue, ...next];
    if (options.total !== undefined && !options.replaceQueue) {
      this.totalCount = Math.max(this.totalCount, options.total);
    }
    this.lastMessage = `Queued ${next.length} subreddit profile${next.length === 1 ? '' : 's'}.`;
    this.lastActivityAt = Date.now();
    this.kick();
  }

  private resetRunStats(mode: ProfileScanMode, total: number): void {
    this.mode = mode;
    this.scannedCount = 0;
    this.totalCount = total;
    this.okCount = 0;
    this.failedCount = 0;
    this.linksDiscovered = 0;
    this.lastResult = null;
  }

  private kick(): void {
    if (this.active || this.paused || this.queue.length === 0) return;
    if (!this.runningPromise) {
      this.runningPromise = this.runWithBrowserLock()
        .catch((error) => {
          this.lastMessage = error instanceof Error ? error.message : String(error);
          console.warn('Subreddit profile scan failed', error);
        })
        .finally(() => {
          this.runningPromise = null;
          if (!this.paused && this.queue.length > 0) {
            this.scheduleLockRetry();
          } else if (this.autoEnabled) {
            this.scheduleBackgroundRefill(BACKGROUND_REFILL_DELAY_MS);
          }
        });
    }
  }

  private async waitForCurrentRun(): Promise<void> {
    if (this.runningPromise) await this.runningPromise;
  }

  private async runWithBrowserLock(): Promise<void> {
    if (typeof navigator === 'undefined') {
      await this.drainQueue();
      return;
    }

    const locks = (navigator as NavigatorWithLocks).locks;
    if (!locks) {
      await this.drainQueue();
      return;
    }

    await locks.request('subglass-profile-scan', { ifAvailable: true }, async (lock) => {
      if (!lock) {
        this.lockedElsewhere = true;
        this.lastMessage = 'Another tab is running discovery scans.';
        this.lastActivityAt = Date.now();
        return;
      }

      this.lockedElsewhere = false;
      await this.drainQueue();
    });
  }

  private async drainQueue(): Promise<void> {
    this.active = true;
    try {
      while (this.queue.length > 0 && !this.paused) {
        const next = this.queue.shift();
        if (!next) continue;

        this.currentName = next;
        this.lastMessage = `Scanning r/${next}.`;
        this.lastActivityAt = Date.now();

        const result = await scanSubredditProfile(next);
        if (result.tooFast) {
          this.queue = [next, ...this.queue];
          this.lastResult = result;
          this.lastMessage = result.error ?? 'Reddit asked us to slow down.';
          this.lastActivityAt = Date.now();
          const waitMs = Math.max(1000, (result.rateLimitedUntil ?? Date.now() + 30_000) - Date.now());
          await sleep(waitMs + 250);
          continue;
        }

        this.lastResult = result;
        this.scannedCount += 1;
        if (result.ok) {
          this.okCount += 1;
          this.linksDiscovered += result.linksDiscovered;
          this.lastMessage = `Scanned r/${result.name}; ${result.linksDiscovered} links found.`;
        } else {
          this.failedCount += 1;
          this.lastMessage = `Failed r/${result.name}${result.error ? `: ${result.error}` : ''}`;
        }
        this.lastActivityAt = Date.now();

        if (this.autoEnabled && this.mode === 'background') {
          await this.refreshBackgroundQueue();
        }

        if (this.queue.length > 0 && !this.paused) {
          await sleep(PROFILE_SCAN_SPACING_MS);
        }
      }
    } finally {
      this.currentName = '';
      this.active = false;
      if (this.queue.length === 0 && this.mode !== 'background') {
        this.mode = 'idle';
      } else if (this.queue.length === 0 && this.mode === 'background') {
        this.mode = 'idle';
      }
    }
  }

  private scheduleBackgroundRefill(delayMs: number): void {
    clearTimeout(this.refillTimer);
    this.refillTimer = setTimeout(() => {
      void this.refreshBackgroundQueue();
    }, delayMs);
  }

  private scheduleLockRetry(): void {
    clearTimeout(this.lockRetryTimer);
    this.lockRetryTimer = setTimeout(() => {
      this.lockedElsewhere = false;
      this.kick();
    }, LOCK_RETRY_MS);
  }
}

export const profileScanManager = new ProfileScanManager();
