// ==UserScript==
// @name         SubGlass Reddit Overlay
// @namespace    https://github.com/subglass
// @version      1.0.1
// @description  A same-origin media viewer for Reddit and multi-subreddit listings.
// @homepageURL  https://github.com/petercrabtree/sub-glass-copilot
// @supportURL   https://github.com/petercrabtree/sub-glass-copilot/issues
// @updateURL    https://raw.githubusercontent.com/petercrabtree/sub-glass-copilot/main/userscript/subglass-reddit-overlay.user.js
// @downloadURL  https://raw.githubusercontent.com/petercrabtree/sub-glass-copilot/main/userscript/subglass-reddit-overlay.user.js
// @match        https://www.reddit.com/*
// @match        https://old.reddit.com/*
// @match        https://new.reddit.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const HOST_ID = 'subglass-reddit-overlay-host';
  const SCRIPT_VERSION = '1.0.1';
  const STORAGE_KEY = 'subglass:reddit-overlay-v1-feed';
  const ROUTE_POLL_MS = 750;
  const LISTING_LIMIT = 50;
  const MAX_SUBREDDITS = 50;
  const LISTING_SORTS = new Set(['hot', 'new', 'top', 'rising', 'controversial']);
  const LISTING_TIMES = new Set(['hour', 'day', 'week', 'month', 'year', 'all']);
  const SUBREDDIT_NAME = /^[A-Za-z0-9_]{1,21}$/;
  const IMAGE_EXTENSION = /\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])/i;
  const VIDEO_EXTENSION = /\.(?:m3u8|mp4|webm)(?:$|[?#])/i;
  const NON_MEDIA_URL_VALUES = new Set(['default', 'image', 'nsfw', 'self', 'spoiler']);

  if (document.getElementById(HOST_ID)) return;

  const state = {
    open: false,
    phase: 'idle',
    context: null,
    posts: [],
    currentPostIndex: 0,
    currentMediaIndex: 0,
    lastRequest: null,
    error: null,
    requestController: null,
    routeHref: window.location.href,
    lockedPageStyle: null,
    formError: null,
  };

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.dataset.open = 'false';
  host.dataset.phase = state.phase;
  host.dataset.version = SCRIPT_VERSION;

  const shadow = host.attachShadow({ mode: 'open' });
  installStyles(shadow);
  shadow.append(createShell());
  document.documentElement.append(host);

  const elements = {
    launcher: shadow.querySelector('[data-role="launcher"]'),
    overlay: shadow.querySelector('[data-role="overlay"]'),
    feedForm: shadow.querySelector('[data-role="feed-form"]'),
    bundleInput: shadow.querySelector('[data-role="bundle-input"]'),
    sortSelect: shadow.querySelector('[data-role="sort-select"]'),
    timeSelect: shadow.querySelector('[data-role="time-select"]'),
    route: shadow.querySelector('[data-role="route"]'),
    status: shadow.querySelector('[data-role="status"]'),
    feedLink: shadow.querySelector('[data-role="feed-link"]'),
    stage: shadow.querySelector('[data-role="stage"]'),
    empty: shadow.querySelector('[data-role="empty"]'),
    title: shadow.querySelector('[data-role="title"]'),
    meta: shadow.querySelector('[data-role="meta"]'),
    postCounter: shadow.querySelector('[data-role="post-counter"]'),
    mediaCounter: shadow.querySelector('[data-role="media-counter"]'),
    diagnostics: shadow.querySelector('[data-role="diagnostics"]'),
    nativeLink: shadow.querySelector('[data-role="native-link"]'),
    sourceLink: shadow.querySelector('[data-role="source-link"]'),
    subredditLink: shadow.querySelector('[data-role="subreddit-link"]'),
    previousPost: shadow.querySelector('[data-action="previous-post"]'),
    nextPost: shadow.querySelector('[data-action="next-post"]'),
    previousMedia: shadow.querySelector('[data-action="previous-media"]'),
    nextMedia: shadow.querySelector('[data-action="next-media"]'),
  };

  bindActions();
  state.context = resolveInitialContext(window.location);
  syncFeedForm();
  render();

  window.addEventListener('keydown', handleKeydown, true);
  window.addEventListener('beforeunload', restorePageScroll);
  window.setInterval(checkForRouteChange, ROUTE_POLL_MS);

  function installStyles(root) {
    const css = `
      :host {
        all: initial;
        color-scheme: dark;
        font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        pointer-events: none;
      }

      *, *::before, *::after {
        box-sizing: border-box;
      }

      button, a, input, select {
        font: inherit;
      }

      button {
        color: inherit;
      }

      .launcher {
        appearance: none;
        position: fixed;
        right: 14px;
        bottom: 14px;
        z-index: 2;
        width: 44px;
        height: 44px;
        border: 1px solid rgba(255, 255, 255, 0.22);
        border-radius: 999px;
        background: rgba(12, 12, 14, 0.9);
        color: #f6f6f6;
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.38);
        cursor: pointer;
        pointer-events: auto;
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.08em;
        backdrop-filter: blur(16px);
      }

      .launcher::after {
        content: "";
        position: absolute;
        top: 2px;
        right: 2px;
        width: 9px;
        height: 9px;
        border: 2px solid #111;
        border-radius: 999px;
        background: #999;
      }

      :host([data-phase="loading"]) .launcher::after {
        background: #f4bd50;
      }

      :host([data-phase="ready"]) .launcher::after {
        background: #52d38b;
      }

      :host([data-phase="error"]) .launcher::after {
        background: #ff5e6c;
      }

      :host([data-open="true"]) .launcher {
        display: none;
      }

      .overlay {
        display: none;
        position: fixed;
        inset: 0;
        overflow: hidden;
        pointer-events: auto;
        background:
          radial-gradient(circle at 50% 45%, rgba(41, 42, 48, 0.6), transparent 48%),
          #08090b;
        color: #f4f4f5;
      }

      :host([data-open="true"]) .overlay {
        display: grid;
        grid-template-rows: auto 1fr auto;
      }

      .topbar {
        min-width: 0;
        min-height: 54px;
        display: grid;
        grid-template-columns: auto minmax(340px, 1fr) auto;
        align-items: center;
        gap: 14px;
        padding: 8px 10px 8px 14px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(10, 11, 13, 0.92);
        backdrop-filter: blur(18px);
      }

      .brand-row {
        min-width: max-content;
        display: flex;
        align-items: center;
        gap: 9px;
      }

      .brand {
        flex: none;
        font-size: 11px;
        font-weight: 850;
        letter-spacing: 0.15em;
        text-transform: uppercase;
      }

      .version {
        flex: none;
        padding: 3px 6px;
        border: 1px solid rgba(82, 211, 139, 0.42);
        border-radius: 5px;
        color: #52d38b;
        font-size: 9px;
        font-weight: 750;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }

      .route {
        min-width: 0;
        overflow: hidden;
        color: #85878d;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 9px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .feed-editor {
        min-width: 0;
        display: grid;
        gap: 3px;
      }

      .feed-form {
        min-width: 0;
        display: grid;
        grid-template-columns: minmax(150px, 1fr) auto auto auto;
        align-items: center;
        gap: 6px;
      }

      .bundle-control {
        min-width: 0;
        min-height: 32px;
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        align-items: center;
        overflow: hidden;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 7px;
        background: rgba(255, 255, 255, 0.055);
      }

      .bundle-prefix {
        align-self: stretch;
        display: grid;
        place-items: center;
        padding: 0 0 0 9px;
        color: #8f9197;
        font: 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }

      .bundle-input {
        min-width: 0;
        width: 100%;
        height: 30px;
        padding: 5px 9px 5px 2px;
        border: 0;
        outline: 0;
        background: transparent;
        color: #f1f1f2;
        font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }

      .bundle-input::placeholder {
        color: #696b71;
      }

      .bundle-control:focus-within {
        border-color: rgba(244, 189, 80, 0.7);
        box-shadow: 0 0 0 1px rgba(244, 189, 80, 0.22);
      }

      .bundle-control:has(.bundle-input[aria-invalid="true"]) {
        border-color: rgba(255, 94, 108, 0.78);
      }

      .feed-select {
        height: 32px;
        padding: 5px 24px 5px 8px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 7px;
        background: #17181b;
        color: #e5e5e7;
        cursor: pointer;
        font-size: 11px;
      }

      .feed-select:disabled {
        cursor: default;
        opacity: 0.38;
      }

      .top-actions {
        display: flex;
        align-items: center;
        gap: 7px;
      }

      .status {
        max-width: min(40vw, 440px);
        overflow: hidden;
        color: #a7a8ad;
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .button,
      .link-button {
        appearance: none;
        min-height: 32px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 6px 10px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 7px;
        background: rgba(255, 255, 255, 0.07);
        color: #eeeeef;
        cursor: pointer;
        font-size: 11px;
        font-weight: 700;
        text-decoration: none;
      }

      .button:hover,
      .link-button:hover {
        border-color: rgba(255, 255, 255, 0.34);
        background: rgba(255, 255, 255, 0.12);
      }

      .button:focus-visible,
      .link-button:focus-visible,
      .launcher:focus-visible {
        outline: 2px solid #f4bd50;
        outline-offset: 2px;
      }

      .button:disabled,
      .link-button[aria-disabled="true"] {
        cursor: default;
        opacity: 0.36;
        pointer-events: none;
      }

      .close {
        min-width: 34px;
        padding-inline: 8px;
        font-size: 17px;
        line-height: 1;
      }

      .viewer {
        min-height: 0;
        position: relative;
        display: grid;
        place-items: center;
        overflow: hidden;
      }

      .stage {
        width: 100%;
        height: 100%;
        display: grid;
        place-items: center;
        padding: 16px 78px 122px;
      }

      .stage img,
      .stage video {
        display: block;
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        filter: drop-shadow(0 18px 48px rgba(0, 0, 0, 0.45));
      }

      .stage video {
        background: #000;
      }

      .empty {
        max-width: 620px;
        padding: 28px;
        color: #b7b8bd;
        font-size: 14px;
        line-height: 1.55;
        text-align: center;
      }

      .gutter {
        appearance: none;
        position: absolute;
        top: 0;
        bottom: 0;
        width: 62px;
        border: 0;
        background: transparent;
        color: rgba(255, 255, 255, 0.46);
        cursor: pointer;
        font-size: 28px;
      }

      .gutter:hover {
        color: #fff;
        background: linear-gradient(90deg, rgba(255, 255, 255, 0.08), transparent);
      }

      .gutter:disabled {
        cursor: default;
        opacity: 0.18;
      }

      .gutter.previous {
        left: 0;
      }

      .gutter.next {
        right: 0;
      }

      .gutter.next:hover {
        background: linear-gradient(270deg, rgba(255, 255, 255, 0.08), transparent);
      }

      .details {
        position: absolute;
        left: 14px;
        right: 14px;
        bottom: 12px;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: end;
        gap: 14px;
        pointer-events: none;
      }

      .post-card {
        min-width: 0;
        max-width: min(760px, 70vw);
        padding: 11px 13px;
        border: 1px solid rgba(255, 255, 255, 0.13);
        border-radius: 9px;
        background: rgba(11, 12, 14, 0.84);
        box-shadow: 0 12px 34px rgba(0, 0, 0, 0.34);
        pointer-events: auto;
        backdrop-filter: blur(16px);
      }

      .post-title {
        display: flex;
        align-items: center;
        gap: 8px;
        overflow: hidden;
        font-size: 14px;
        font-weight: 720;
        line-height: 1.3;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .post-title > span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .source-chip {
        flex: none;
        padding: 3px 6px;
        border: 1px solid rgba(82, 211, 139, 0.28);
        border-radius: 999px;
        color: #78dfa4;
        font: 9px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        text-decoration: none;
      }

      .source-chip:hover {
        border-color: rgba(82, 211, 139, 0.62);
        color: #a0efc1;
      }

      .post-meta {
        margin-top: 5px;
        color: #a6a7ac;
        font-size: 11px;
      }

      .post-actions {
        display: flex;
        gap: 6px;
        margin-top: 9px;
      }

      .post-actions .link-button {
        min-height: 27px;
        padding: 4px 8px;
        font-size: 10px;
      }

      .counters {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 7px;
        pointer-events: auto;
      }

      .counter {
        padding: 5px 8px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 999px;
        background: rgba(10, 11, 13, 0.78);
        color: #c8c9cc;
        font: 10px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }

      .bottombar {
        min-width: 0;
        min-height: 46px;
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        align-items: center;
        gap: 12px;
        padding: 7px 10px;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(10, 11, 13, 0.94);
      }

      .nav-cluster {
        display: flex;
        gap: 6px;
      }

      .diagnostics {
        min-width: 0;
        overflow: hidden;
        color: #8f9197;
        font: 10px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        text-align: center;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      :host([data-phase="error"]) .diagnostics {
        color: #ff8690;
      }

      .hint {
        color: #777980;
        font-size: 10px;
        white-space: nowrap;
      }

      @media (max-width: 760px) {
        .status,
        .hint,
        .version,
        .route {
          display: none;
        }

        .topbar {
          grid-template-columns: minmax(0, 1fr) auto;
        }

        .brand-row {
          display: none;
        }

        .feed-form {
          grid-template-columns: minmax(120px, 1fr) auto auto;
        }

        .feed-form .feed-select[data-role="time-select"] {
          display: none;
        }

        .stage {
          padding-inline: 48px;
        }

        .gutter {
          width: 42px;
        }

        .details {
          grid-template-columns: minmax(0, 1fr);
        }

        .counters {
          display: none;
        }

        .post-card {
          max-width: 100%;
        }

        .bottombar {
          grid-template-columns: auto minmax(0, 1fr);
        }
      }
    `;

    if ('adoptedStyleSheets' in root && typeof CSSStyleSheet !== 'undefined') {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        root.adoptedStyleSheets = [sheet];
        return;
      } catch {
        // Fall back to a style node for userscript engines without constructed stylesheet support.
      }
    }

    const style = document.createElement('style');
    style.textContent = css;
    root.append(style);
  }

  function createShell() {
    const shell = document.createElement('div');
    shell.innerHTML = `
      <button class="launcher" type="button" data-role="launcher" title="Open SubGlass (Alt+Shift+G)">
        SG
      </button>

      <section class="overlay" data-role="overlay" aria-label="SubGlass Reddit overlay">
        <header class="topbar">
          <div class="brand-row">
            <span class="brand">SubGlass</span>
            <span class="version">v1</span>
          </div>
          <div class="feed-editor">
            <form class="feed-form" data-role="feed-form">
              <label class="bundle-control">
                <span class="bundle-prefix">r/</span>
                <input
                  class="bundle-input"
                  data-role="bundle-input"
                  type="text"
                  autocomplete="off"
                  autocapitalize="none"
                  spellcheck="false"
                  placeholder="pics+earthporn"
                  aria-label="Subreddit bundle"
                />
              </label>
              <select class="feed-select" data-role="sort-select" aria-label="Sort">
                <option value="hot">hot</option>
                <option value="new">new</option>
                <option value="top">top</option>
                <option value="rising">rising</option>
                <option value="controversial">controversial</option>
              </select>
              <select class="feed-select" data-role="time-select" aria-label="Time range">
                <option value="hour">hour</option>
                <option value="day">day</option>
                <option value="week">week</option>
                <option value="month">month</option>
                <option value="year">year</option>
                <option value="all">all</option>
              </select>
              <button class="button" type="submit">Load</button>
            </form>
            <span class="route" data-role="route"></span>
          </div>
          <div class="top-actions">
            <span class="status" data-role="status"></span>
            <a class="link-button" data-role="feed-link" target="_blank" rel="noreferrer">Open feed</a>
            <button class="button" type="button" data-action="reload">Reload</button>
            <button class="button close" type="button" data-action="close" aria-label="Close overlay">×</button>
          </div>
        </header>

        <main class="viewer">
          <div class="stage" data-role="stage"></div>
          <div class="empty" data-role="empty"></div>
          <button class="gutter previous" type="button" data-action="previous-post" aria-label="Previous post">‹</button>
          <button class="gutter next" type="button" data-action="next-post" aria-label="Next post">›</button>

          <div class="details">
            <article class="post-card">
              <div class="post-title">
                <a class="source-chip" data-role="subreddit-link" target="_blank" rel="noreferrer"></a>
                <span data-role="title"></span>
              </div>
              <div class="post-meta" data-role="meta"></div>
              <div class="post-actions">
                <a class="link-button" data-role="native-link" target="_blank" rel="noreferrer">Open post</a>
                <a class="link-button" data-role="source-link" target="_blank" rel="noreferrer">Open media</a>
              </div>
            </article>
            <div class="counters">
              <span class="counter" data-role="post-counter"></span>
              <span class="counter" data-role="media-counter"></span>
            </div>
          </div>
        </main>

        <footer class="bottombar">
          <div class="nav-cluster">
            <button class="button" type="button" data-action="previous-media">Media −</button>
            <button class="button" type="button" data-action="next-media">Media +</button>
          </div>
          <div class="diagnostics" data-role="diagnostics"></div>
          <span class="hint">←/→ media · J/K posts · Esc closes</span>
        </footer>
      </section>
    `;
    return shell;
  }

  function bindActions() {
    shadow.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
      const action = target?.getAttribute('data-action');
      if (!action) return;

      if (action === 'close') closeOverlay();
      if (action === 'reload') void loadCurrentContext();
      if (action === 'previous-post') movePost(-1);
      if (action === 'next-post') movePost(1);
      if (action === 'previous-media') moveMedia(-1);
      if (action === 'next-media') moveMedia(1);
    });

    elements.launcher.addEventListener('click', openOverlay);
    elements.feedForm.addEventListener('submit', handleFeedSubmit);
    elements.sortSelect.addEventListener('change', updateTimeSelectState);
  }

  function resolveInitialContext(locationLike) {
    const saved = loadSavedFeed();
    const url = new URL(locationLike.href);
    const pageKey = `${url.pathname}${url.search}`;

    if (saved?.pageKey === pageKey) {
      try {
        return createSubredditContext(
          url,
          normalizeSubredditBundle(saved.bundle),
          saved.sort,
          saved.time,
          'saved',
        );
      } catch {
        // Ignore stale or manually edited local data and derive the feed from the page instead.
      }
    }

    return parseRedditRoute(locationLike);
  }

  function parseRedditRoute(locationLike) {
    const url = new URL(locationLike.href);
    const segments = url.pathname.split('/').filter(Boolean);

    if (segments.length === 0) {
      return createRouteContext(url, {
        kind: 'frontpage',
        source: 'route',
        label: 'frontpage · hot',
        listingPath: '/',
        sort: 'hot',
        time: undefined,
        subreddits: [],
      });
    }

    if (segments[0]?.toLowerCase() !== 'r' || !segments[1]) {
      return {
        supported: false,
        label: url.pathname,
        reason: 'Open a subreddit listing such as /r/pics, then retry.',
        key: `${url.origin}${url.pathname}${url.search}`,
      };
    }

    let subreddits;
    try {
      subreddits = normalizeSubredditBundle(segments[1]);
    } catch (error) {
      return {
        supported: false,
        label: url.pathname,
        reason: error instanceof Error ? error.message : String(error),
        key: `${url.origin}${url.pathname}${url.search}`,
      };
    }

    const candidateSort = segments[2]?.toLowerCase();
    const sort = LISTING_SORTS.has(candidateSort) ? candidateSort : 'hot';
    const time = normalizeListingTime(sort, url.searchParams.get('t'));

    return createSubredditContext(url, subreddits, sort, time, 'route');
  }

  function createSubredditContext(url, subreddits, sort, time, source) {
    const normalizedSort = LISTING_SORTS.has(sort) ? sort : 'hot';
    const normalizedTime = normalizeListingTime(normalizedSort, time);
    const bundle = subreddits.join('+');
    const listingPath = normalizedSort === 'hot'
      ? `/r/${bundle}/`
      : `/r/${bundle}/${normalizedSort}/`;

    return createRouteContext(url, {
      kind: 'subreddits',
      source,
      label: `r/${bundle} · ${normalizedSort}${normalizedTime ? `/${normalizedTime}` : ''}`,
      listingPath,
      sort: normalizedSort,
      time: normalizedTime,
      subreddits,
    });
  }

  function createRouteContext(url, options) {
    const { kind, source, label, listingPath, sort, time, subreddits } = options;
    const jsonUrl = new URL(
      listingPath === '/' ? '/.json' : `${listingPath.replace(/\/+$/, '')}/.json`,
      url.origin,
    );
    jsonUrl.searchParams.set('raw_json', '1');
    jsonUrl.searchParams.set('limit', String(LISTING_LIMIT));
    if (time) jsonUrl.searchParams.set('t', time);

    return {
      supported: true,
      kind,
      source,
      label,
      bundle: subreddits.join('+'),
      subreddits,
      sort,
      time,
      key: jsonUrl.href,
      jsonUrl,
      nativePath: `${listingPath}${time ? `?t=${encodeURIComponent(time)}` : ''}`,
    };
  }

  function normalizeSubredditBundle(value) {
    if (typeof value !== 'string') throw new Error('Enter at least one subreddit.');
    let bundle = value.trim();
    if (!bundle) throw new Error('Enter at least one subreddit.');

    try {
      const inputUrl = new URL(bundle);
      const segments = inputUrl.pathname.split('/').filter(Boolean);
      if (segments[0]?.toLowerCase() === 'r' && segments[1]) bundle = segments[1];
    } catch {
      // Plain multireddit-style input is the normal case.
    }

    bundle = decodeURIComponent(bundle)
      .replace(/^\/?r\//i, '')
      .split('/')[0]
      .trim();

    const names = bundle.split(/[+,\s]+/).filter(Boolean);
    if (names.length === 0) throw new Error('Enter at least one subreddit.');
    if (names.length > MAX_SUBREDDITS) {
      throw new Error(`Use no more than ${MAX_SUBREDDITS} subreddits in one feed.`);
    }

    const normalized = [];
    const seen = new Set();
    for (const name of names) {
      if (!SUBREDDIT_NAME.test(name)) {
        throw new Error(`Invalid subreddit "${name}". Use letters, numbers, or underscores.`);
      }
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push(name);
    }
    return normalized;
  }

  function normalizeListingTime(sort, value) {
    if (sort !== 'top' && sort !== 'controversial') return undefined;
    return LISTING_TIMES.has(value) ? value : 'month';
  }

  function handleFeedSubmit(event) {
    event.preventDefault();

    try {
      const url = new URL(window.location.href);
      const subreddits = normalizeSubredditBundle(elements.bundleInput.value);
      const sort = elements.sortSelect.value;
      const time = elements.timeSelect.value;
      state.context = createSubredditContext(url, subreddits, sort, time, 'custom');
      state.formError = null;
      saveFeed(state.context, url);
      syncFeedForm();
      render();
      void loadCurrentContext();
    } catch (error) {
      state.formError = error instanceof Error ? error.message : String(error);
      render();
      elements.bundleInput.focus();
    }
  }

  function syncFeedForm() {
    const context = state.context;
    elements.bundleInput.value = context?.bundle || '';
    elements.sortSelect.value = context?.sort || 'hot';
    elements.timeSelect.value = context?.time || 'month';
    updateTimeSelectState();
  }

  function updateTimeSelectState() {
    const sort = elements.sortSelect.value;
    elements.timeSelect.disabled = sort !== 'top' && sort !== 'controversial';
  }

  async function openOverlay() {
    if (state.open) return;
    state.open = true;
    host.dataset.open = 'true';
    lockPageScroll();
    render();

    if (
      !state.context?.supported
      || state.phase !== 'ready'
      || state.posts.length === 0
      || state.context.key !== state.lastRequest?.routeKey
    ) {
      await loadCurrentContext();
    }
  }

  function closeOverlay() {
    if (!state.open) return;
    state.open = false;
    host.dataset.open = 'false';
    state.requestController?.abort();
    pauseVisibleVideo();
    restorePageScroll();
  }

  async function loadCurrentContext() {
    state.error = null;
    state.formError = null;

    if (!state.context.supported) {
      state.posts = [];
      state.currentPostIndex = 0;
      state.currentMediaIndex = 0;
      setPhase('error');
      state.error = {
        message: state.context.reason,
        detail: state.context.label,
      };
      render();
      return;
    }

    state.requestController?.abort();
    const controller = new AbortController();
    state.requestController = controller;
    const startedAt = performance.now();

    setPhase('loading');
    state.lastRequest = {
      routeKey: state.context.key,
      url: state.context.jsonUrl.href,
      status: null,
      contentType: null,
      durationMs: null,
      receivedCount: 0,
      supportedCount: 0,
      rateLimit: null,
    };
    render();

    try {
      const response = await window.fetch(state.context.jsonUrl, {
        method: 'GET',
        credentials: 'include',
        headers: {
          accept: 'application/json',
        },
        signal: controller.signal,
      });
      const responseText = await response.text();
      const durationMs = Math.round(performance.now() - startedAt);
      const contentType = response.headers.get('content-type') || 'unknown';

      state.lastRequest.status = response.status;
      state.lastRequest.contentType = contentType;
      state.lastRequest.durationMs = durationMs;
      state.lastRequest.rateLimit = formatRateLimit(response.headers);

      if (!response.ok) {
        throw new Error(
          `Reddit returned HTTP ${response.status} ${response.statusText || ''}`.trim()
          + ` · ${summarizeResponse(responseText) || contentType}`,
        );
      }

      if (!contentType.toLowerCase().includes('json')) {
        throw new Error(`Expected JSON but received ${contentType} · ${summarizeResponse(responseText)}`);
      }

      const payload = JSON.parse(responseText);
      const children = Array.isArray(payload?.data?.children) ? payload.data.children : [];
      const normalizedPosts = children
        .map((child) => normalizeRedditPost(child?.data))
        .filter(Boolean);

      state.lastRequest.receivedCount = children.length;
      state.lastRequest.supportedCount = normalizedPosts.length;
      state.posts = normalizedPosts;
      state.currentPostIndex = 0;
      state.currentMediaIndex = 0;

      if (normalizedPosts.length === 0) {
        throw new Error(`Listing returned ${children.length} posts, but none had media supported by this viewer.`);
      }

      setPhase('ready');
      render();
    } catch (error) {
      if (controller.signal.aborted) return;

      state.posts = [];
      state.currentPostIndex = 0;
      state.currentMediaIndex = 0;
      state.error = {
        message: error instanceof Error ? error.message : String(error),
        detail: state.context.jsonUrl.href,
      };
      setPhase('error');
      render();
    } finally {
      if (state.requestController === controller) state.requestController = null;
    }
  }

  function normalizeRedditPost(post) {
    if (!post || typeof post !== 'object') return null;

    const sourceCandidates = [
      post,
      ...(Array.isArray(post.crosspost_parent_list) ? post.crosspost_parent_list : []),
    ];
    let media = [];

    for (const candidate of sourceCandidates) {
      media = extractGalleryMedia(candidate);
      if (media.length === 0) media = extractVideoMedia(candidate);
      if (media.length === 0) media = extractImageMedia(candidate);
      if (media.length > 0) break;
    }

    if (media.length === 0) return null;

    return {
      id: String(post.id || post.name || Math.random()),
      title: typeof post.title === 'string' && post.title ? post.title : 'Untitled Reddit post',
      subreddit: typeof post.subreddit === 'string' ? post.subreddit : 'unknown',
      author: typeof post.author === 'string' ? post.author : 'unknown',
      score: Number.isFinite(Number(post.score)) ? Number(post.score) : 0,
      comments: Number.isFinite(Number(post.num_comments)) ? Number(post.num_comments) : 0,
      permalink: toHttpUrl(post.permalink || post.url) || window.location.href,
      sourceUrl: toHttpUrl(post.url_overridden_by_dest || post.url) || media[0].url,
      media,
    };
  }

  function extractGalleryMedia(post) {
    const galleryItems = post?.gallery_data?.items;
    const metadata = post?.media_metadata;
    if (!Array.isArray(galleryItems) || !metadata || typeof metadata !== 'object') return [];

    return galleryItems.flatMap((galleryItem, index) => {
      const entry = metadata[galleryItem?.media_id];
      if (!entry || typeof entry !== 'object') return [];

      const source = entry.s || {};
      const fallbackPreview = Array.isArray(entry.p) ? entry.p.at(-1) : null;
      const rawVideoUrl = source.mp4 || source.gif;
      const rawImageUrl = source.u || fallbackPreview?.u;
      const videoUrl = toMediaUrl(rawVideoUrl);
      const imageUrl = toMediaUrl(rawImageUrl);

      if (videoUrl) {
        return [{
          kind: 'video',
          url: videoUrl,
          poster: imageUrl,
          label: `Gallery ${index + 1}`,
        }];
      }

      if (!imageUrl) return [];
      return [{
        kind: 'image',
        url: imageUrl,
        label: `Gallery ${index + 1}`,
      }];
    });
  }

  function extractVideoMedia(post) {
    const redditVideo =
      post?.secure_media?.reddit_video
      || post?.media?.reddit_video
      || post?.preview?.reddit_video_preview;
    const fallbackUrl = toMediaUrl(redditVideo?.fallback_url);

    if (fallbackUrl) {
      return [{
        kind: 'video',
        url: fallbackUrl,
        poster: extractPreviewImage(post),
        label: 'Reddit video',
      }];
    }

    const previewVideo =
      toMediaUrl(post?.preview?.images?.[0]?.variants?.mp4?.source?.url)
      || toMediaUrl(post?.preview?.images?.[0]?.variants?.gif?.source?.url);
    if (previewVideo) {
      return [{
        kind: VIDEO_EXTENSION.test(previewVideo) ? 'video' : 'image',
        url: previewVideo,
        poster: extractPreviewImage(post),
        label: 'Preview video',
      }];
    }

    const directUrl = toMediaUrl(post?.url_overridden_by_dest || post?.url);
    if (directUrl && VIDEO_EXTENSION.test(directUrl)) {
      return [{
        kind: 'video',
        url: directUrl,
        poster: extractPreviewImage(post),
        label: 'Direct video',
      }];
    }

    return [];
  }

  function extractImageMedia(post) {
    const directUrl = toMediaUrl(post?.url_overridden_by_dest || post?.url);
    const previewUrl = extractPreviewImage(post);
    const imageUrl =
      (directUrl && (post?.post_hint === 'image' || IMAGE_EXTENSION.test(directUrl)) ? directUrl : null)
      || previewUrl;

    if (!imageUrl) return [];
    return [{
      kind: 'image',
      url: imageUrl,
      label: 'Image',
    }];
  }

  function extractPreviewImage(post) {
    return toMediaUrl(post?.preview?.images?.[0]?.source?.url)
      || toMediaUrl(post?.thumbnail);
  }

  function toMediaUrl(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (!normalized || NON_MEDIA_URL_VALUES.has(normalized)) return null;
    if (!normalized.startsWith('http://') && !normalized.startsWith('https://') && !normalized.startsWith('/')) {
      return null;
    }
    return toHttpUrl(value);
  }

  function toHttpUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const decoded = value
      .trim()
      .replaceAll('&amp;', '&')
      .replaceAll('&#x2F;', '/')
      .replaceAll('&#39;', "'");

    try {
      const url = new URL(decoded, window.location.origin);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function render() {
    const contextLabel = state.context?.label || window.location.pathname;
    elements.route.textContent = contextLabel;
    elements.status.textContent = getStatusText();
    elements.diagnostics.textContent = getDiagnosticText();
    elements.bundleInput.setAttribute('aria-invalid', state.formError ? 'true' : 'false');
    elements.bundleInput.title = state.formError || 'Separate subreddits with +';

    const currentPost = state.posts[state.currentPostIndex];
    const currentMedia = currentPost?.media[state.currentMediaIndex];
    host.dataset.routeKey = state.context?.key || '';
    host.dataset.bundle = state.context?.bundle || '';
    host.dataset.sourceCount = String(state.context?.subreddits?.length || 0);
    host.dataset.currentPostId = currentPost?.id || '';
    host.dataset.currentMediaIndex = String(currentMedia ? state.currentMediaIndex : -1);
    host.dataset.supportedCount = String(state.posts.length);

    elements.stage.replaceChildren();
    elements.empty.hidden = Boolean(currentMedia);
    elements.empty.textContent = getEmptyText();

    if (currentMedia) {
      const mediaElement = createMediaElement(currentMedia, currentPost);
      elements.stage.append(mediaElement);
    }

    elements.title.textContent = currentPost?.title || 'No supported media loaded';
    elements.subredditLink.textContent = currentPost ? `r/${currentPost.subreddit}` : 'r/—';
    elements.meta.textContent = currentPost
      ? `u/${currentPost.author} · ${formatNumber(currentPost.score)} points · ${formatNumber(currentPost.comments)} comments`
      : 'The native Reddit page remains available underneath this overlay.';
    elements.postCounter.textContent = currentPost
      ? `post ${state.currentPostIndex + 1} / ${state.posts.length}`
      : 'post 0 / 0';
    elements.mediaCounter.textContent = currentPost
      ? `media ${state.currentMediaIndex + 1} / ${currentPost.media.length}`
      : 'media 0 / 0';

    const feedHref = state.context?.supported
      ? new URL(state.context.nativePath, window.location.origin).href
      : null;
    setLink(elements.feedLink, feedHref);
    setLink(
      elements.subredditLink,
      currentPost ? new URL(`/r/${currentPost.subreddit}/`, window.location.origin).href : null,
    );
    setLink(elements.nativeLink, currentPost?.permalink);
    setLink(elements.sourceLink, currentMedia?.url || currentPost?.sourceUrl);

    elements.previousPost.disabled = state.currentPostIndex <= 0;
    elements.nextPost.disabled = state.currentPostIndex >= state.posts.length - 1;
    elements.previousMedia.disabled = !currentPost || state.currentMediaIndex <= 0;
    elements.nextMedia.disabled = !currentPost || state.currentMediaIndex >= currentPost.media.length - 1;
  }

  function createMediaElement(media, post) {
    if (media.kind === 'video') {
      const video = document.createElement('video');
      video.src = media.url;
      video.controls = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = 'metadata';
      if (media.poster) video.poster = media.poster;
      video.setAttribute('aria-label', `${media.label}: ${post.title}`);
      return video;
    }

    const image = document.createElement('img');
    image.src = media.url;
    image.alt = post.title;
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    return image;
  }

  function getStatusText() {
    if (state.formError) return 'Fix the feed configuration';
    if (state.phase === 'loading') return 'Requesting Reddit JSON with active browser credentials…';
    if (state.phase === 'ready') {
      const sourceCount = state.context?.subreddits?.length || 0;
      return sourceCount > 1
        ? `${state.posts.length} media posts · ${sourceCount} subreddits`
        : `${state.posts.length} media posts ready`;
    }
    if (state.phase === 'error') return 'Reddit listing failed';
    return 'Choose a subreddit feed';
  }

  function getEmptyText() {
    if (state.phase === 'loading') return 'Loading this Reddit listing through the page’s own origin…';
    if (state.error) return `${state.error.message}\n\n${state.error.detail || ''}`;
    if (!state.context?.supported) return state.context?.reason || 'This Reddit route is not supported.';
    return 'Enter one or more subreddits above, then press Load.';
  }

  function getDiagnosticText() {
    const request = state.lastRequest;
    if (!request) {
      return [
        `v${SCRIPT_VERSION}`,
        state.formError,
        'same-origin fetch not attempted',
      ].filter(Boolean).join(' · ');
    }

    const parts = [
      request.status ? `HTTP ${request.status}` : 'request pending',
      request.durationMs !== null ? `${request.durationMs}ms` : null,
      request.contentType,
      state.context?.subreddits?.length > 1
        ? `${state.context.subreddits.length} subreddits`
        : null,
      request.receivedCount ? `${request.supportedCount}/${request.receivedCount} media posts` : null,
      request.rateLimit,
    ].filter(Boolean);

    if (state.formError) parts.push(state.formError);
    if (state.error) parts.push(state.error.message);
    return parts.join(' · ');
  }

  function setLink(link, href) {
    if (href) {
      link.href = href;
      link.setAttribute('aria-disabled', 'false');
    } else {
      link.removeAttribute('href');
      link.setAttribute('aria-disabled', 'true');
    }
  }

  function movePost(delta) {
    if (state.posts.length === 0) return;
    const nextIndex = clamp(state.currentPostIndex + delta, 0, state.posts.length - 1);
    if (nextIndex === state.currentPostIndex) return;
    pauseVisibleVideo();
    state.currentPostIndex = nextIndex;
    state.currentMediaIndex = 0;
    render();
  }

  function moveMedia(delta) {
    const currentPost = state.posts[state.currentPostIndex];
    if (!currentPost) return;
    const nextIndex = clamp(state.currentMediaIndex + delta, 0, currentPost.media.length - 1);
    if (nextIndex === state.currentMediaIndex) return;
    pauseVisibleVideo();
    state.currentMediaIndex = nextIndex;
    render();
  }

  function moveThroughMedia(delta) {
    const currentPost = state.posts[state.currentPostIndex];
    if (!currentPost) return;

    if (delta > 0 && state.currentMediaIndex < currentPost.media.length - 1) {
      moveMedia(1);
      return;
    }
    if (delta < 0 && state.currentMediaIndex > 0) {
      moveMedia(-1);
      return;
    }
    movePost(delta);
  }

  function handleKeydown(event) {
    const togglePressed = event.altKey && event.shiftKey && event.key.toLowerCase() === 'g';
    if (togglePressed) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (state.open) closeOverlay();
      else void openOverlay();
      return;
    }

    if (!state.open || isEditableTarget(event.target)) return;

    let handled = true;
    if (event.key === 'Escape') closeOverlay();
    else if (event.key === 'ArrowRight' || event.key.toLowerCase() === 'l' || event.key === ' ') moveThroughMedia(1);
    else if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'h') moveThroughMedia(-1);
    else if (event.key.toLowerCase() === 'j') movePost(1);
    else if (event.key.toLowerCase() === 'k') movePost(-1);
    else if (event.key === ']') moveMedia(1);
    else if (event.key === '[') moveMedia(-1);
    else handled = false;

    if (handled) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  function isEditableTarget(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
  }

  function checkForRouteChange() {
    if (!document.documentElement.contains(host)) {
      document.documentElement.append(host);
    }

    if (state.routeHref === window.location.href) return;
    state.routeHref = window.location.href;
    state.context = parseRedditRoute(window.location);
    state.formError = null;
    syncFeedForm();
    render();
    if (state.open) void loadCurrentContext();
  }

  function lockPageScroll() {
    if (state.lockedPageStyle) return;
    state.lockedPageStyle = {
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      documentOverflow: document.documentElement.style.overflow,
      bodyOverflow: document.body?.style.overflow || '',
    };
    document.documentElement.style.overflow = 'hidden';
    if (document.body) document.body.style.overflow = 'hidden';
  }

  function restorePageScroll() {
    if (!state.lockedPageStyle) return;
    const previous = state.lockedPageStyle;
    state.lockedPageStyle = null;
    document.documentElement.style.overflow = previous.documentOverflow;
    if (document.body) document.body.style.overflow = previous.bodyOverflow;
    window.scrollTo(previous.scrollX, previous.scrollY);
  }

  function pauseVisibleVideo() {
    const video = elements.stage.querySelector('video');
    if (video) video.pause();
  }

  function setPhase(phase) {
    state.phase = phase;
    host.dataset.phase = phase;
  }

  function summarizeResponse(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 180);
  }

  function formatRateLimit(headers) {
    const remaining = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');
    const retryAfter = headers.get('retry-after');
    const parts = [];
    if (remaining) parts.push(`remaining ${remaining}`);
    if (reset) parts.push(`reset ${reset}s`);
    if (retryAfter) parts.push(`retry ${retryAfter}s`);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  function saveFeed(context, pageUrl) {
    if (context?.kind !== 'subreddits') return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: 1,
        pageKey: `${pageUrl.pathname}${pageUrl.search}`,
        bundle: context.bundle,
        sort: context.sort,
        time: context.time || null,
      }));
    } catch {
      // The configured feed still works for this page load when storage is unavailable.
    }
  }

  function loadSavedFeed() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1 || typeof parsed.bundle !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function formatNumber(value) {
    return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }
})();
