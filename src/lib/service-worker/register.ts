import { base } from '$app/paths';

function getServiceWorkerScope(): string {
  return base ? `${base}/` : '/';
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return undefined;

  return navigator.serviceWorker
    .register(`${base}/service-worker.js`, { scope: getServiceWorkerScope() })
    .catch((error) => {
      console.warn('[subglass] Failed to register service worker', error);
      return undefined;
    });
}
