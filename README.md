# SubGlass

A client-only, media-first Reddit viewer and subreddit discovery tool.

## How to Run

```bash
# Install dependencies
bun install

# Start development server
bun run dev

# Build for production
bun run build

# Preview production build
bun run preview
```

Open http://localhost:5173 in your browser.

## What the MVP Includes

- **Fullscreen media feed** — browse Reddit images, videos, and galleries in a distraction-free viewer
- **Keyboard navigation** — Arrow keys / HJKL / Space to advance; gallery-aware (within-gallery then advance)
- **Supported routes** — `/r/<subreddit>`, `/r/all`, `/r/<sub1+sub2>`, `/`
- **Media types** — Reddit-hosted images (`i.redd.it`), Reddit videos (`v.redd.it`), Reddit galleries, best-effort external images
- **Seen state** — persisted forever; small "seen" badge on revisited posts
- **Local ratings** — thumbs up/down per post (SubGlass-only, never sent to Reddit)
- **Implicit event log** — impression, view start/end, advance, gallery advance, open Reddit, open media, video play/pause
- **Subreddit records** — first-class entities; seeded from every post encountered
- **Subreddit adjacency** — extracted from `/r/X` mentions in post titles; stored with provenance
- **Discovery mode** — `/discover` shows subreddit suggestions based on local ratings + adjacency links
- **Admin/debug page** — `/admin` shows counts, lets you inspect subreddits/posts/events/adjacency, and export/import all local state as JSON

## Architecture

```
src/lib/
  types.ts              — Core data model (Subreddit, Post, MediaGroup, SignalEvent, etc.)
  transport/
    reddit.ts           — Fetch Reddit listing/about JSON endpoints
  normalize/
    posts.ts            — Convert raw Reddit API responses to PostRecord + MediaGroup
  adjacency/
    extract.ts          — Extract /r/X mentions and crosspost links from text
  db/
    store.ts            — IndexedDB persistence (via idb) for all entities
  components/
    MediaViewer.svelte  — Renders image / video / gallery items
    PostOverlay.svelte  — HUD overlay with controls, ratings, navigation

src/routes/
  +layout.svelte        — App shell (topbar, styles)
  +layout.ts            — SPA mode (ssr=false, prerender=false)
  +page.svelte          — Root redirect to /r/all
  r/[...subreddit]/
    +page.svelte        — Main viewer: fetch, normalize, fullscreen feed
  discover/
    +page.svelte        — Discovery mode: subreddit suggestions
  admin/
    +page.svelte        — Admin/debug: stats, inspect, export, import
```

### Data Model

| Entity | Key Fields | Notes |
|--------|-----------|-------|
| `SubredditRecord` | `name`, `localRating`, `isMuted` | Core learned object |
| `PostRecord` | `id`, `subreddit`, `media`, `seenAt`, `localRating` | Durable; never re-fetched by id |
| `MediaGroup` | `id`, `kind`, `items[]` | Normalized media for each post |
| `AdjacencyLink` | `fromSubreddit`, `toSubreddit`, `source`, `evidence` | Subreddit graph edges |
| `SignalEvent` | `type`, `postId`, `ts` | Append-only event log |

## Known Limitations

- **CORS**: Reddit's API allows cross-origin requests for `.json` endpoints on public subreddits. Some requests may be rate-limited or blocked.
- **Videos**: Reddit-hosted videos use DASH streaming. The fallback MP4 URL is used directly, which may lack audio on some posts.
- **External media**: Only direct image URLs and obvious imgur links are supported.
- No comments view, no Reddit auth, no write actions.
- IndexedDB data stays on the device; no sync.

## Next Steps

1. More media hosts (YouTube, Redgifs, etc.)
2. DASH video player for proper audio support
3. Sidebar scan for richer adjacency extraction
4. Smarter discovery weighted by dwell time
5. Sort options (Hot/Top/New/Rising) in the UI
6. Prefetch next N images ahead of current position
