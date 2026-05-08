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
  fallbackVideoUrl?: string;
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
  | 'dwell'
  | 'dwell_score'
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

export type RedditListingSort = 'hot' | 'new' | 'top' | 'rising' | 'controversial';
export type RedditListingTime = 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';

export type FeedRecipeSourceMode = 'random' | 'liked' | 'fresh' | 'comfort' | 'explore';
export type FeedRunStatus = 'active' | 'archived';
export type FeedRunItemSlot = 'preferred' | 'fresh' | 'random' | 'niche' | 'fallback';
export type QueueEventType =
  | 'build'
  | 'refresh_tail'
  | 'lock'
  | 'unlock'
  | 'remove_post'
  | 'suppress_source'
  | 'refill';

export interface FeedScoreDetail {
  key: string;
  label: string;
  value: string;
  contribution: number;
  tone?: 'positive' | 'negative' | 'warning' | 'muted';
}

export interface FeedRecipe {
  id: string;
  name: string;
  description?: string;
  sourceMode: FeedRecipeSourceMode;
  nsfwMode: 'yes' | 'no' | 'only';
  listingSort: RedditListingSort;
  listingTime: RedditListingTime;
  sourceCount: number;
  targetQueueSize: number;
  committedAheadCount: number;
  maxPerSubredditWindow: number;
  qualityWeight: number;
  diversityWeight: number;
  noveltyWeight: number;
  createdAt: number;
  updatedAt: number;
}

export interface FeedRun {
  id: string;
  recipeId: string;
  feedName: string;
  status: FeedRunStatus;
  currentIndex: number;
  locked: boolean;
  committedUntil: number;
  seed: string;
  createdAt: number;
  updatedAt: number;
}

export interface FeedRunItem {
  id: string;
  runId: string;
  position: number;
  postId: string;
  subreddit: string;
  slot: FeedRunItemSlot;
  score: number;
  scoreDetails: FeedScoreDetail[];
  sourceKey?: string;
  sourceLabel?: string;
  committed: boolean;
  addedAt: number;
  dismissedAt?: number;
}

export interface PostSource {
  id: string;
  postId: string;
  sourceKey: string;
  sourceLabel: string;
  subreddit: string;
  routePath: string;
  listingSort?: RedditListingSort;
  listingTime?: RedditListingTime;
  listingPosition?: number;
  fetchedAt: number;
  isMultireddit: boolean;
  recipeId?: string;
  runId?: string;
  batchId?: string;
}

export interface SourceStats {
  sourceKey: string;
  sourceLabel: string;
  subreddit: string;
  listingSort?: RedditListingSort;
  listingTime?: RedditListingTime;
  afterCursor?: string | null;
  lastFetchedAt?: number;
  lastError?: string;
  cooldownUntil?: number;
  fetchCount: number;
  postsReturned: number;
  mediaPostsReturned: number;
  newPostsReturned: number;
  duplicatePostsReturned: number;
  updatedAt: number;
}

export interface QueueEvent {
  id: string;
  runId: string;
  type: QueueEventType;
  postId?: string;
  sourceKey?: string;
  value?: number | string;
  ts: number;
}

export interface SubredditRouletteSettings {
  subredditCount: number;
  imagesPerRound: number;
  likedWeight: number;
  newWeight: number;
  randomWeight: number;
  nsfwMode: 'yes' | 'no' | 'only';
  listingSort: RedditListingSort;
  listingTime: RedditListingTime;
}
