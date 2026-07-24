import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const SPIKE_DIR = path.dirname(fileURLToPath(import.meta.url));
const USER_SCRIPT_PATH = path.join(SPIKE_DIR, 'subglass-reddit-overlay.user.js');
const SCREENSHOT_PATH = path.join(process.cwd(), 'build', 'overlay-spike-smoke.png');
const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
].filter(Boolean);

const listing = {
  kind: 'Listing',
  data: {
    after: null,
    before: null,
    dist: 4,
    children: [
      {
        kind: 't3',
        data: {
          id: 'spike-image',
          title: 'Overlay spike image',
          subreddit: 'spike',
          author: 'fixture',
          score: 1200,
          num_comments: 42,
          permalink: '/r/spike/comments/spike-image/overlay_spike_image/',
          post_hint: 'image',
          url_overridden_by_dest: '/assets/image.svg',
          preview: {
            images: [{ source: { url: '/assets/image.svg', width: 1600, height: 900 } }],
          },
        },
      },
      {
        kind: 't3',
        data: {
          id: 'spike-video',
          title: 'Overlay spike video',
          subreddit: 'spike',
          author: 'fixture',
          score: 980,
          num_comments: 18,
          permalink: '/r/spike/comments/spike-video/overlay_spike_video/',
          secure_media: {
            reddit_video: {
              fallback_url: '/assets/video.mp4',
            },
          },
          preview: {
            images: [{ source: { url: '/assets/poster.svg', width: 1600, height: 900 } }],
          },
        },
      },
      {
        kind: 't3',
        data: {
          id: 'spike-gallery',
          title: 'Overlay spike gallery',
          subreddit: 'spike',
          author: 'fixture',
          score: 760,
          num_comments: 11,
          permalink: '/r/spike/comments/spike-gallery/overlay_spike_gallery/',
          is_gallery: true,
          gallery_data: {
            items: [{ media_id: 'one' }, { media_id: 'two' }],
          },
          media_metadata: {
            one: { e: 'Image', s: { u: '/assets/gallery-one.svg' } },
            two: { e: 'Image', s: { u: '/assets/gallery-two.svg' } },
          },
        },
      },
      {
        kind: 't3',
        data: {
          id: 'spike-self',
          title: 'Unsupported self post',
          subreddit: 'spike',
          author: 'fixture',
          permalink: '/r/spike/comments/spike-self/unsupported_self_post/',
          is_self: true,
          thumbnail: 'self',
          url: '/r/spike/comments/spike-self/unsupported_self_post/',
        },
      },
    ],
  },
};

const svg = (label, color) => `
  <svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
    <rect width="1600" height="900" fill="${color}" />
    <text x="800" y="450" text-anchor="middle" dominant-baseline="middle"
      fill="white" font-family="system-ui" font-size="92" font-weight="700">${label}</text>
  </svg>
`;

