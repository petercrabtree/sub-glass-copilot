import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';
import { DEFAULT_SMOKE_ROUTE_PATH } from '../dev/smoke-config.mjs';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;
const DEFAULT_ITERATIONS = 1;
const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MOCK_REDDIT_BASE_URL = '/__mock/reddit';
const DEFAULT_LIVE_REDDIT_BASE_URL = 'https://old.reddit.com';
const DEFAULT_REDDIT_SOURCE = 'mock';
const DEFAULT_VIEWPORT = { width: 1440, height: 1024, deviceScaleFactor: 1 };
const CHROME_VERSION = '146.0.7680.178';
const DESKTOP_USER_AGENT =
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;
const USER_AGENT_METADATA = {
  platform: 'macOS',
  platformVersion: '15.0.0',
  architecture: 'x86',
  model: '',
  mobile: false,
  fullVersion: CHROME_VERSION,
  brands: [
    { brand: 'Google Chrome', version: '146' },
    { brand: 'Chromium', version: '146' },
    { brand: 'Not.A/Brand', version: '24' }
  ]
};

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'
].filter(Boolean);

const args = process.argv.slice(2);
const loop = args.includes('--loop');
const headful = args.includes('--headful') || process.env.HEADLESS_SMOKE_HEADLESS === 'false';
const iterations = getIntegerArg('--iterations', process.env.HEADLESS_SMOKE_ITERATIONS, DEFAULT_ITERATIONS);
const intervalMs = getIntegerArg('--interval-ms', process.env.HEADLESS_SMOKE_INTERVAL_MS, DEFAULT_INTERVAL_MS);
const host = getStringArg('--host', process.env.HEADLESS_SMOKE_HOST, DEFAULT_HOST);
const port = getIntegerArg('--port', process.env.HEADLESS_SMOKE_PORT, DEFAULT_PORT);
const baseUrlArg = getStringArg('--base-url', process.env.HEADLESS_SMOKE_BASE_URL, '');
const redditSource = getChoiceArg(
  '--reddit-source',
  process.env.HEADLESS_SMOKE_REDDIT_SOURCE,
  ['mock', 'live'],
  DEFAULT_REDDIT_SOURCE
);
const defaultRedditBaseUrl =
  redditSource === 'live' ? DEFAULT_LIVE_REDDIT_BASE_URL : DEFAULT_MOCK_REDDIT_BASE_URL;
