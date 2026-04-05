import type { PostRecord, MediaGroup, MediaItem } from '$lib/types';

function extractMediaGroup(postData: Record<string, unknown>, postId: string): MediaGroup | undefined {
  const url = postData.url as string || '';
  const domain = postData.domain as string || '';

  // Reddit video (v.redd.it) — check before image so GIFV isn't misclassified
  const redditVideo = (postData.media as Record<string, unknown>)?.reddit_video as Record<string, unknown>;
  if (redditVideo) {
    const items: MediaItem[] = [{
      url: redditVideo.fallback_url as string || url,
      width: redditVideo.width as number,
      height: redditVideo.height as number,
      dashUrl: redditVideo.dash_url as string,
      hlsUrl: redditVideo.hls_url as string,
    }];
    return {
      id: `vid_${postId}`,
      kind: 'video',
      items,
      thumbnailUrl: postData.thumbnail as string || undefined,
      postId,
    };
  }

  // Reddit gallery
  const galleryData = postData.gallery_data as Record<string, unknown>;
  const mediaMetadata = postData.media_metadata as Record<string, Record<string, unknown>>;
  if (galleryData && mediaMetadata) {
    const galleryItems = (galleryData.items as Array<Record<string, unknown>>) || [];
    const items: MediaItem[] = galleryItems
      .map((gi) => {
        const mediaId = gi.media_id as string;
        const meta = mediaMetadata[mediaId];
        if (!meta) return null;
        const s = meta.s as Record<string, unknown>;
        if (s?.u) return { url: (s.u as string).replace(/&amp;/g, '&'), width: s.w as number, height: s.h as number };
        if (s?.gif) return { url: (s.gif as string).replace(/&amp;/g, '&'), width: s.w as number, height: s.h as number };
        return null;
      })
      .filter((x): x is MediaItem => x !== null);

    if (items.length > 0) {
      return {
        id: `gallery_${postId}`,
        kind: 'gallery',
        items,
        thumbnailUrl: postData.thumbnail as string || undefined,
        postId,
      };
    }
  }

  // Reddit-hosted image
  if (domain === 'i.redd.it' || url.match(/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i)) {
    return {
      id: `img_${postId}`,
      kind: 'image',
      items: [{ url }],
      thumbnailUrl: postData.thumbnail as string || undefined,
      postId,
    };
  }

  // imgur direct (common)
  if (domain === 'imgur.com' && !url.includes('/a/') && !url.includes('/gallery/')) {
    const directUrl = url.replace(/imgur\.com\/([a-zA-Z0-9]+)$/, 'i.imgur.com/$1.jpg');
    if (directUrl !== url) {
      return {
        id: `imgur_${postId}`,
        kind: 'external_image',
        items: [{ url: directUrl }],
        thumbnailUrl: postData.thumbnail as string || undefined,
        postId,
      };
    }
  }

  // External image (best-effort)
  if (url.match(/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i)) {
    return {
      id: `ext_img_${postId}`,
      kind: 'external_image',
      items: [{ url }],
      thumbnailUrl: postData.thumbnail as string || undefined,
      postId,
    };
  }

  return undefined;
}

export function normalizePost(rawData: Record<string, unknown>): PostRecord | null {
  const id = rawData.id as string;
  if (!id) return null;

  const media = extractMediaGroup(rawData, id);

  return {
    id,
    fullname: `t3_${id}`,
    subreddit: (rawData.subreddit as string || '').toLowerCase(),
    title: rawData.title as string || '',
    author: rawData.author as string || '[deleted]',
    permalink: rawData.permalink as string || '',
    url: rawData.url as string || '',
    domain: rawData.domain as string || '',
    flair: rawData.link_flair_text as string || undefined,
    isNsfw: Boolean(rawData.over_18),
    isSelf: Boolean(rawData.is_self),
    score: rawData.score as number || 0,
    numComments: rawData.num_comments as number || 0,
    createdAt: (rawData.created_utc as number || 0) * 1000,
    media,
    crosspostParentId: rawData.crosspost_parent as string || undefined,
    rawSnapshot: {
      thumbnail: rawData.thumbnail,
      preview: rawData.preview,
    },
  };
}

export function normalizeListingResponse(
  children: Array<{ kind: string; data: Record<string, unknown> }>
): PostRecord[] {
  return children
    .filter(c => c.kind === 't3')
    .map(c => normalizePost(c.data))
    .filter((p): p is PostRecord => p !== null);
}