const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');

  if (url.pathname === '/r/blocked/.json') {
    response.writeHead(403, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': '30',
    });
    response.end('<!doctype html><title>Blocked</title><p>Fixture access denied</p>');
    return;
  }

  if (url.pathname.endsWith('/.json')) {
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-ratelimit-remaining': '59',
      'x-ratelimit-reset': '60',
    });
    response.end(JSON.stringify(listing));
    return;
  }

  if (url.pathname.endsWith('.svg')) {
    const label = path.basename(url.pathname, '.svg').replaceAll('-', ' ');
    const color = url.pathname.includes('two') ? '#713b8f' : '#274b72';
    response.writeHead(200, { 'content-type': 'image/svg+xml' });
    response.end(svg(label, color));
    return;
  }

  if (url.pathname.endsWith('.mp4')) {
    response.writeHead(204, { 'content-type': 'video/mp4' });
    response.end();
    return;
  }

  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html>
    <html>
      <head><title>Fake Reddit host</title></head>
      <body>
        <main id="native-reddit">Native Reddit remains mounted</main>
      </body>
    </html>`);
});

let browser;

try {
  const baseUrl = await listen(server);
  const chromePath = await findChrome();
  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    defaultViewport: { width: 1440, height: 960, deviceScaleFactor: 1 },
    args: ['--disable-background-networking', '--disable-dev-shm-usage', '--no-first-run'],
  });

  const page = await browser.newPage();
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(new Error(message.text()));
  });

  await page.goto(`${baseUrl}/r/spike/top/?t=month`, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ path: USER_SCRIPT_PATH });

  await clickShadow(page, '[data-role="launcher"]');
  await page.waitForFunction(() => {
    const host = document.getElementById('subglass-overlay-spike-host');
    return host?.dataset.phase === 'ready' && host.dataset.supportedCount === '3';
  });

  assert.equal(await hostDataset(page, 'open'), 'true');
  assert.equal(await hostDataset(page, 'currentPostId'), 'spike-image');
  const diagnostics = await shadowText(page, '[data-role="diagnostics"]');
  assert.match(diagnostics, /HTTP 200/);
  assert.match(diagnostics, /3\/4 media posts/);
  assert.match(
    diagnostics,
    /remaining 59, reset 60s/,
    'diagnostics should expose HTTP success and fixture rate-limit information',
  );
  assert.equal(
    await shadowTagName(page, '[data-role="stage"] > *'),
    'IMG',
    'the first supported post should render as an image',
  );

  await page.keyboard.press('ArrowRight');
  assert.equal(await hostDataset(page, 'currentPostId'), 'spike-video');
  assert.equal(await shadowTagName(page, '[data-role="stage"] > *'), 'VIDEO');

  await page.keyboard.press('KeyJ');
  assert.equal(await hostDataset(page, 'currentPostId'), 'spike-gallery');
  assert.equal(await hostDataset(page, 'currentMediaIndex'), '0');
  await page.keyboard.press('ArrowRight');
  assert.equal(await hostDataset(page, 'currentMediaIndex'), '1');

  await page.evaluate(() => history.pushState({}, '', '/r/another/new/'));
  await page.waitForFunction(() => {
    const host = document.getElementById('subglass-overlay-spike-host');
    return host?.dataset.phase === 'ready' && host.dataset.routeKey.includes('/r/another/new/.json');
  });

  assert.ok(
    (await shadowText(page, '[data-role="route"]')).includes('r/another · new'),
    'client-side route changes should refresh the overlay context',
  );

  await mkdir(path.dirname(SCREENSHOT_PATH), { recursive: true });
  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
  assert.deepEqual(browserErrors, []);

  await page.evaluate(() => history.pushState({}, '', '/r/blocked/'));
  await page.waitForFunction(() => {
    const host = document.getElementById('subglass-overlay-spike-host');
    return host?.dataset.phase === 'error' && host.dataset.routeKey.includes('/r/blocked/.json');
  });
  assert.match(await shadowText(page, '[data-role="diagnostics"]'), /HTTP 403/);
  assert.match(await shadowText(page, '[data-role="empty"]'), /Fixture access denied/);
  assert.ok(
    browserErrors.some((error) => error.message.includes('403 (Forbidden)')),
    'the browser should report the expected failed fixture request',
  );
  assert.deepEqual(
    browserErrors.filter((error) => !error.message.includes('403 (Forbidden)')),
    [],
    'the expected HTTP failure should not hide unrelated browser errors',
  );

  await page.keyboard.press('Escape');
  assert.equal(await hostDataset(page, 'open'), 'false');
  assert.equal(
    await page.$eval('#native-reddit', (element) => element.textContent),
    'Native Reddit remains mounted',
    'closing the overlay should leave the host page intact',
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.style.overflow),
    '',
    'closing the overlay should restore page scrolling',
  );

  console.log('PASS overlay mounts in an isolated shadow root');
  console.log('PASS same-origin credentialed listing fetch renders image, video, and gallery media');
  console.log('PASS unsupported posts are filtered and HTTP failures remain visible');
  console.log('PASS keyboard navigation and client-side route refresh work');
  console.log('PASS closing restores the untouched host page');
  console.log(`Screenshot: ${SCREENSHOT_PATH}`);
} finally {
  await browser?.close();
  await closeServer(server);
}

async function listen(httpServer) {
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Unable to resolve smoke server address');
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(httpServer) {
  if (!httpServer.listening) return;
  await new Promise((resolve) => httpServer.close(resolve));
}

async function findChrome() {
  const { access } = await import('node:fs/promises');
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error('Chrome was not found. Set CHROME_BIN to run the overlay spike smoke test.');
}

async function clickShadow(page, selector) {
  await page.$eval(
    '#subglass-overlay-spike-host',
    (element, shadowSelector) => element.shadowRoot.querySelector(shadowSelector).click(),
    selector,
  );
}

async function hostDataset(page, key) {
  return page.$eval(
    '#subglass-overlay-spike-host',
    (element, datasetKey) => element.dataset[datasetKey],
    key,
  );
}

async function shadowText(page, selector) {
  return page.$eval(
    '#subglass-overlay-spike-host',
    (element, shadowSelector) => element.shadowRoot.querySelector(shadowSelector).textContent,
    selector,
  );
}

async function shadowTagName(page, selector) {
  return page.$eval(
    '#subglass-overlay-spike-host',
    (element, shadowSelector) => element.shadowRoot.querySelector(shadowSelector).tagName,
    selector,
  );
}