const redditBaseUrl = getStringArg(
  '--reddit-base-url',
  process.env.HEADLESS_SMOKE_REDDIT_BASE_URL,
  defaultRedditBaseUrl
);
const timeoutMs = getIntegerArg('--timeout-ms', process.env.HEADLESS_SMOKE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
const viewerPath = getStringArg(
  '--viewer-path',
  process.env.HEADLESS_SMOKE_VIEWER_PATH,
  DEFAULT_SMOKE_ROUTE_PATH
);
const ROUTES = [
  { name: 'viewer-default', path: viewerPath, kind: 'viewer' },
  { name: 'discover', path: '/discover', kind: 'discover' },
  { name: 'admin', path: '/admin', kind: 'admin' }
];
const baseUrl = baseUrlArg || `http://${host}:${port}`;
const shouldSpawnServer = !baseUrlArg;
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = path.join(process.cwd(), 'build', 'headless-smoke', runId);
const serverLogs = [];
const summary = {
  runId,
  startedAt: new Date().toISOString(),
  baseUrl,
  redditSource,
  redditBaseUrl,
  shouldSpawnServer,
  loop,
  iterationsRequested: loop ? 'infinite' : iterations,
  chromePath: null,
  outputDir: relativePath(outputDir),
  viewerPath,
  routes: ROUTES,
  iterations: []
};

let browser;
let devServer;
let stopRequested = false;

process.on('SIGINT', () => {
  stopRequested = true;
});

process.on('SIGTERM', () => {
  stopRequested = true;
});

async function main() {
  await mkdir(outputDir, { recursive: true });

  const chromePath = await findChromeExecutable();
  summary.chromePath = chromePath;

  if (shouldSpawnServer) {
    devServer = startDevServer(host, port, redditBaseUrl);
    await waitForServer(baseUrl, timeoutMs, devServer);
  }

  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: !headful,
    userDataDir: path.join(outputDir, 'chrome-profile'),
    defaultViewport: DEFAULT_VIEWPORT,
    args: [
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-popup-blocking',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-default-browser-check',
      '--no-first-run',
      '--window-size=1440,1024'
    ]
  });

  let iterationIndex = 0;
  const maxIterations = loop ? Number.POSITIVE_INFINITY : iterations;
  while (!stopRequested && iterationIndex < maxIterations) {
    iterationIndex += 1;
    const iterationDir = path.join(outputDir, `iteration-${String(iterationIndex).padStart(2, '0')}`);
    await mkdir(iterationDir, { recursive: true });

    const iterationRecord = {
      index: iterationIndex,
      startedAt: new Date().toISOString(),
      outputDir: relativePath(iterationDir),
      routes: []
    };
    summary.iterations.push(iterationRecord);

    for (const route of ROUTES) {
      if (stopRequested) break;
      const result = await captureRoute(route, iterationDir);
      iterationRecord.routes.push(result);
      await persistSummary();
    }

    iterationRecord.finishedAt = new Date().toISOString();
    await persistSummary();

    if (stopRequested || iterationIndex >= maxIterations) break;
    await delay(intervalMs);
  }

  summary.finishedAt = new Date().toISOString();
  if (serverLogs.length > 0) {
    await writeFile(path.join(outputDir, 'server.log'), serverLogs.join(''), 'utf8');
    summary.serverLog = relativePath(path.join(outputDir, 'server.log'));
  }

  await persistSummary();

  const failures = summary.iterations.flatMap((iteration) =>
    iteration.routes.filter((route) => !route.ok)
  );

  console.log(`Headless smoke artifacts: ${outputDir}`);
  for (const iteration of summary.iterations) {
    for (const route of iteration.routes) {
      console.log(
        `${route.ok ? 'PASS' : 'FAIL'} ${route.name} ${route.primaryScreenshot ?? ''}`.trim()
      );
    }
  }

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

async function captureRoute(route, iterationDir) {
  const page = await browser.newPage();
  await configurePage(page);
  const routePrefix = path.join(iterationDir, route.name);
  const consoleMessages = [];
  const pageErrors = [];
  const failedRequests = [];
  const requestLog = [];
  const responseLog = [];
  const startedAt = new Date().toISOString();

  page.on('console', (message) => {
    consoleMessages.push({
      type: message.type(),
      text: message.text(),
      location: message.location()
    });
  });

  page.on('pageerror', (error) => {
    pageErrors.push(serializeError(error));
  });

  page.on('requestfailed', (request) => {
    failedRequests.push({
      method: request.method(),
      url: request.url(),
      errorText: request.failure()?.errorText ?? 'unknown'
    });
  });

  page.on('request', (request) => {
    if (!isTrackedRedditUrl(request.url())) return;
    requestLog.push({
      method: request.method(),
      url: request.url(),
      headers: request.headers()
    });
  });

  page.on('response', async (response) => {
    if (!isTrackedRedditUrl(response.url())) return;
    const headers = response.headers();
    const contentType = headers['content-type'] || '';
    let bodyPreview;

    if (contentType.includes('application/json')) {
      try {
        bodyPreview = limitString(await response.text(), 2500);
      } catch {
        bodyPreview = '[unavailable]';
      }
    }

    responseLog.push({
      url: response.url(),
      status: response.status(),
      headers,
      bodyPreview
    });
  });

  try {
    let result;
    if (route.kind === 'viewer') {
      result = await captureViewerRoute(page, route, routePrefix, timeoutMs);
    } else if (route.kind === 'discover') {
      result = await captureDiscoverRoute(page, route, routePrefix, timeoutMs);
    } else {
      result = await captureAdminRoute(page, route, routePrefix, timeoutMs);
    }

    const finishedAt = new Date().toISOString();
    const routeResult = {
      ...result,
      name: route.name,
      kind: route.kind,
      path: route.path,
      startedAt,
      finishedAt,
      durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
      consoleMessages,
      pageErrors,
      failedRequests,
      requestLog,
      responseLog
    };

    routeResult.ok =
      result.ok &&
      routeResult.pageErrors.length === 0 &&
      !routeResult.failedRequests.some((request) => request.url.includes('/@vite/client'));

    await writeFile(`${routePrefix}.json`, JSON.stringify(routeResult, null, 2), 'utf8');
    return routeResult;
  } catch (error) {
    const errorResult = {
      name: route.name,
      kind: route.kind,
      path: route.path,
      ok: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: serializeError(error),
      consoleMessages,
      pageErrors,
      failedRequests,
      requestLog,
      responseLog
    };

    try {
      const failureScreenshot = `${routePrefix}-failure.png`;
      await page.screenshot({ path: failureScreenshot, fullPage: true });
      errorResult.primaryScreenshot = relativePath(failureScreenshot);
    } catch {
      // Ignore secondary screenshot failures.
    }

    await writeFile(`${routePrefix}.json`, JSON.stringify(errorResult, null, 2), 'utf8');
    return errorResult;
  } finally {
    await page.close();
  }
}

