import type { AdjacencyLink } from '$lib/types';

const SUBREDDIT_MENTION_RE = /\/?r\/([A-Za-z0-9_]{2,21})/g;

export function extractMentions(
  text: string,
  fromSubreddit: string,
  source: AdjacencyLink['source']
): AdjacencyLink[] {
  const links: AdjacencyLink[] = [];
  const seen = new Set<string>();
  const now = Date.now();

  let match;
  SUBREDDIT_MENTION_RE.lastIndex = 0;
  while ((match = SUBREDDIT_MENTION_RE.exec(text)) !== null) {
    const toSub = match[1].toLowerCase();
    if (toSub === fromSubreddit.toLowerCase()) continue;
    if (seen.has(toSub)) continue;
    seen.add(toSub);

    const start = Math.max(0, match.index - 20);
    const end = Math.min(text.length, match.index + 40);
    const evidence = text.slice(start, end).replace(/\n/g, ' ');

    links.push({
      fromSubreddit: fromSubreddit.toLowerCase(),
      toSubreddit: toSub,
      source,
      evidence,
      discoveredAt: now,
    });
  }

  return links;
}

export function extractLinksFromPost(
  postTitle: string,
  postSelftext: string,
  fromSubreddit: string,
  crosspostParentSubreddit?: string
): AdjacencyLink[] {
  const links: AdjacencyLink[] = [];
  links.push(...extractMentions(postTitle, fromSubreddit, 'mention'));
  if (postSelftext) {
    links.push(...extractMentions(postSelftext, fromSubreddit, 'mention'));
  }
  if (crosspostParentSubreddit && crosspostParentSubreddit.toLowerCase() !== fromSubreddit.toLowerCase()) {
    links.push({
      fromSubreddit: fromSubreddit.toLowerCase(),
      toSubreddit: crosspostParentSubreddit.toLowerCase(),
      source: 'crosspost',
      discoveredAt: Date.now(),
    });
  }
  return links;
}

export function extractLinksFromDescription(description: string, fromSubreddit: string): AdjacencyLink[] {
  return extractMentions(description, fromSubreddit, 'description');
}
