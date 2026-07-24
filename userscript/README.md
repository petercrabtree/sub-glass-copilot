# SubGlass Reddit Overlay v1

SubGlass v1 is a userscript that runs a focused media viewer directly on Reddit's origin. It leaves Reddit mounted underneath an isolated Shadow DOM and requests listings with the browser's active Reddit credentials.

## Multi-subreddit feeds

The overlay understands Reddit's multireddit-style `+` syntax:

```text
pics+earthporn+itookapicture
```

You can either:

- visit a listing such as `https://www.reddit.com/r/pics+earthporn/top/?t=month`, then open SubGlass; or
- enter `pics+earthporn` in the feed field inside the overlay, choose a sort and time range, and press **Load**.

The editor also accepts `r/pics+earthporn`, comma- or space-separated names, and a full Reddit `/r/...` URL. Names are validated, case-insensitive duplicates are removed, and the configured feed is restored when the same Reddit page reloads. Each post keeps an explicit source-subreddit link.

## Install and use

1. Install a userscript manager such as Tampermonkey, Violentmonkey, or Greasemonkey.
2. Create a new userscript.
3. Replace its contents with [`subglass-reddit-overlay.user.js`](./subglass-reddit-overlay.user.js) and save it.
4. Open Reddit.
5. Click the small **SG** button in the lower-right corner, or press **Alt+Shift+G**.

While the overlay is open:

- **Left/Right**, **H/L**, or **Space** move through media and then posts.
- **J/K** move directly between posts.
- **[ / ]** move within a gallery.
- **Escape** closes the overlay and restores the Reddit page.

The bottom rail reports request status, response type, duration, supported-media count, requested source count, and available Reddit rate-limit headers. Failures remain visible for debugging.

## Automated smoke

Run:

```bash
bun run smoke:overlay
```

The smoke test verifies:

- explicit `subreddit1+subreddit2` URL parsing and same-origin JSON paths;
- feed editing, normalization, validation, and reload persistence;
- source-subreddit labeling;
- image, Reddit video, and gallery rendering;
- keyboard navigation and Reddit client-side route changes;
- visible HTTP failures and clean overlay teardown.

It writes a screenshot to `build/overlay-v1-smoke.png`.

## v1 boundaries

This version intentionally keeps the first useful slice small:

- one Reddit listing request of up to 50 posts;
- no pagination, cache, preloading, or Redgifs enrichment;
- no migration of the SPA's IndexedDB data, ratings, discovery, or roulette;
- no packaged browser extension or privileged background requests;
- no attempt to replace Reddit's own authentication.

Those layers should move over only after this userscript is useful in normal browsing.