async function captureViewerRoute(page, route, routePrefix, routeTimeoutMs) {
  const response = await page.goto(new URL(route.path, baseUrl).toString(), {
    waitUntil: 'domcontentloaded',
    timeout: routeTimeoutMs
  });

  await page.waitForSelector('.viewer-page', { timeout: routeTimeoutMs });
  await page.waitForFunction(() => {
    const viewer = document.querySelector('.viewer-page');
    if (!viewer) return false;
    const status = viewer.getAttribute('data-feed-status') ?? '';
    return status === 'ready' || status.startsWith('error:');
  }, { timeout: routeTimeoutMs });

  await waitForOptionalSelector(
    page,
    '.media-img.loaded, .media-video, .media-embed-frame, .media-error, .media-unknown, .error',
    5000
  );

  await page.mouse.move(120, 120);

  const initialState = await page.evaluate(collectViewerState);
  const primaryScreenshotPath = `${routePrefix}.png`;
  await page.screenshot({ path: primaryScreenshotPath, fullPage: true });

  let interaction = null;
  if (initialState.feedStatus === 'ready') {
    interaction = await exerciseViewerAdvance(page, routePrefix);
  }

  return {
    ok: initialState.feedStatus === 'ready' && (interaction?.ok ?? true),
    response: serializeResponse(response),
    locationPath: initialState.locationPath,
    state: initialState,
    interaction,
    primaryScreenshot: relativePath(primaryScreenshotPath)
  };
}

async function captureDiscoverRoute(page, route, routePrefix, routeTimeoutMs) {
  const response = await page.goto(new URL(route.path, baseUrl).toString(), {
    waitUntil: 'domcontentloaded',
    timeout: routeTimeoutMs
  });

  await page.waitForSelector('.discover-page', { timeout: routeTimeoutMs });
  await page.waitForFunction(() => {
    const pageRoot = document.querySelector('.discover-page');
    if (!pageRoot) return false;
    return !document.querySelector('.loading');
  }, { timeout: routeTimeoutMs });

  const state = await page.evaluate(() => ({
    locationPath: window.location.pathname,
    documentTitle: document.title,
    suggestionCount: document.querySelectorAll('.suggestion-card').length,
    subredditCount: document.querySelectorAll('.sub-row').length,
    emptyVisible: Boolean(document.querySelector('.empty')),
    loadingVisible: Boolean(document.querySelector('.loading'))
  }));

  const primaryScreenshotPath = `${routePrefix}.png`;
  await page.screenshot({ path: primaryScreenshotPath, fullPage: true });

  return {
    ok: !state.loadingVisible,
    response: serializeResponse(response),
    locationPath: state.locationPath,
    state,
    primaryScreenshot: relativePath(primaryScreenshotPath)
  };
}

