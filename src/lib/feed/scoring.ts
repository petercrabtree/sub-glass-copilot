import type {
  FeedRecipe,
  FeedRunItemSlot,
  FeedScoreDetail,
  PostRecord,
  PostSource,
  SignalEvent,
  SourceStats,
  SubredditRecord,
} from '$lib/types';
import {
  feedSourceUsesCursor,
  getFeedSourceKey,
  getFeedSourceLabel,
  getFeedSourceRoutePath,
  getSourceYieldScore,
} from '$lib/feed/source';

export interface FeedCandidate {
  post: PostRecord;
  score: number;
  slot: FeedRunItemSlot;
  source?: PostSource;
  scoreDetails: FeedScoreDetail[];
}

export interface FeedScoringContext {
  recipe: FeedRecipe;
  posts: PostRecord[];
  subreddits: SubredditRecord[];
  events: SignalEvent[];
  postSources: PostSource[];
  sourceStats: SourceStats[];
  seenPostIds: Set<string>;
  now?: number;
}

function formatSigned(value: number, digits = 1): string {
  const rounded = Number(value.toFixed(digits));
  return `${rounded > 0 ? '+' : ''}${rounded}`;
}

function addDetail(
  details: FeedScoreDetail[],
  key: string,
  label: string,
  value: string,
  contribution: number,
  tone?: FeedScoreDetail['tone']
): number {
  if (contribution === 0) return 0;
  details.push({ key, label, value, contribution, tone });
  return contribution;
}

function groupEventsByPost(events: SignalEvent[]): Map<string, SignalEvent[]> {
  const grouped = new Map<string, SignalEvent[]>();
  for (const event of events) {
    if (!event.postId) continue;
    grouped.set(event.postId, [...(grouped.get(event.postId) ?? []), event]);
  }
  return grouped;
}

function groupSourcesByPost(sources: PostSource[]): Map<string, PostSource[]> {
  const grouped = new Map<string, PostSource[]>();
  for (const source of sources) {
    grouped.set(source.postId, [...(grouped.get(source.postId) ?? []), source]);
  }
  return grouped;
}

function chooseBestSource(sources: PostSource[] | undefined): PostSource | undefined {
  if (!sources || sources.length === 0) return undefined;
  return [...sources].sort((a, b) =>
    (a.listingPosition ?? Number.MAX_SAFE_INTEGER) - (b.listingPosition ?? Number.MAX_SAFE_INTEGER) ||
    b.fetchedAt - a.fetchedAt
  )[0];
}

function sourceMatchesRecipe(source: PostSource, recipe: FeedRecipe): boolean {
  return source.sourceKey === getFeedSourceKey({
    subreddit: source.subreddit,
    listingSort: recipe.listingSort,
    listingTime: recipe.listingTime,
  });
}

function createLocalPostSourceFallback(post: PostRecord, recipe: FeedRecipe): PostSource {
  const sourceSpec = {
    subreddit: post.subreddit,
    listingSort: recipe.listingSort,
    listingTime: recipe.listingTime,
  };
  const sourceKey = getFeedSourceKey(sourceSpec);
  return {
    id: `${post.id}:${sourceKey}:local`,
    postId: post.id,
    sourceKey,
    sourceLabel: getFeedSourceLabel(sourceSpec),
    subreddit: post.subreddit,
    routePath: post.fetchedInRoute ?? getFeedSourceRoutePath(sourceSpec),
    listingSort: recipe.listingSort,
    listingTime: recipe.listingTime,
    fetchedAt: post.createdAt,
    isMultireddit: false,
  };
}

function getCandidateSource(
  post: PostRecord,
  recipe: FeedRecipe,
  sourcesByPost: Map<string, PostSource[]>
): PostSource | undefined {
  const sources = sourcesByPost.get(post.id);
  const matchingSources = sources?.filter((source) => sourceMatchesRecipe(source, recipe));
  const matchingSource = chooseBestSource(matchingSources);
  if (matchingSource) return matchingSource;

  return !sources || sources.length === 0
    ? createLocalPostSourceFallback(post, recipe)
    : undefined;
}

function isRecipeNsfwMatch(post: PostRecord, recipe: FeedRecipe): boolean {
  if (recipe.nsfwMode === 'yes') return true;
  if (recipe.nsfwMode === 'no') return !post.isNsfw;
  return post.isNsfw;
}

function getSourceRankScore(source: PostSource | undefined): number {
  if (!source || source.listingPosition === undefined) return 0;
  return Math.max(0, 6 - Math.log2(source.listingPosition + 2) * 1.4);
}

function sumNumericEvents(events: SignalEvent[], type: SignalEvent['type']): number {
  return events.reduce((sum, event) => (
    event.type === type && typeof event.value === 'number'
      ? sum + event.value
      : sum
  ), 0);
}

function countEvents(events: SignalEvent[], type: SignalEvent['type']): number {
  return events.filter((event) => event.type === type).length;
}

function getFreshnessScore(post: PostRecord, now: number): number {
  const ageDays = Math.max(0, (now - post.createdAt) / 86_400_000);
  if (ageDays <= 1) return 4;
  if (ageDays <= 7) return 3;
  if (ageDays <= 31) return 1.5;
  return -Math.min(4, Math.log2(ageDays / 31 + 1));
}

function getSlot(post: PostRecord, sub: SubredditRecord | undefined, source: PostSource | undefined): FeedRunItemSlot {
  const rating = sub?.localRating ?? 0;
  if (rating > 1) return 'preferred';
  if (!source || source.fetchedAt > Date.now() - 12 * 60 * 60 * 1000) return 'fresh';
  if (rating === 0) return 'niche';
  return 'random';
}

