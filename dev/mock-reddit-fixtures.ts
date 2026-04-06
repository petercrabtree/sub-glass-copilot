type RedditListingChild = {
  kind: 't3';
  data: Record<string, unknown>;
};

type RedditFixtureMap = Record<string, unknown>;

const MOCK_AUTHOR = 'subglass_mock';
const MOCK_CREATED_UTC = 1_775_449_000;

function createImagePost(
  id: string,
  title: string,
  assetPath: string,
  score: number,
  comments: number
): RedditListingChild {
  return {
    kind: 't3',
    data: {
      id,
      subreddit: 'pics',
      title,
      author: MOCK_AUTHOR,
      permalink: `/r/pics/comments/${id}/${id}/`,
      url: assetPath,
      domain: 'subglass.mock',
      link_flair_text: 'Mock',
      over_18: false,
      is_self: false,
      score,
      num_comments: comments,
      created_utc: MOCK_CREATED_UTC,
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

function createGalleryPost(): RedditListingChild {
  return {
    kind: 't3',
    data: {
      id: 'mockgallery1',
      subreddit: 'pics',
      title: 'Mock gallery with two locally served panels',
      author: MOCK_AUTHOR,
      permalink: '/r/pics/comments/mockgallery1/mock_gallery/',
      url: '/mock-reddit-assets/gallery-1.svg',
      domain: 'subglass.mock',
      link_flair_text: 'Gallery',
      over_18: false,
      is_self: false,
      score: 842,
      num_comments: 31,
      created_utc: MOCK_CREATED_UTC - 90,
      thumbnail: '/mock-reddit-assets/gallery-1.svg',
      is_gallery: true,
      gallery_data: {
        items: [
          { media_id: 'gallery_item_1' },
          { media_id: 'gallery_item_2' }
        ]
      },
      media_metadata: {
        gallery_item_1: {
          status: 'valid',
          e: 'Image',
          m: 'image/svg+xml',
          s: {
            u: '/mock-reddit-assets/gallery-1.svg',
            w: 1600,
            h: 900
          }
        },
        gallery_item_2: {
          status: 'valid',
          e: 'Image',
          m: 'image/svg+xml',
          s: {
            u: '/mock-reddit-assets/gallery-2.svg',
            w: 1600,
            h: 900
          }
        }
      }
    }
  };
}

function createListing(children: RedditListingChild[]) {
  return {
    kind: 'Listing',
    data: {
      after: null,
      before: null,
      dist: children.length,
      children
    }
  };
}

function createAbout(name: string) {
  return {
    kind: 't5',
    data: {
      display_name: name,
      title: `Mock r/${name}`,
      public_description: `Fixture-backed mock subreddit for ${name}`,
      description: `Fixture-backed mock subreddit for ${name}`,
      subscribers: 424242,
      over18: false
    }
  };
}

const listing = createListing([
  createImagePost(
    'mockimage1',
    'Mock desert sunrise served from the local smoke proxy',
    '/mock-reddit-assets/desert-sunrise.svg',
    1924,
    67
  ),
  createGalleryPost(),
  createImagePost(
    'mockimage2',
    'Mock city skyline card to verify next-post navigation',
    '/mock-reddit-assets/city-night.svg',
    1502,
    29
  )
]);

export const mockRedditFixtures: RedditFixtureMap = {
  '/r/pics/.json': listing,
  '/r/all/.json': listing,
  '/r/videos/.json': listing,
  '/r/pics/about/.json': createAbout('pics'),
  '/r/all/about/.json': createAbout('all'),
  '/r/videos/about/.json': createAbout('videos')
};
