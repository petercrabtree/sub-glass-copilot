import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  SubredditRecord, AdjacencyLink, PostRecord, MediaGroup, SignalEvent, CacheEntry
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
}

let _db: IDBPDatabase<SubGlassDB> | null = null;

export async function getDB(): Promise<IDBPDatabase<SubGlassDB>> {
  if (_db) return _db;
  _db = await openDB<SubGlassDB>('subglass', 1, {
    upgrade(db) {
      db.createObjectStore('subreddits', { keyPath: 'name' });

      const adjStore = db.createObjectStore('adjacency', { keyPath: ['fromSubreddit', 'toSubreddit', 'source'] });
      adjStore.createIndex('by-from', 'fromSubreddit');

      const postStore = db.createObjectStore('posts', { keyPath: 'id' });
      postStore.createIndex('by-subreddit', 'subreddit');
      postStore.createIndex('by-seen', 'seenAt');

      const mediaStore = db.createObjectStore('media', { keyPath: 'id' });
      mediaStore.createIndex('by-post', 'postId');

      const eventStore = db.createObjectStore('events', { keyPath: 'id' });
      eventStore.createIndex('by-type', 'type');
      eventStore.createIndex('by-ts', 'ts');

      db.createObjectStore('cache', { keyPath: 'specKey' });
    },
  });
  return _db;
}

// Subreddits
export async function upsertSubreddit(sub: SubredditRecord): Promise<void> {
  const db = await getDB();
  const existing = await db.get('subreddits', sub.name);
  if (existing) {
    await db.put('subreddits', {
      ...existing,
      displayName: sub.displayName ?? existing.displayName,
      title: sub.title ?? existing.title,
      description: sub.description ?? existing.description,
      subscribers: sub.subscribers ?? existing.subscribers,
      isNsfw: sub.isNsfw ?? existing.isNsfw,
      lastFetchedAt: sub.lastFetchedAt ?? existing.lastFetchedAt,
    });
  } else {
    await db.put('subreddits', sub);
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

export async function setSubredditMuted(name: string, muted: boolean): Promise<void> {
  const db = await getDB();
  const sub = await db.get('subreddits', name.toLowerCase());
  if (sub) {
    await db.put('subreddits', { ...sub, isMuted: muted });
  }
}

// Adjacency
export async function upsertAdjacency(link: AdjacencyLink): Promise<void> {
  const db = await getDB();
  await db.put('adjacency', link);
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
  const id = `${event.ts}_${Math.random().toString(36).slice(2, 9)}`;
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

// Export all data
export async function exportAllData(): Promise<Record<string, unknown>> {
  const db = await getDB();
  const [subreddits, adjacency, posts, media, events, cache] = await Promise.all([
    db.getAll('subreddits'),
    db.getAll('adjacency'),
    db.getAll('posts'),
    db.getAll('media'),
    db.getAll('events'),
    db.getAll('cache'),
  ]);
  return { subreddits, adjacency, posts, media, events, cache };
}

// Import all data (destructive)
export async function importAllData(data: Record<string, unknown>): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['subreddits', 'adjacency', 'posts', 'media', 'events', 'cache'], 'readwrite');

  await Promise.all([
    tx.objectStore('subreddits').clear(),
    tx.objectStore('adjacency').clear(),
    tx.objectStore('posts').clear(),
    tx.objectStore('media').clear(),
    tx.objectStore('events').clear(),
    tx.objectStore('cache').clear(),
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

  await tx.done;
}
