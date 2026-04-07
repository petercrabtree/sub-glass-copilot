/// <reference lib="webworker" />

import {
  MEDIA_CACHE_MAX_ENTRIES,
  MEDIA_CACHE_NAME,
  type MediaCacheClientMessage,
} from './lib/service-worker/media-cache';

function isHttpRequest(request: Request): boolean {
  const url = new URL(request.url);
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function shouldHandleImageRequest(request: Request): boolean {
  return (
    request.method === 'GET' &&
    request.destination === 'image' &&
    request.cache !== 'no-store' &&
    isHttpRequest(request)
  );
}

function isCacheableResponse(response: Response): boolean {
  return response.ok || response.type === 'opaque';
}

function hasNoStoreDirective(response: Response): boolean {
  const cacheControl = response.headers.get('cache-control');
  return cacheControl
    ?.split(',')
    .some((directive) => directive.trim().toLowerCase() === 'no-store') ?? false;
}

async function trimMediaCache(cache: Cache): Promise<void> {
  const keys = await cache.keys();
  const overflow = keys.length - MEDIA_CACHE_MAX_ENTRIES;

  for (let index = 0; index < overflow; index += 1) {
    await cache.delete(keys[index]);
  }
}

async function broadcastMediaCacheUpdate(url: string): Promise<void> {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const message: MediaCacheClientMessage = {
    type: 'subglass:media-cache-updated',
    url,
  };

  for (const client of clients) {
    client.postMessage(message);
  }
}

async function fetchAndCacheImage(request: Request): Promise<Response | null> {
  try {
    const response = await fetch(request);

    if (!isCacheableResponse(response) || hasNoStoreDirective(response)) {
      return response;
    }

    const cache = await caches.open(MEDIA_CACHE_NAME);
    await cache.put(request, response.clone());
    await trimMediaCache(cache);
    await broadcastMediaCacheUpdate(request.url);

    return response;
  } catch {
    return null;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheKeys = await caches.keys();
    const staleKeys = cacheKeys.filter((key) => key.startsWith('subglass-media-') && key !== MEDIA_CACHE_NAME);

    await Promise.all(staleKeys.map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!shouldHandleImageRequest(request)) return;

  event.respondWith((async () => {
    const cache = await caches.open(MEDIA_CACHE_NAME);
    const cachedResponse = await cache.match(request);
    const networkResponsePromise = fetchAndCacheImage(request);

    if (cachedResponse) {
      event.waitUntil(networkResponsePromise.then(() => undefined));
      return cachedResponse;
    }

    return (await networkResponsePromise) ?? Response.error();
  })());
});
