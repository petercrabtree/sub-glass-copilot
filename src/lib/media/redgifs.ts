import type { MediaGroup, MediaItem, PostRecord } from '$lib/types';

const API_BASE = 'https://api.redgifs.com/v2';
const TOKEN_STORAGE_KEY = 'subglass:redgifs-token';
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MAX_CONCURRENT_REQUESTS = 4;
const REQUEST_TIMEOUT_MS = 8000;
const CORS_ALLOWED_BROWSER_ORIGINS = new Set([
  'http://localhost:3000',
  'http://localhost:5173',
]);

interface StoredRedgifsToken {
  token: string;
  expiresAt: number;
}

interface RedgifsAuthResponse {
  token?: string;
}

interface RedgifsGifResponse {
  gif?: RedgifsGif;
}

interface RedgifsGif {
  id?: string;
  duration?: number;
  hasAudio?: boolean;
  height?: number;
  width?: number;
  urls?: {
    hd?: string;
    sd?: string;
    silent?: string;
    html?: string;
    poster?: string;
    thumbnail?: string;
  };
}

type RedgifsResolveResult =
  | { ok: true; media: MediaGroup }
  | { ok: false; reason: string; media: MediaGroup };

let tokenCache: StoredRedgifsToken | null = null;
let tokenRequest: Promise<string> | null = null;
const gifRequestCache = new Map<string, Promise<RedgifsGif>>();

function nowMs() {
  return Date.now();
}

function getOriginBlockReason(): string | null {
  if (typeof window === 'undefined') return null;
  const originCheck = import.meta.env.VITE_SUBGLASS_REDGIFS_API_ORIGIN_CHECK as string | undefined;
  if (originCheck === 'off') return null;
  if (CORS_ALLOWED_BROWSER_ORIGINS.has(window.location.origin)) return null;

  return `Redgifs API CORS does not allow ${window.location.origin}; use http://localhost:5173 or set VITE_SUBGLASS_REDGIFS_API_ORIGIN_CHECK=off to probe anyway`;
}

function isTokenUsable(token: StoredRedgifsToken | null): token is StoredRedgifsToken {
  return Boolean(token?.token && token.expiresAt - TOKEN_REFRESH_MARGIN_MS > nowMs());
}

function readStoredToken(): StoredRedgifsToken | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredRedgifsToken;
    return isTokenUsable(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredToken(token: StoredRedgifsToken) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(token));
  } catch {
    // Ignore storage failures in private mode or restricted environments.
  }
}

