import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  DEFAULT_SMOKE_FIXTURE_PATHNAME,
  DEFAULT_SMOKE_FIXTURE_POST_COUNT,
  DEFAULT_SMOKE_FIXTURE_SOURCE_LIMIT,
  DEFAULT_SMOKE_FIXTURE_SOURCE_URL,
  DEFAULT_SMOKE_ROUTE_PATH,
  DEFAULT_SMOKE_SORT_PATH,
  DEFAULT_SMOKE_SUBREDDIT_PATH
} from '../dev/smoke-config.mjs';

const OUTPUT_PATH = path.join(process.cwd(), 'dev', 'generated-smoke-fixture.json');
const USER_AGENT =
  process.env.SMOKE_FIXTURE_USER_AGENT || 'subglass-smoke/1.0 (contact: local-dev)';
const SOURCE_LIMIT = readPositiveIntegerArg('--limit', DEFAULT_SMOKE_FIXTURE_SOURCE_LIMIT);
const FIXTURE_POST_COUNT = readPositiveIntegerArg('--count', DEFAULT_SMOKE_FIXTURE_POST_COUNT);
const sourceUrl = buildSourceUrl(SOURCE_LIMIT);

const IMAGE_ASSETS = [
  '/mock-reddit-assets/desert-sunrise.svg',
  '/mock-reddit-assets/city-night.svg',
  '/mock-reddit-assets/gallery-1.svg',
  '/mock-reddit-assets/gallery-2.svg'
];

const GALLERY_ASSET_PAIRS = [
  ['/mock-reddit-assets/gallery-1.svg', '/mock-reddit-assets/gallery-2.svg'],
  ['/mock-reddit-assets/desert-sunrise.svg', '/mock-reddit-assets/city-night.svg']
];

async function main() {
  const response = await fetch(sourceUrl, {
    headers: {
      accept: 'application/json',
      'user-agent': USER_AGENT
    }
  });

  if (!response.ok) {
    throw new Error(`Fixture refresh failed with HTTP ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  const children = Array.isArray(payload?.data?.children) ? payload.data.children : [];
  const sourcePosts = children
    .filter((child) => child?.kind === 't3' && child.data)
    .slice(0, FIXTURE_POST_COUNT)
    .map((child, index) => normalizeSourcePost(child.data, index));

  if (sourcePosts.length === 0) {
    throw new Error('Fixture refresh did not find any Reddit posts to snapshot.');
  }

  const fixtureChildren = sourcePosts.map((post, index) => createFixtureChild(post, index));
  const generatedFixture = {
    source: {
      fetchedAt: new Date().toISOString(),
      userAgent: USER_AGENT,
      sourceUrl,
      subreddit: DEFAULT_SMOKE_SUBREDDIT_PATH.slice('/r/'.length),
      routePath: DEFAULT_SMOKE_ROUTE_PATH,
      subredditPath: DEFAULT_SMOKE_SUBREDDIT_PATH,
      listingPath: DEFAULT_SMOKE_SORT_PATH,
      fixturePathname: DEFAULT_SMOKE_FIXTURE_PATHNAME,
      posts: sourcePosts
    },
    listing: {
      kind: 'Listing',
      data: {
        after: null,
        before: null,
        dist: fixtureChildren.length,
        children: fixtureChildren
      }
    }
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(generatedFixture, null, 2)}\n`, 'utf8');

  console.log(
    `Wrote ${path.relative(process.cwd(), OUTPUT_PATH)} from ${sourcePosts.length} posts in ${DEFAULT_SMOKE_ROUTE_PATH}`
  );
}

function normalizeSourcePost(data, index) {
  return {
    id: String(data.id || `snapshot_${index + 1}`),
    subreddit: String(data.subreddit || 'all'),
    domain: String(data.domain || ''),
    postHint: typeof data.post_hint === 'string' ? data.post_hint : null,
    isGallery: Boolean(data.is_gallery),
    over18: Boolean(data.over_18),
    score: Number(data.score || 0),
    numComments: Number(data.num_comments || 0),
    createdUtc: Number(data.created_utc || 0)
  };
}

function createFixtureChild(post, index) {
  const isGallery = post.isGallery;
  const permalink = `/r/${post.subreddit}/comments/${post.id}/fixture_snapshot/`;
  const title = `Snapshot fixture ${index + 1} from r/${post.subreddit}`;

  if (isGallery) {
    const [firstAsset, secondAsset] = GALLERY_ASSET_PAIRS[index % GALLERY_ASSET_PAIRS.length];
    return {
      kind: 't3',
      data: {
        id: post.id,
        subreddit: post.subreddit,
        title,
        author: 'subglass_snapshot',
        permalink,
        url: firstAsset,
        domain: 'subglass.mock',
        link_flair_text: 'Snapshot',
        over_18: post.over18,
        is_self: false,
        score: post.score,
        num_comments: post.numComments,
        created_utc: post.createdUtc,
        thumbnail: firstAsset,
        is_gallery: true,
        gallery_data: {
          items: [
            { media_id: `${post.id}_gallery_1` },
            { media_id: `${post.id}_gallery_2` }
          ]
        },
        media_metadata: {
          [`${post.id}_gallery_1`]: {
            status: 'valid',
            e: 'Image',
            m: 'image/svg+xml',
            s: {
              u: firstAsset,
              w: 1600,
              h: 900
            }
          },
          [`${post.id}_gallery_2`]: {
            status: 'valid',
            e: 'Image',
            m: 'image/svg+xml',
            s: {
              u: secondAsset,
              w: 1600,
              h: 900
            }
          }
        }
      }
    };
  }

  const assetPath = IMAGE_ASSETS[index % IMAGE_ASSETS.length];

  return {
    kind: 't3',
    data: {
      id: post.id,
      subreddit: post.subreddit,
      title,
      author: 'subglass_snapshot',
      permalink,
      url: assetPath,
      domain: 'subglass.mock',
      link_flair_text: 'Snapshot',
      over_18: post.over18,
      is_self: false,
      score: post.score,
      num_comments: post.numComments,
      created_utc: post.createdUtc,
      thumbnail: assetPath,
      post_hint: 'image',
      preview: {
        images: [
          {
            source: { url: assetPath, width: 1600, height: 900 },
            resolutions: []
          }
        ],
        enabled: true
      }
    }
  };
}

function buildSourceUrl(limit) {
  const url = new URL(DEFAULT_SMOKE_FIXTURE_SOURCE_URL);
  url.searchParams.set('limit', String(limit));
  return url.toString();
}

function readPositiveIntegerArg(flag, fallback) {
  const index = process.argv.indexOf(flag);
  const rawValue = index === -1 ? undefined : process.argv[index + 1];
  if (!rawValue) return fallback;
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
