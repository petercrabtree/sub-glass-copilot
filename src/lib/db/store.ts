import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  SubredditRecord, AdjacencyLink, PostRecord, MediaGroup, SignalEvent, CacheEntry, FeedSnapshot
} from '$lib/types';

interface SubGlassDB extends DBSchema {
  subreddits: {
    key: string;
    value: SubredditRecord;
  };
  adjacency: {
    key: [string, string, string];
    value: AdjacencyLink;
    indexes: { 'by-from': string };
  };
  posts: {
    key: string;
    value: PostRecord;
    indexes: { 'by-subreddit': string; 'by-seen': number };
  };
  media: {
    key: string;
    value: MediaGroup;
    indexes: { 'by-post': string };
  };
  events: {
    key: string;
    value: SignalEvent;
    indexes: { 'by-type': string; 'by-ts': number };
  };
  cache: {
    key: string;
    value: CacheEntry;
  };
  feedSnapshots: {
    key: string;
    value: FeedSnapshot;
    indexes: { 'by-updated': number };
  };
}

let _db: IDBPDatabase<SubGlassDB> | null = null;

export async function getDB(): Promise<IDBPDatabase<SubGlassDB>> {
  if (_db) return _db;
  _db = await openDB<SubGlassDB>('subglass', 2, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('subreddits')) {
        db.createObjectStore('subreddits', { keyPath: 'name' });
      }

      if (!db.objectStoreNames.contains('adjacency')) {
        const adjStore = db.createObjectStore('adjacency', { keyPath: ['fromSubreddit', 'toSubreddit', 'source'] });
        adjStore.createIndex('by-from', 'fromSubreddit');
      }

      if (!db.objectStoreNames.contains('posts')) {
        const postStore = db.createObjectStore('posts', { keyPath: 'id' });
        postStore.createIndex('by-subreddit', 'subreddit');
        postStore.createIndex('by-seen', 'seenAt');
      }

      if (!db.objectStoreNames.contains('media')) {
        const mediaStore = db.createObjectStore('media', { keyPath: 'id' });
        mediaStore.createIndex('by-post', 'postId');
      }

      if (!db.objectStoreNames.contains('events')) {
        const eventStore = db.createObjectStore('events', { keyPath: 'id' });
        eventStore.createIndex('by-type', 'type');
        eventStore.createIndex('by-ts', 'ts');
      }

      if (!db.objectStoreNames.contains('cache')) {
        db.createObjectStore('cache', { keyPath: 'specKey' });
      }

      if (!db.objectStoreNames.contains('feedSnapshots')) {
        const snapshotStore = db.createObjectStore('feedSnapshots', { keyPath: 'routeKey' });
        snapshotStore.createIndex('by-updated', 'updatedAt');
      }
    },
  });
  return _db;
}