function decodeJwtExpiresAt(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;

  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const decoded = JSON.parse(atob(padded)) as { exp?: number };
    return typeof decoded.exp === 'number' ? decoded.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

async function fetchTemporaryToken(): Promise<string> {
  const res = await fetchWithTimeout(`${API_BASE}/auth/temporary`, {
    headers: { accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Redgifs auth HTTP ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as RedgifsAuthResponse;
  if (!data.token) {
    throw new Error('Redgifs auth response did not include a token');
  }

  const stored = {
    token: data.token,
    expiresAt: decodeJwtExpiresAt(data.token) ?? nowMs() + 12 * 60 * 60 * 1000,
  };
  tokenCache = stored;
  writeStoredToken(stored);
  return stored.token;
}

async function getTemporaryToken(forceRefresh = false): Promise<string> {
  const cached = tokenCache;
  if (!forceRefresh && isTokenUsable(cached)) return cached.token;

  if (!forceRefresh) {
    const stored = readStoredToken();
    if (stored) {
      tokenCache = stored;
      return stored.token;
    }
  }

  if (!tokenRequest || forceRefresh) {
    tokenRequest = fetchTemporaryToken().finally(() => {
      tokenRequest = null;
    });
  }

  return tokenRequest;
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function extractPathId(url: URL): string | undefined {
  const parts = url.pathname.split('/').filter(Boolean);
  const markerIndex = parts.findIndex((part) => ['watch', 'ifr'].includes(part.toLowerCase()));
  const id = markerIndex >= 0 ? parts[markerIndex + 1] : parts[0];
  return id?.replace(/[^a-z0-9_-]/gi, '') || undefined;
}

export function extractRedgifsId(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value, 'https://www.redgifs.com');
    if (!/(^|\.)redgifs\.com$/i.test(url.hostname)) return undefined;
    return extractPathId(url)?.toLowerCase();
  } catch {
    return undefined;
  }
}

function getRedgifsId(item: MediaItem) {
  return item.externalId ||
    extractRedgifsId(item.openUrl) ||
    extractRedgifsId(item.embedUrl) ||
    extractRedgifsId(item.url);
}

function choosePlaybackUrl(gif: RedgifsGif): string | undefined {
  return gif.urls?.hd || gif.urls?.sd || gif.urls?.silent;
}

function inferVideoMimeType(item: MediaItem): string | undefined {
  if (item.mimeType) return item.mimeType;
  return item.fallbackVideoUrl && /\.mp4(?:$|\?)/i.test(item.fallbackVideoUrl)
    ? 'video/mp4'
    : undefined;
}

function buildRedgifsVideoMedia(media: MediaGroup, item: MediaItem, gif: RedgifsGif): MediaGroup | undefined {
  const playbackUrl = choosePlaybackUrl(gif);
  if (!playbackUrl) return undefined;

  const externalId = (gif.id || getRedgifsId(item))?.toLowerCase();
  const nextItem: MediaItem = {
    ...item,
    url: playbackUrl,
    width: gif.width ?? item.width,
    height: gif.height ?? item.height,
    mimeType: 'video/mp4',
    openUrl: item.openUrl ?? (externalId ? `https://www.redgifs.com/watch/${externalId}` : undefined),
    embedUrl: gif.urls?.html ?? item.embedUrl,
    provider: 'redgifs',
    externalId,
    durationSeconds: gif.duration ?? item.durationSeconds,
    hasAudio: gif.hasAudio,
  };

  return {
    ...media,
    kind: 'video',
    items: [nextItem],
    thumbnailUrl: gif.urls?.poster || gif.urls?.thumbnail || media.thumbnailUrl || item.url,
  };
}

function buildRedgifsPreviewVideoMedia(media: MediaGroup, item: MediaItem): MediaGroup | undefined {
  if (!item.fallbackVideoUrl) return undefined;

  const externalId = getRedgifsId(item)?.toLowerCase();
  const nextItem: MediaItem = {
    ...item,
    url: item.fallbackVideoUrl,
    mimeType: inferVideoMimeType(item),
    openUrl: item.openUrl ?? (externalId ? `https://www.redgifs.com/watch/${externalId}` : undefined),
    provider: 'redgifs',
    externalId,
  };

  return {
    ...media,
    kind: 'video',
    items: [nextItem],
    thumbnailUrl: media.thumbnailUrl || item.url,
  };
}

async function fetchGif(id: string, refreshedToken = false): Promise<RedgifsGif> {
  const token = await getTemporaryToken(refreshedToken);
  const res = await fetchWithTimeout(`${API_BASE}/gifs/${encodeURIComponent(id)}`, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    },
  });

  if (res.status === 401 && !refreshedToken) {
    tokenCache = null;
    return fetchGif(id, true);
  }

  if (!res.ok) {
    throw new Error(`Redgifs gif HTTP ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as RedgifsGifResponse;
  if (!data.gif) {
    throw new Error('Redgifs gif response did not include gif metadata');
  }

  return data.gif;
}

async function getGif(id: string): Promise<RedgifsGif> {
  const normalizedId = id.toLowerCase();
  let request = gifRequestCache.get(normalizedId);
  if (!request) {
    request = fetchGif(normalizedId).catch((error) => {
      gifRequestCache.delete(normalizedId);
      throw error;
    });
    gifRequestCache.set(normalizedId, request);
  }
  return request;
}

async function resolveRedgifsMedia(media: MediaGroup): Promise<RedgifsResolveResult> {
  const item = media.items[0];
  const id = item ? getRedgifsId(item) : undefined;
  if (!item || !id) {
    return { ok: false, reason: 'missing Redgifs id', media };
  }

  const originBlockReason = getOriginBlockReason();
  if (originBlockReason) {
    const previewFallback = buildRedgifsPreviewVideoMedia(media, item);
    if (previewFallback) {
      console.info('[redgifs]', 'using Reddit preview video fallback', id, originBlockReason);
      return { ok: true, media: previewFallback };
    }

    console.warn('[redgifs]', 'fallback to iframe', id, originBlockReason);
    return { ok: false, reason: originBlockReason, media };
  }

  try {
    const gif = await getGif(id);
    const resolved = buildRedgifsVideoMedia(media, item, gif);
    if (!resolved) {
      const previewFallback = buildRedgifsPreviewVideoMedia(media, item);
      if (previewFallback) {
        console.info('[redgifs]', 'using Reddit preview video fallback', id, 'missing Redgifs playback URL');
        return { ok: true, media: previewFallback };
      }

      return { ok: false, reason: 'missing Redgifs playback URL', media };
    }

    console.info('[redgifs]', 'resolved', id, `${gif.duration ?? '?'}s`, resolved.items[0]?.url);
    return { ok: true, media: resolved };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const previewFallback = buildRedgifsPreviewVideoMedia(media, item);
    if (previewFallback) {
      console.info('[redgifs]', 'using Reddit preview video fallback', id, reason);
      return { ok: true, media: previewFallback };
    }

    console.warn('[redgifs]', 'fallback to iframe', id, reason);
    return { ok: false, reason, media };
  }
}

function isRedgifsExternalMedia(media: MediaGroup | undefined): media is MediaGroup {
  const item = media?.items[0];
  return Boolean(
    media?.kind === 'external_video' &&
      item &&
      (
        item.provider === 'redgifs' ||
        extractRedgifsId(item.openUrl) ||
        extractRedgifsId(item.embedUrl) ||
        extractRedgifsId(item.url)
      )
  );
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<U>
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );

  return results;
}

export async function enrichRedgifsPosts(posts: PostRecord[]): Promise<PostRecord[]> {
  const candidates = posts.flatMap((post) =>
    isRedgifsExternalMedia(post.media) ? [{ post, media: post.media }] : []
  );
  if (candidates.length === 0) return posts;

  const resolved = await mapWithConcurrency(
    candidates,
    MAX_CONCURRENT_REQUESTS,
    async ({ post, media }) => ({
      postId: post.id,
      result: await resolveRedgifsMedia(media),
    })
  );

  const resolvedByPostId = new Map(
    resolved.map(({ postId, result }) => [postId, result.media])
  );

  return posts.map((post) => {
    const media = resolvedByPostId.get(post.id);
    return media ? { ...post, media } : post;
  });
}
