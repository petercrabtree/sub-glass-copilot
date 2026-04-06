# Repo Notes

- On each meaningful repo change, briefly consider whether `AGENTS.md` should also be updated. Only edit it when the change adds durable, high-signal guidance that will help future agents.
- Do not add local, Vite, same-origin, or server-side proxy workarounds for Reddit/API access unless the user explicitly asks for a proxy-based solution.
- This is a personal project, so diagnostics and error reporting can be developer-facing and optimized for debugging rather than end-user polish.
- This app is a client-only SvelteKit SPA. `src/routes/+layout.ts` sets `ssr = false` and `prerender = false`, and `svelte.config.js` uses `@sveltejs/adapter-static` with a `200.html` fallback. Prefer browser-side solutions; do not introduce server-only assumptions unless explicitly requested.
- The codebase uses Svelte 5 runes throughout app code. Match existing patterns like `$state`, `$derived`, `$effect`, and event attributes such as `onclick`/`onsubmit` instead of older Svelte patterns.
- Core viewer behavior is route-local in `src/routes/r/[...subreddit]/+page.svelte`. Discovery and admin behavior are also mostly implemented directly in route components, so check those files first before adding new abstractions.
- Persistent app state lives in IndexedDB via `src/lib/db/store.ts`. The main stores are `subreddits`, `posts`, `media`, `events`, `adjacency`, and `cache`; admin import/export operates on that full local dataset and import is intentionally destructive.
- Reddit access is implemented as direct browser fetches to `https://old.reddit.com/.../.json` in `src/lib/transport/reddit.ts`, with rich developer-facing error objects and local debug state. Preserve detailed diagnostics when changing fetch behavior.
- Dev diagnostics matter in this repo: `src/lib/dev/error-reporter.ts` forwards browser `console.error`, `window.error`, and `unhandledrejection` events to the Vite dev server endpoint defined in `vite.config.ts`. Avoid removing or bypassing that workflow casually.
- Adjacency/discovery behavior depends on extracting `r/...` mentions and crosspost relationships into local graph edges in `src/lib/adjacency/extract.ts`; if discovery seems off, inspect extraction and local data before changing ranking.
- Use Bun for the default workflow (`bun install`, `bun run dev`, `bun run check`, `bun run build`). `bun run check` is the main validation command, and there is currently no dedicated automated test suite.