function normalizeSubredditName(name: string): string {
  return name.trim().replace(/^\/?r\//i, '').toLowerCase();
}

// Subreddits
export async function upsertSubreddit(sub: SubredditRecord): Promise<void> {
  const db = await getDB();
  const normalizedName = normalizeSubredditName(sub.name);
  const existing = await db.get('subreddits', normalizedName);
  const normalizedSub: SubredditRecord = {
    ...sub,
    name: normalizedName,
    prefixedName: sub.prefixedName ?? `r/${normalizedName}`,
  };
  if (existing) {
    await db.put('subreddits', {
      ...existing,
      displayName: normalizedSub.displayName ?? existing.displayName,
      title: normalizedSub.title ?? existing.title,
      description: normalizedSub.description ?? existing.description,
      publicDescription: normalizedSub.publicDescription ?? existing.publicDescription,
      subscribers: normalizedSub.subscribers ?? existing.subscribers,
      isNsfw: normalizedSub.isNsfw ?? existing.isNsfw,
      lastFetchedAt: normalizedSub.lastFetchedAt ?? existing.lastFetchedAt,
      discoveryStatus: existing.isMuted
        ? 'muted'
        : normalizedSub.discoveryStatus ?? existing.discoveryStatus ?? 'discovered',
      discoveredVia: normalizedSub.discoveredVia ?? existing.discoveredVia,
      discoveryReason: normalizedSub.discoveryReason ?? existing.discoveryReason,
      profileFetchedAt: normalizedSub.profileFetchedAt ?? existing.profileFetchedAt,
      profileFetchFailedAt: normalizedSub.profileFetchFailedAt ?? existing.profileFetchFailedAt,
      profileFetchError: normalizedSub.profileFetchedAt
        ? undefined
        : normalizedSub.profileFetchError ?? existing.profileFetchError,
      adjacencyScannedAt: normalizedSub.adjacencyScannedAt ?? existing.adjacencyScannedAt,
    });
  } else {
    await db.put('subreddits', {
      ...normalizedSub,
      discoveryStatus: normalizedSub.isMuted
        ? 'muted'
        : normalizedSub.discoveryStatus ?? 'discovered',
    });
  }
}

export async function getSubreddit(name: string): Promise<SubredditRecord | undefined> {
  const db = await getDB();
  return db.get('subreddits', name.toLowerCase());
}

export async function getAllSubreddits(): Promise<SubredditRecord[]> {
  const db = await getDB();
  return db.getAll('subreddits');
}

export async function updateSubredditRating(name: string, delta: number): Promise<void> {
  const db = await getDB();
  const sub = await db.get('subreddits', name.toLowerCase());
  if (sub) {
    await db.put('subreddits', { ...sub, localRating: (sub.localRating || 0) + delta });
  }
}

export async function setSubredditRating(name: string, rating: number): Promise<void> {
  const db = await getDB();
  const sub = await db.get('subreddits', name.toLowerCase());
  if (sub) {
    await db.put('subreddits', { ...sub, localRating: rating });
  }
}

export async function setSubredditMuted(name: string, muted: boolean): Promise<void> {
  const db = await getDB();
  const sub = await db.get('subreddits', name.toLowerCase());
  if (sub) {
    await db.put('subreddits', {
      ...sub,
      isMuted: muted,
      discoveryStatus: muted ? 'muted' : sub.profileFetchedAt ? 'verified' : 'discovered',
    });
  }
}

export async function clearSubredditProfileFailure(name: string): Promise<void> {
  const db = await getDB();
  const sub = await db.get('subreddits', name.toLowerCase());
  if (sub) {
    await db.put('subreddits', {
      ...sub,
      discoveryStatus: sub.isMuted ? 'muted' : sub.profileFetchedAt ? 'verified' : 'discovered',
      profileFetchFailedAt: undefined,
      profileFetchError: undefined,
    });
  }
}

export async function markSubredditProfileFailed(name: string, error: string): Promise<void> {
  const normalizedName = normalizeSubredditName(name);
  const existing = await getSubreddit(normalizedName);
  await upsertSubreddit({
    ...(existing ?? {
      name: normalizedName,
      prefixedName: `r/${normalizedName}`,
      firstSeenAt: Date.now(),
      localRating: 0,
      isMuted: false,
    }),
    discoveryStatus: existing?.isMuted ? 'muted' : 'failed',
    profileFetchFailedAt: Date.now(),
    profileFetchError: error,
  });
}

export async function getSubredditsDueForProfileScan(limit = 20, staleAfterMs = 7 * 24 * 60 * 60 * 1000): Promise<SubredditRecord[]> {
  const now = Date.now();
  const subs = await getAllSubreddits();
  return subs
    .filter((sub) => {
      if (sub.isMuted || sub.discoveryStatus === 'muted') return false;
      if (sub.name === 'all') return false;
      if (sub.profileFetchFailedAt && now - sub.profileFetchFailedAt < 15 * 60 * 1000) return false;
      return !sub.profileFetchedAt || now - sub.profileFetchedAt > staleAfterMs;
    })
    .sort((a, b) => {
      const aRating = a.localRating || 0;
      const bRating = b.localRating || 0;
      if (bRating !== aRating) return bRating - aRating;
      return (a.profileFetchedAt ?? 0) - (b.profileFetchedAt ?? 0);
    })
    .slice(0, limit);
}

// Adjacency
export async function upsertAdjacency(link: AdjacencyLink): Promise<void> {
  const db = await getDB();
  const fromSubreddit = normalizeSubredditName(link.fromSubreddit);
  const toSubreddit = normalizeSubredditName(link.toSubreddit);
  const existing = await db.get('adjacency', [fromSubreddit, toSubreddit, link.source]);
  const now = link.lastSeenAt ?? link.discoveredAt ?? Date.now();

  if (existing) {
    const nextCount = (existing.count ?? 1) + (link.count ?? 1);
    await db.put('adjacency', {
      ...existing,
      evidence: link.evidence ?? existing.evidence,
      discoveredAt: Math.min(existing.discoveredAt, link.discoveredAt),
      lastSeenAt: now,
      count: nextCount,
      weight: Math.max(existing.weight ?? 1, link.weight ?? 1) + Math.log2(nextCount + 1) * 0.2,
    });
    return;
  }

  await db.put('adjacency', {
    ...link,
    fromSubreddit,
    toSubreddit,
    discoveredAt: link.discoveredAt ?? now,
    lastSeenAt: now,
    count: link.count ?? 1,
    weight: link.weight ?? 1,
  });
}

export async function getAdjacencyFrom(subreddit: string): Promise<AdjacencyLink[]> {
  const db = await getDB();
  return db.getAllFromIndex('adjacency', 'by-from', subreddit.toLowerCase());
}

export async function getAllAdjacency(): Promise<AdjacencyLink[]> {
  const db = await getDB();
  return db.getAll('adjacency');
}

// Posts
export async function upsertPost(post: PostRecord): Promise<void> {
  const db = await getDB();
  const existing = await db.get('posts', post.id);
  if (existing) {
    await db.put('posts', {
      ...existing,
      seenAt: post.seenAt ?? existing.seenAt,
      localRating: post.localRating ?? existing.localRating,
    });
  } else {
    await db.put('posts', post);
  }
}

export async function getPost(id: string): Promise<PostRecord | undefined> {
  const db = await getDB();
  return db.get('posts', id);
}

export async function markPostSeen(id: string): Promise<void> {
  const db = await getDB();
  const post = await db.get('posts', id);
  if (post && !post.seenAt) {
    await db.put('posts', { ...post, seenAt: Date.now() });
  }
}

export async function setPostRating(id: string, rating: 1 | -1 | undefined): Promise<void> {
  const db = await getDB();
  const post = await db.get('posts', id);
  if (post) {
    await db.put('posts', { ...post, localRating: rating });
  }
}

export async function getSeenPostIds(): Promise<Set<string>> {
  const db = await getDB();
  const allPosts = await db.getAllFromIndex('posts', 'by-seen', IDBKeyRange.lowerBound(1));
  return new Set(allPosts.map(p => p.id));
}

export async function getAllPosts(): Promise<PostRecord[]> {
  const db = await getDB();
  return db.getAll('posts');
}

export async function getPostsByIds(ids: string[]): Promise<PostRecord[]> {
  const db = await getDB();
  const posts = await Promise.all(ids.map((id) => db.get('posts', id)));
  return posts.filter((post): post is PostRecord => Boolean(post));
}

// Media
export async function upsertMedia(media: MediaGroup): Promise<void> {
  const db = await getDB();
  await db.put('media', media);
}

export async function getMediaByPost(postId: string): Promise<MediaGroup[]> {
  const db = await getDB();
  return db.getAllFromIndex('media', 'by-post', postId);
}

export async function getAllMedia(): Promise<MediaGroup[]> {
  const db = await getDB();
  return db.getAll('media');
}

// Events
export async function addEvent(event: Omit<SignalEvent, 'id'>): Promise<void> {
  const db = await getDB();
  const id = `${event.ts}_${crypto.randomUUID()}`;
  await db.put('events', { ...event, id });
}

export async function getAllEvents(): Promise<SignalEvent[]> {
  const db = await getDB();
  return db.getAll('events');
}

// Cache
export async function getCacheEntry(specKey: string): Promise<CacheEntry | undefined> {
  const db = await getDB();
  return db.get('cache', specKey);
}

export async function setCacheEntry(entry: CacheEntry): Promise<void> {
  const db = await getDB();
  await db.put('cache', entry);
}

// Feed snapshots
export async function getFeedSnapshot(routeKey: string): Promise<FeedSnapshot | undefined> {
  const db = await getDB();
  return db.get('feedSnapshots', routeKey);
}

export async function setFeedSnapshot(snapshot: FeedSnapshot): Promise<void> {
  const db = await getDB();
  await db.put('feedSnapshots', snapshot);
}

export async function getAllFeedSnapshots(): Promise<FeedSnapshot[]> {
  const db = await getDB();
  return db.getAll('feedSnapshots');
}

// Export all data
export async function exportAllData(): Promise<Record<string, unknown>> {
  const db = await getDB();
  const [subreddits, adjacency, posts, media, events, cache, feedSnapshots] = await Promise.all([
    db.getAll('subreddits'),
    db.getAll('adjacency'),
    db.getAll('posts'),
    db.getAll('media'),
    db.getAll('events'),
    db.getAll('cache'),
    db.getAll('feedSnapshots'),
  ]);
  return { subreddits, adjacency, posts, media, events, cache, feedSnapshots };
}

// Import all data (destructive)
export async function importAllData(data: Record<string, unknown>): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['subreddits', 'adjacency', 'posts', 'media', 'events', 'cache', 'feedSnapshots'], 'readwrite');

  await Promise.all([
    tx.objectStore('subreddits').clear(),
    tx.objectStore('adjacency').clear(),
    tx.objectStore('posts').clear(),
    tx.objectStore('media').clear(),
    tx.objectStore('events').clear(),
    tx.objectStore('cache').clear(),
    tx.objectStore('feedSnapshots').clear(),
  ]);

  for (const sub of (data.subreddits as SubredditRecord[] || [])) {
    await tx.objectStore('subreddits').put(sub);
  }
  for (const link of (data.adjacency as AdjacencyLink[] || [])) {
    await tx.objectStore('adjacency').put(link);
  }
  for (const post of (data.posts as PostRecord[] || [])) {
    await tx.objectStore('posts').put(post);
  }
  for (const m of (data.media as MediaGroup[] || [])) {
    await tx.objectStore('media').put(m);
  }
  for (const ev of (data.events as SignalEvent[] || [])) {
    await tx.objectStore('events').put(ev);
  }
  for (const c of (data.cache as CacheEntry[] || [])) {
    await tx.objectStore('cache').put(c);
  }
  for (const snapshot of (data.feedSnapshots as FeedSnapshot[] || [])) {
    await tx.objectStore('feedSnapshots').put(snapshot);
  }

  await tx.done;
}