export function scoreFeedCandidates(context: FeedScoringContext): FeedCandidate[] {
  const now = context.now ?? Date.now();
  const subredditByName = new Map(context.subreddits.map((sub) => [sub.name, sub]));
  const eventsByPost = groupEventsByPost(context.events);
  const sourcesByPost = groupSourcesByPost(context.postSources);
  const statsBySource = new Map(context.sourceStats.map((stats) => [stats.sourceKey, stats]));

  return context.posts
    .filter((post) => post.media && !post.isSelf && isRecipeNsfwMatch(post, context.recipe))
    .map((post): FeedCandidate | null => {
      const details: FeedScoreDetail[] = [];
      const sub = subredditByName.get(post.subreddit);
      const source = getCandidateSource(post, context.recipe, sourcesByPost);
      const postEvents = eventsByPost.get(post.id) ?? [];
      let score = 0;

      if (!source) return null;

      if (context.seenPostIds.has(post.id)) {
        score += addDetail(details, 'seen', 'seen', 'already viewed', -80, 'negative');
      }

      if (post.localRating === 1) {
        score += addDetail(details, 'post-rating', 'post rating', 'liked', 16, 'positive');
      } else if (post.localRating === -1) {
        score += addDetail(details, 'post-rating', 'post rating', 'downrated', -28, 'negative');
      }

      const subredditRating = sub?.localRating ?? 0;
      if (subredditRating !== 0) {
        const contribution = Math.max(-20, Math.min(24, subredditRating * 4.5 * context.recipe.qualityWeight));
        score += addDetail(
          details,
          'subreddit-rating',
          'subreddit',
          `r/${post.subreddit} ${formatSigned(subredditRating, 2)}`,
          contribution,
          contribution > 0 ? 'positive' : 'negative'
        );
      }

      const sourceRankScore = getSourceRankScore(source) * context.recipe.qualityWeight;
      score += addDetail(
        details,
        'source-rank',
        'source rank',
        source?.listingPosition !== undefined ? `#${source.listingPosition + 1} in ${source.sourceLabel}` : 'unknown',
        sourceRankScore,
        sourceRankScore > 0 ? 'positive' : 'muted'
      );

      const duplicatePenaltyWeight = feedSourceUsesCursor(context.recipe) ? 0.7 : 0.2;
      const sourceYieldScore = (
        getSourceYieldScore(statsBySource.get(source.sourceKey), duplicatePenaltyWeight) - 0.6
      ) * 5;
      score += addDetail(
        details,
        'source-yield',
        'source yield',
        source?.sourceLabel ?? 'unknown source',
        sourceYieldScore,
        sourceYieldScore >= 0 ? 'positive' : 'warning'
      );

      const dwellMs = sumNumericEvents(postEvents, 'dwell');
      if (dwellMs > 0) {
        const dwellContribution = Math.min(12, Math.log2(dwellMs / 1000 + 1) * 2.2);
        score += addDetail(
          details,
          'dwell',
          'dwell',
          `${Math.round(dwellMs / 1000)}s`,
          dwellContribution,
          'positive'
        );
      }

      const dwellScore = sumNumericEvents(postEvents, 'dwell_score');
      if (dwellScore !== 0) {
        const contribution = Math.max(-8, Math.min(14, dwellScore * 14));
        score += addDetail(
          details,
          'passive-score',
          'passive score',
          formatSigned(dwellScore, 2),
          contribution,
          contribution > 0 ? 'positive' : 'negative'
        );
      }

      const openCount = countEvents(postEvents, 'open_reddit') + countEvents(postEvents, 'open_media');
      if (openCount > 0) {
        score += addDetail(details, 'opens', 'opens', String(openCount), Math.min(8, openCount * 3), 'positive');
      }

      const freshnessScore = getFreshnessScore(post, now) * context.recipe.noveltyWeight;
      score += addDetail(
        details,
        'freshness',
        'freshness',
        new Date(post.createdAt).toLocaleDateString(),
        freshnessScore,
        freshnessScore >= 0 ? 'positive' : 'muted'
      );

      if (post.media?.kind === 'external_video') {
        score += addDetail(details, 'media-kind', 'media', 'external video', -4, 'warning');
      } else if (post.media?.kind === 'video') {
        score += addDetail(details, 'media-kind', 'media', 'native video', 1.5, 'positive');
      } else if (post.media?.kind === 'gallery') {
        score += addDetail(details, 'media-kind', 'media', 'gallery', 1, 'positive');
      }

      if (context.recipe.sourceMode === 'fresh') {
        score += Math.max(-4, Math.min(8, freshnessScore));
      } else if (context.recipe.sourceMode === 'comfort') {
        score += Math.max(-8, Math.min(10, subredditRating * 2));
      } else if (context.recipe.sourceMode === 'explore' && Math.abs(subredditRating) < 0.5) {
        score += addDetail(details, 'explore', 'recipe', 'unsettled source', 5 * context.recipe.noveltyWeight, 'positive');
      }

      if (score < -70) return null;

      return {
        post,
        score,
        slot: getSlot(post, sub, source),
        source,
        scoreDetails: details.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 8),
      };
    })
    .filter((candidate): candidate is FeedCandidate => candidate !== null)
    .sort((a, b) => b.score - a.score || b.post.createdAt - a.post.createdAt);
}