async function captureAdminRoute(page, route, routePrefix, routeTimeoutMs) {
  const response = await page.goto(new URL(route.path, baseUrl).toString(), {
    waitUntil: 'domcontentloaded',
    timeout: routeTimeoutMs
  });

  await page.waitForSelector('.admin-page', { timeout: routeTimeoutMs });
  await page.waitForFunction(() => {
    const pageRoot = document.querySelector('.admin-page');
    if (!pageRoot) return false;
    return !document.querySelector('.loading');
  }, { timeout: routeTimeoutMs });

  const state = await page.evaluate(() => ({
    locationPath: window.location.pathname,
    documentTitle: document.title,
    activeTab: document.querySelector('.tab.active')?.textContent?.trim() ?? null,
    loadingVisible: Boolean(document.querySelector('.loading')),
    statCards: Array.from(document.querySelectorAll('.stat-card')).map((card) => ({
      label: card.querySelector('.stat-label')?.textContent?.trim() ?? null,
      value: card.querySelector('.stat-value')?.textContent?.trim() ?? null
    }))
  }));

  const primaryScreenshotPath = `${routePrefix}.png`;
  await page.screenshot({ path: primaryScreenshotPath, fullPage: true });

  return {
    ok: !state.loadingVisible,
    response: serializeResponse(response),
    locationPath: state.locationPath,
    state,
    primaryScreenshot: relativePath(primaryScreenshotPath)
  };
}

