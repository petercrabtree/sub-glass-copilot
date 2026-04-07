export const MEDIA_CACHE_NAME = 'subglass-media-v1';
export const MEDIA_CACHE_MAX_ENTRIES = 160;

export type MediaCacheState =
  | 'cached'
  | 'live'
  | 'checking'
  | 'inactive'
  | 'unsupported'
  | 'skipped';

export type MediaCacheRuntimeState = 'ready' | 'inactive' | 'unsupported';

export type MediaCacheClientMessage = {
  type: 'subglass:media-cache-updated';
  url: string;
};

export type MediaCacheDiagnostics = {
  cacheSupported: boolean;
  serviceWorkerSupported: boolean;
  registrationActive: boolean;
  pageControlled: boolean;
  registrationScope?: string;
  registrationScriptUrl?: string;
  entryCount: number;
  sampleUrls: string[];
};

export function isInspectableMediaUrl(url: string | undefined): url is string {
  if (!url) return false;

  try {
    const resolvedUrl = new URL(url, 'http://subglass.local');
    return resolvedUrl.protocol === 'http:' || resolvedUrl.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function inspectCachedMediaUrls(urls: string[]): Promise<Record<string, boolean>> {
  if (!('caches' in globalThis)) return {};

  const cache = await caches.open(MEDIA_CACHE_NAME);
  const uniqueUrls = [...new Set(urls.filter((url) => isInspectableMediaUrl(url)))];
  const matches = await Promise.all(
    uniqueUrls.map(async (url) => [url, Boolean(await cache.match(url))] as const)
  );

  return Object.fromEntries(matches);
}

export async function getMediaCacheDiagnostics(): Promise<MediaCacheDiagnostics> {
  const cacheSupported = typeof window !== 'undefined' && 'caches' in window;
  const serviceWorkerSupported = typeof window !== 'undefined' && 'serviceWorker' in navigator;

  const diagnostics: MediaCacheDiagnostics = {
    cacheSupported,
    serviceWorkerSupported,
    registrationActive: false,
    pageControlled: false,
    entryCount: 0,
    sampleUrls: [],
  };

  if (cacheSupported) {
    const cache = await caches.open(MEDIA_CACHE_NAME);
    const keys = await cache.keys();
    diagnostics.entryCount = keys.length;
    diagnostics.sampleUrls = keys
      .slice(0, 12)
      .map((request) => request.url);
  }

  if (serviceWorkerSupported) {
    const registration = await navigator.serviceWorker.getRegistration();
    diagnostics.registrationActive = Boolean(registration?.active);
    diagnostics.pageControlled = Boolean(navigator.serviceWorker.controller);
    diagnostics.registrationScope = registration?.scope;
    diagnostics.registrationScriptUrl = registration?.active?.scriptURL ?? registration?.installing?.scriptURL;
  }

  return diagnostics;
}

export async function clearMediaCache(): Promise<boolean> {
  if (typeof window === 'undefined' || !('caches' in window)) return false;
  return caches.delete(MEDIA_CACHE_NAME);
}

export async function updateMediaServiceWorker(): Promise<boolean> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return false;

  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return false;

  await registration.update();
  return true;
}

export async function unregisterMediaServiceWorker(): Promise<boolean> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return false;

  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return false;

  return registration.unregister();
}

export function subscribeToMediaCacheUpdates(callback: (url: string) => void): () => void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return () => {};
  }

  const handleMessage = (event: MessageEvent<MediaCacheClientMessage>) => {
    if (event.data?.type !== 'subglass:media-cache-updated' || typeof event.data.url !== 'string') {
      return;
    }

    callback(event.data.url);
  };

  navigator.serviceWorker.addEventListener('message', handleMessage);

  return () => {
    navigator.serviceWorker.removeEventListener('message', handleMessage);
  };
}
