import type { PostRecord, MediaGroup, MediaItem } from '$lib/types';

const IMAGE_URL_PATTERN = /\.(jpg|jpeg|png|gif|webp|svg)(\?.*)?$/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.replace(/&amp;/g, '&');
}

function asVisualUrl(value: unknown): string | undefined {
  const url = asString(value);
  if (!url) return undefined;
  if (!/^(https?:\/\/|\/)/i.test(url)) return undefined;
  return url;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function extractIframeSrc(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const match = html.match(/<iframe[^>]+src=(['"])(.*?)\1/i);
  return asString(match?.[2]);
}

function toVideoItem(videoData: Record<string, unknown>): MediaItem | undefined {
  const fallbackUrl = asString(videoData.fallback_url);
  const dashUrl = asString(videoData.dash_url);
  const hlsUrl = asString(videoData.hls_url);
  const playbackUrl = fallbackUrl || hlsUrl || dashUrl;
  if (!playbackUrl) return undefined;

  return {
    url: playbackUrl,
    width: asNumber(videoData.width),
    height: asNumber(videoData.height),
    mimeType: fallbackUrl ? 'video/mp4' : undefined,
    dashUrl,
    hlsUrl,
  };
}

function extractRedditVideoItem(postData: Record<string, unknown>): MediaItem | undefined {
  const media = asRecord(postData.media);
  const secureMedia = asRecord(postData.secure_media);
  const preview = asRecord(postData.preview);
  const crosspostParent = Array.isArray(postData.crosspost_parent_list)
    ? asRecord(postData.crosspost_parent_list[0])
    : undefined;
  const crosspostMedia = asRecord(crosspostParent?.media);
  const crosspostSecureMedia = asRecord(crosspostParent?.secure_media);
  const crosspostPreview = asRecord(crosspostParent?.preview);

  const candidates = [
    asRecord(media?.reddit_video),
    asRecord(secureMedia?.reddit_video),
    asRecord(preview?.reddit_video_preview),
    asRecord(crosspostMedia?.reddit_video),
    asRecord(crosspostSecureMedia?.reddit_video),
    asRecord(crosspostPreview?.reddit_video_preview),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const videoItem = toVideoItem(candidate);
    if (videoItem) return videoItem;
  }

  return undefined;
}

function extractRedgifsEmbedItem(postData: Record<string, unknown>): MediaItem | undefined {
  const crosspostParent = Array.isArray(postData.crosspost_parent_list)
    ? asRecord(postData.crosspost_parent_list[0])
    : undefined;
  const candidates = [postData, crosspostParent].filter((candidate): candidate is Record<string, unknown> => Boolean(candidate));

  for (const candidate of candidates) {
    const domain = asString(candidate.domain) ?? '';
    const secureMedia = asRecord(candidate.secure_media);
    const secureMediaEmbed = asRecord(candidate.secure_media_embed);
    const mediaEmbed = asRecord(candidate.media_embed);
    const oembed = asRecord(secureMedia?.oembed);
    const providerType = asString(secureMedia?.type) ?? domain;
    const embedUrl = [
      extractIframeSrc(asString(oembed?.html)),
      extractIframeSrc(asString(secureMediaEmbed?.content)),
      extractIframeSrc(asString(mediaEmbed?.content)),
    ].find((url): url is string => Boolean(url));

    if (!embedUrl || !/(^https?:\/\/)?(?:www\.|v3\.)?redgifs\.com\//i.test(embedUrl)) {
      continue;
    }

    if (!/redgifs/i.test(providerType) && !/redgifs/i.test(domain)) {
      continue;
    }

    const posterUrl =
      asVisualUrl(candidate.thumbnail) ||
      asVisualUrl(oembed?.thumbnail_url);
    const openUrl = asString(candidate.url) || embedUrl;

    return {
      url: posterUrl || openUrl,
      openUrl,
      embedUrl,
      width: asNumber(oembed?.width) ?? asNumber(secureMediaEmbed?.width) ?? asNumber(mediaEmbed?.width),
      height: asNumber(oembed?.height) ?? asNumber(secureMediaEmbed?.height) ?? asNumber(mediaEmbed?.height),
    };
  }

  return undefined;
}

function extractMediaGroup(postData: Record<string, unknown>, postId: string): MediaGroup | undefined {
  const url = postData.url as string || '';
  const domain = postData.domain as string || '';

  const redgifsEmbedItem = extractRedgifsEmbedItem(postData);
  if (redgifsEmbedItem) {
    return {
      id: `ext_vid_${postId}`,
      kind: 'external_video',
      items: [redgifsEmbedItem],
      thumbnailUrl: redgifsEmbedItem.url || postData.thumbnail as string || undefined,
      postId,
    };
  }

  // Reddit video (v.redd.it) — check before image so GIFV isn't misclassified
  const redditVideoItem = extractRedditVideoItem(postData);
  if (redditVideoItem) {
    return {
      id: `vid_${postId}`,
      kind: 'video',
      items: [redditVideoItem],
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
      .map((gi): MediaItem | null => {
        const mediaId = gi.media_id as string;
        const meta = mediaMetadata[mediaId];
        if (!meta) return null;
        const s = meta.s as Record<string, unknown>;
        const sourceUrl = asString(s?.u);
        if (sourceUrl) return { url: sourceUrl, width: s.w as number, height: s.h as number };
        const gifUrl = asString(s?.gif);
        if (gifUrl) return { url: gifUrl, width: s.w as number, height: s.h as number };
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
  if (domain === 'i.redd.it' || IMAGE_URL_PATTERN.test(url)) {
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
  if (IMAGE_URL_PATTERN.test(url)) {
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