async function exerciseViewerAdvance(page, routePrefix) {
  const beforeCounter = await page.$eval(
    '.counter',
    (element) => element.textContent?.trim() ?? null
  );
  const [currentIndex, totalPosts] = parseCounter(beforeCounter);
  if (!totalPosts || totalPosts <= currentIndex) {
    return {
      ok: true,
      skipped: true,
      reason: 'Only one visible post was available in the current capture.'
    };
  }

  try {
    await page.hover('.overlay');
    await page.click('.nav-zone.right');
    await page.waitForFunction(
      (counterText) => document.querySelector('.counter')?.textContent?.trim() !== counterText,
      { timeout: 10000 },
      beforeCounter?.trim() ?? ''
    );
    await delay(750);

    const afterState = await page.evaluate(collectViewerState);
    const galleryInteraction = await exerciseGalleryZones(page);
    const screenshotPath = `${routePrefix}-after-next.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });

    return {
      ok: afterState.counter !== beforeCounter?.trim() && (galleryInteraction?.ok ?? true),
      beforeCounter: beforeCounter?.trim() ?? null,
      afterCounter: afterState.counter,
      afterState,
      galleryInteraction,
      screenshot: relativePath(screenshotPath)
    };
  } catch (error) {
    return {
      ok: false,
      beforeCounter: beforeCounter?.trim() ?? null,
      error: serializeError(error)
    };
  }
}

async function exerciseGalleryZones(page) {
  const galleryState = await navigateToGalleryPost(page);
  if (!galleryState.ok) return galleryState;
  if (galleryState.skipped) return galleryState;

  const galleryStart = await page.evaluate(collectViewerState);
  const startPostCounter = galleryStart.counter?.trim() ?? null;
  const startGalleryCounter = galleryStart.galleryCounter?.trim() ?? null;

  if (!startPostCounter || !startGalleryCounter) {
    return {
      ok: false,
      error: { message: 'Gallery state was expected but not available.' }
    };
  }

  try {
    await page.click('.nav-zone.bottom');
    await page.waitForFunction(
      ({ galleryCounter, postCounter }) => {
        const currentGallery = document.querySelector('.gallery-counter')?.textContent?.trim() ?? null;
        const currentPost = document.querySelector('.counter')?.textContent?.trim() ?? null;
        return currentGallery !== galleryCounter && currentPost === postCounter;
      },
      { timeout: 10000 },
      { galleryCounter: startGalleryCounter, postCounter: startPostCounter }
    );
    await delay(250);
    const afterBottom = await page.evaluate(collectViewerState);

    await page.click('.nav-zone.top');
    await page.waitForFunction(
      ({ galleryCounter, postCounter }) => {
        const currentGallery = document.querySelector('.gallery-counter')?.textContent?.trim() ?? null;
        const currentPost = document.querySelector('.counter')?.textContent?.trim() ?? null;
        return currentGallery === galleryCounter && currentPost === postCounter;
      },
      { timeout: 10000 },
      { galleryCounter: startGalleryCounter, postCounter: startPostCounter }
    );
    await delay(250);
    const afterTop = await page.evaluate(collectViewerState);

    await page.click('.nav-zone.top-left');
    await page.waitForFunction(
      (counterText) => document.querySelector('.counter')?.textContent?.trim() !== counterText,
      { timeout: 10000 },
      startPostCounter
    );
    await delay(250);
    const afterTopLeft = await page.evaluate(collectViewerState);

    await page.click('.nav-zone.right');
    await page.waitForFunction(
      (counterText) => document.querySelector('.counter')?.textContent?.trim() !== counterText,
      { timeout: 10000 },
      afterTopLeft.counter?.trim() ?? ''
    );
    await delay(250);
    const galleryReset = await page.evaluate(collectViewerState);

    await page.click('.nav-zone.bottom-right');
    await page.waitForFunction(
      ({ galleryCounter, postCounter }) => {
        const currentGallery = document.querySelector('.gallery-counter')?.textContent?.trim() ?? null;
        const currentPost = document.querySelector('.counter')?.textContent?.trim() ?? null;
        return currentGallery !== galleryCounter && currentPost === postCounter;
      },
      { timeout: 10000 },
      {
        galleryCounter: galleryReset.galleryCounter?.trim() ?? '',
        postCounter: galleryReset.counter?.trim() ?? ''
      }
    );
    await delay(250);
    const afterBottomRightGallery = await page.evaluate(collectViewerState);

    await page.click('.nav-zone.bottom-right');
    await page.waitForFunction(
      (counterText) => document.querySelector('.counter')?.textContent?.trim() !== counterText,
      { timeout: 10000 },
      afterBottomRightGallery.counter?.trim() ?? ''
    );
    await delay(250);
    const afterBottomRightFallback = await page.evaluate(collectViewerState);

    return {
      ok:
        afterBottom.counter === startPostCounter &&
        afterBottom.galleryCounter !== startGalleryCounter &&
        afterTop.counter === startPostCounter &&
        afterTop.galleryCounter === startGalleryCounter &&
        afterTopLeft.counter !== startPostCounter &&
        galleryReset.galleryCounter === startGalleryCounter &&
        afterBottomRightGallery.counter === galleryReset.counter &&
        afterBottomRightGallery.galleryCounter !== galleryReset.galleryCounter &&
        afterBottomRightFallback.counter !== afterBottomRightGallery.counter,
      startPostCounter,
      startGalleryCounter,
      afterBottom,
      afterTop,
      afterTopLeft,
      galleryReset,
      afterBottomRightGallery,
      afterBottomRightFallback
    };
  } catch (error) {
    return {
      ok: false,
      startPostCounter,
      startGalleryCounter,
      error: serializeError(error)
    };
  }
}

async function navigateToGalleryPost(page) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const state = await page.evaluate(collectViewerState);
    if (state.galleryCounter) {
      return {
        ok: true,
        skipped: false,
        state
      };
    }

    const [currentIndex, totalPosts] = parseCounter(state.counter);
    if (!totalPosts || currentIndex >= totalPosts) {
      return {
        ok: true,
        skipped: true,
        reason: 'No gallery post was available in the current fixture set.'
      };
    }

    await page.click('.nav-zone.right');
    await page.waitForFunction(
      (counterText) => document.querySelector('.counter')?.textContent?.trim() !== counterText,
      { timeout: 10000 },
      state.counter?.trim() ?? ''
    );
    await delay(250);
  }

  return {
    ok: true,
    skipped: true,
    reason: 'Timed out looking for a gallery post in the current fixture set.'
  };
}

function collectViewerState() {
  const viewer = document.querySelector('.viewer-page');
  const counter = document.querySelector('.counter')?.textContent?.trim() ?? null;
  return {
    locationPath: window.location.pathname,
    documentTitle: document.title,
    feedStatus: viewer?.getAttribute('data-feed-status') ?? null,
    counter,
    galleryCounter: document.querySelector('.gallery-counter')?.textContent?.trim() ?? null,
    postTitle: document.querySelector('.post-title')?.textContent?.trim() ?? null,
    subreddit: document.querySelector('.subreddit')?.textContent?.trim() ?? null,
    hasImage: Boolean(document.querySelector('img.media-img')),
    hasVideo: Boolean(document.querySelector('video.media-video, iframe.media-embed-frame')),
    mediaErrorVisible: Boolean(document.querySelector('.media-error')),
    errorTitle: document.querySelector('.error-title')?.textContent?.trim() ?? null,
    errorSummary: document.querySelector('.error-summary')?.textContent?.trim() ?? null,
    loadingVisible: Boolean(document.querySelector('.loading')),
    emptyVisible: Boolean(document.querySelector('.empty'))
  };
}

function parseCounter(counterText) {
  const match = counterText?.match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return [0, 0];
  return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10)];
}

async function waitForOptionalSelector(page, selector, timeout) {
  try {
    await page.waitForSelector(selector, { timeout });
  } catch {
    // Optional readiness only.
  }
}

async function configurePage(page) {
  const client = await page.createCDPSession();
  await client.send('Network.enable');
  await client.send('Network.setUserAgentOverride', {
    userAgent: DESKTOP_USER_AGENT,
    acceptLanguage: 'en-US,en;q=0.9',
    platform: 'macOS',
    userAgentMetadata: USER_AGENT_METADATA
  });
  await page.setExtraHTTPHeaders({
    'accept-language': 'en-US,en;q=0.9'
  });
}

function startDevServer(hostValue, portValue, redditBaseUrlValue) {
  const child = spawn('bun', ['run', 'dev', '--host', hostValue, '--port', String(portValue)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BROWSER: 'none',
      VITE_SUBGLASS_REDDIT_BASE_URL: redditBaseUrlValue
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (chunk) => {
    serverLogs.push(chunk.toString());
  });

  child.stderr.on('data', (chunk) => {
    serverLogs.push(chunk.toString());
  });

  return child;
}

function isTrackedRedditUrl(url) {
  return (
    url.includes('/__mock/reddit/') ||
    url.includes('old.reddit.com/') ||
    url.includes('www.reddit.com/') ||
    url.includes('api.reddit.com/')
  );
}

async function waitForServer(url, timeout, child) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Dev server exited before becoming ready (code ${child.exitCode}).`);
    }

    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Keep polling until the timeout expires.
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for ${url} after ${timeout}ms.`);
}

async function findChromeExecutable() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(
    'Could not find a Chrome executable. Set CHROME_BIN to a local Chrome or Chromium binary.'
  );
}

function serializeResponse(response) {
  return response
    ? {
        url: response.url(),
        status: response.status(),
        ok: response.ok()
      }
    : null;
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  return { message: String(error) };
}

function limitString(value, maxLength) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

async function persistSummary() {
  await writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
}

function relativePath(targetPath) {
  return path.relative(process.cwd(), targetPath) || '.';
}

function getStringArg(flag, envValue, fallback) {
  const argValue = readFlagValue(flag);
  if (typeof argValue === 'string' && argValue.length > 0) return argValue;
  if (typeof envValue === 'string' && envValue.length > 0) return envValue;
  return fallback;
}

function getIntegerArg(flag, envValue, fallback) {
  const rawValue = readFlagValue(flag) ?? envValue;
  if (typeof rawValue !== 'string' || rawValue.trim() === '') return fallback;
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getChoiceArg(flag, envValue, allowedValues, fallback) {
  const rawValue = readFlagValue(flag) ?? envValue;
  if (typeof rawValue !== 'string') return fallback;
  return allowedValues.includes(rawValue) ? rawValue : fallback;
}

function readFlagValue(flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

async function shutdown() {
  if (browser) {
    await browser.close();
  }

  if (devServer && devServer.exitCode === null) {
    devServer.kill('SIGTERM');
    await delay(500);
    if (devServer.exitCode === null) {
      devServer.kill('SIGKILL');
    }
  }
}

try {
  await main();
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.error = serializeError(error);
  await persistSummary();
  throw error;
} finally {
  await shutdown();
}
