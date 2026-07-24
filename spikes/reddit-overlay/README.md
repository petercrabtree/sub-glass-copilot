# Reddit Overlay Spike

This disposable userscript tests the critical path for running SubGlass on Reddit's own origin without changing the existing application.

## What it tests

- A full-screen SubGlass surface can mount inside an isolated Shadow DOM.
- The current subreddit, sort, and time range can be derived from Reddit's URL.
- A listing can be fetched from the current Reddit origin with the active browser credentials.
- Images, Reddit-hosted video fallbacks, and Reddit galleries can render.
- Keyboard and button navigation can be owned while the overlay is open.
- The overlay can close without reloading or replacing the native Reddit page.
- Reddit client-side navigation can refresh the overlay listing.

The request status, response type, duration, supported-media count, and available rate-limit headers remain visible in the bottom diagnostic rail. A failure here is a useful spike result rather than something the script tries to disguise.

## Try it on Reddit

1. Install a userscript manager such as Tampermonkey, Violentmonkey, or Greasemonkey.
2. Create a new userscript.
3. Replace its contents with [`subglass-reddit-overlay.user.js`](./subglass-reddit-overlay.user.js) and save it.
4. Open a Reddit subreddit listing, for example `https://www.reddit.com/r/pics/top/?t=month`.
5. Click the small **SG** button in the lower-right corner, or press **Alt+Shift+G**.

While the overlay is open:

- **Left/Right**, **H/L**, or **Space** move through media and then posts.
- **J/K** move directly between posts.
- **[ / ]** move within a gallery.
- **Escape** closes the overlay and restores the Reddit page.

Try both `www.reddit.com` and `old.reddit.com`. The spike deliberately requests the listing from whichever origin hosts the page so the result reveals whether the active Reddit session materially improves access.

## Automated smoke

Run:

```bash
bun run smoke:overlay-spike
```

The smoke test provides a fake Reddit host and verifies Shadow DOM mounting, same-origin fetches, image/video/gallery rendering, navigation, client-side route changes, and clean teardown. It writes a screenshot to `build/overlay-spike-smoke.png`.

## Intentional omissions

This is not v2 and should not become its foundation by accumulation. It intentionally omits:

- IndexedDB and migration of existing SubGlass data
- feed recipes, roulette, discovery, ratings, and dwell tracking
- pagination, caching, preloading, and Redgifs enrichment
- production extension packaging or privileged background requests
- mobile layout polish and broad Reddit route support

If same-origin userscript fetching fails but the overlay itself is stable, the next narrow experiment is a Manifest V3 extension background request. If mounting, media playback, keyboard ownership, or clean teardown are unstable, stop before beginning the rebuild.
