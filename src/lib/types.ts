export type SubredditDiscoveryStatus = 'discovered' | 'verified' | 'failed' | 'muted';
export type SubredditAvailabilityStatus =
  | 'available'
  | 'banned'
  | 'private'
  | 'quarantined'
  | 'not_found'
  | 'unknown';

export interface SubredditRecord {
  name: string;
  prefixedName: string;
  displayName?: string;
  title?: string;
  description?: string;
  publicDescription?: string;
  subscribers?: number;
  isNsfw?: boolean;
  firstSeenAt: number;
  lastFetchedAt?: number;
  localRating: number;
  isMuted: boolean;
  discoveryStatus?: SubredditDiscoveryStatus;
  discoveredVia?: string;
  discoveryReason?: string;
  profileFetchedAt?: number;
  profileFetchFailedAt?: number;
  profileFetchError?: string;
  availabilityStatus?: SubredditAvailabilityStatus;
  availabilityCheckedAt?: number;
  availabilityReason?: string;
  availabilityDetail?: string;
  unavailableSince?: number;
  adjacencyScannedAt?: number;
}

export interface AdjacencyLink {
  fromSubreddit: string;
  toSubreddit: string;
  source: 'description' | 'sidebar' | 'crosspost' | 'mention' | 'widget';
  evidence?: string;
  discoveredAt: number;
  lastSeenAt?: number;
  count?: number;
  weight?: number;
}

export type MediaKind = 'image' | 'video' | 'gallery' | 'external_image' | 'external_video' | 'unknown';

export interface MediaItem {
  url: string;
  width?: number;
  height?: number;
  mimeType?: string;
  dashUrl?: string;
  hlsUrl?: string;
  openUrl?: string;
  embedUrl?: string;
  provider?: 'redgifs' | string;
  externalId?: string;
  durationSeconds?: number;
  hasAudio?: boolean;
}

export interface MediaGroup {
  id: string;
  kind: MediaKind;
  items: MediaItem[];
  thumbnailUrl?: string;
  postId: string;
  failed?: boolean;
}

export interface PostRecord {
  id: string;
  fullname: string;
  subreddit: string;
  title: string;
  author: string;
  permalink: string;
  url: string;
  domain: string;
  flair?: string;
  isNsfw: boolean;
  isSelf: boolean;
  selftext?: string;
  score: number;
  numComments: number;
  createdAt: number;
  media?: MediaGroup;
  crosspostParentId?: string;
  crosspostParentSubreddit?: string;
  rawSnapshot?: unknown;
  seenAt?: number;
  localRating?: 1 | -1;
  fetchedInRoute?: string;
}

export interface SignalEvent {
  id: string;
  type: SignalEventType;
  postId?: string;
  mediaId?: string;
  subreddit?: string;
  value?: number | string;
  ts: number;
}

export type SignalEventType =
  | 'impression'
  | 'view_start'
  | 'view_end'
  | 'advance_next'
  | 'advance_gallery'
  | 'open_reddit'
  | 'open_media'
  | 'rating_explicit'
  | 'video_play'
  | 'video_pause'
  | 'video_progress'
  | 'seen_post'
  | 'seen_media';

export interface FetchSpec {
  path: string;
  subreddits: string[];
  sort?: string;
  time?: string;
  after?: string;
  query?: string;
}

export interface CacheEntry {
  specKey: string;
  fetchedAt: number;
  after?: string;
  postIds: string[];
}

export interface FeedSnapshot {
  routeKey: string;
  path: string;
  subreddits: string[];
  time?: string;
  afterCursor?: string | null;
  postIds: string[];
  currentIndex: number;
  galleryIndex: number;
  scrollTop?: number;
  updatedAt: number;
}

export interface SubredditRouletteSettings {
  subredditCount: number;
  imagesPerRound: number;
  likedWeight: number;
  newWeight: number;
  randomWeight: number;
  nsfwMode: 'yes' | 'no' | 'only';
}
