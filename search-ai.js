/* =========================================================
   search-ai.js — Local AI-powered search + autocomplete
   -----------------------------------------------------------
   Depends on globals already defined in config.js (loaded first):
     normalizeName, escapeHtml, videoHref, authorHref, authorImageUrl,
     fetchAllVideos, fetchAllAuthors, PLACEHOLDER_IMAGE,
     PLACEHOLDER_AVATAR, siteRootPrefix, shuffleArray

   What it does:
     1. Instant EXACT matches (substring on title/author/tags) —
        shows the moment you type, no model needed.
     2. SEMANTIC matches via a local MiniLM embedding model
        (Xenova/all-MiniLM-L6-v2, ~25MB, runs entirely in the
        browser via WASM — no server, no external search API,
        only your own video/author JSON is ever touched).
     3. Embeddings are cached in IndexedDB keyed by a content hash,
        so a page reload does NOT re-embed videos that haven't
        changed — only new/edited ones get run through the model.
     4. Dropdown layout, top to bottom:
          Creators        — author matches (if any), each row a
                             direct link to that creator's profile
                             page (avatar optional, dropped silently
                             if the image 404s)
          Related Videos   — videos matching the typed query
          More Videos      — a continuation batch that TOPS UP the
                             video section to a fixed total of
                             VIDEO_SECTION_TOTAL (6) — never more.
        Every row has a search icon, the matched portion of the text
        bolded, and a thumbnail/avatar on the right.
     5. The search box itself gets YouTube-style chrome bolted on:
        a "×" clear button that appears once you've typed something,
        and a round submit button, both injected here so every page
        with a #searchInput gets it without editing each page's HTML
        individually.

   FIX (this revision — duplicate search button visible on mobile):
   Previously wireBarChrome() wrapped .search-box in a brand-new
   .sa-bar-wrap div and appended the round .sa-submit-btn there, as a
   SIBLING of .search-box rather than a child of it:
     wrap.appendChild(box);       // .search-box moved INTO wrap
     wrap.appendChild(submitBtn); // submit button next to it, not inside it
   That made .sa-bar-wrap — not .search-box — the actual direct child
   of .header-topbar. style.css's mobile rules
   (`.header-topbar .search-box { display:none }`, shown only via
   `.header-topbar.search-open .search-box`) only ever targeted
   .search-box itself, so .sa-bar-wrap (and the submit button inside
   it) was never covered by that hide rule and stayed visible on
   mobile at all times — right alongside the separate
   #searchToggleBtn icon that was supposed to reveal it. Two search
   icons, always.

   Fixed by never wrapping .search-box at all. Both buttons are now
   injected INSIDE .search-box (in a small absolutely-positioned
   .sa-btn-cluster, same pattern the old .sa-clear-btn already used
   on its own), so .search-box stays the single, direct child of
   .header-topbar that style.css already knows how to size and
   show/hide at every breakpoint — the buttons just inherit that
   automatically, nothing extra to keep in sync.
   The separate #searchToggleBtn mobile toggle has also been removed
   from header.html entirely (see header-footer-init.js) — this
   search box is now the only search UI on the site, shown directly
   as its own full-width row on mobile rather than needing a tap to
   reveal it.

   FIX (earlier revision — clean /search/<query> URLs):
   Pressing Enter (or clicking the round submit button) with no
   dropdown item highlighted used to hard-navigate to
   `${siteRootPrefix()}index.html?q=<query>`. The site now serves
   search results at a clean path instead — /search/<query> — backed
   by a Cloudflare Pages rewrite rule (see /_redirects:
   "/search/:query  /index.html  200"), the same pattern already used
   for /models/<slug>. This file's only job in that flow is building
   that URL correctly:
     - encodeSearchQuery() percent-encodes the query and then swaps
       %20 back to a literal "+" for spaces (classic search-string
       style), so "user query" becomes "/search/user+query" instead
       of the uglier "/search/user%20query". Any literal "+" the user
       actually typed is still safely escaped to %2B by
       encodeURIComponent() before that swap, so it round-trips
       correctly on the way back out (see decodeSearchQuery() in
       script.js, which does the exact inverse).
     - submitQuery() now always builds an ABSOLUTE path
       (`/search/...`) rather than a siteRootPrefix()-relative one,
       since the Pages rewrite rule matches on the site root
       regardless of how deep the page you searched FROM was (watch
       page, profile page, home page, etc.).

   FIX (earlier revision — video count cap):
   Related Videos and More Videos used to be sized independently
   (up to MAX_VIDEO_RESULTS matches PLUS a separate, always-6-deep
   "More Videos" batch stacked underneath), so a query with several
   real matches could balloon the dropdown to 10+ video rows.
   Now the two sections share one fixed budget of VIDEO_SECTION_TOTAL
   (6) videos total:
     - If there are 6 or more actual matches, show 6 matches and 0
       recommended fill-ins.
     - If there are, say, 5 actual matches, show those 5 plus exactly
       1 recommended video to top up to 6.
     - If there are 0 actual matches, the empty-state fallback shows
       6 recommended videos on its own (unchanged section, same cap).
   Author/Creator results are a separate section and are not counted
   against this video budget.

   FIX (earlier revision — resilient index build):
   the search index used to be built with
   Promise.all([fetchAllVideos(), fetchAllAuthors()]) — if EITHER
   fetch failed, the whole Promise.all rejected and buildOrUpdateIndex()
   never ran at all, silently disabling search entirely (including
   video search, which has nothing to do with authors). This mattered
   because AUTHOR_JSON_URLS (authors.json) is no longer the source of
   truth for profile data — the D1 "models" table is — so that feed
   is more likely to be stale/unreachable/empty now. Switched to
   Promise.allSettled so a failed author fetch only disables author
   search (Creators section just stays empty), while video search
   keeps working normally either way.
   ========================================================= */

import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";

env.allowLocalModels = false;
env.useBrowserCache = true;

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const DB_NAME = "streamhub_search_cache_v1";
const DB_VERSION = 1;
const STORE_VIDEOS = "video_vectors";
const STORE_AUTHORS = "author_vectors";

const SEMANTIC_MIN_SCORE = 0.38;   // cosine similarity floor to count as a semantic match
const MAX_AUTHOR_RESULTS = 3;

// Video section budget: Related Videos (actual matches) + More Videos
// (recommended fill-ins) always add up to exactly this many rows —
// never more. E.g. actual=6 -> recommended=0; actual=5 -> recommended=1;
// actual=0 -> the empty-state fallback shows this many on its own.
const VIDEO_SECTION_TOTAL = 6;
const MAX_VIDEO_RESULTS = VIDEO_SECTION_TOTAL; // actual matches can never exceed the total budget either
const RELATED_FALLBACK_COUNT = VIDEO_SECTION_TOTAL; // empty-state ("no matches") fallback batch size

const DEBOUNCE_MS = 160;
const EMBED_CHUNK_SIZE = 16;       // items embedded per idle chunk, keeps typing smooth

/* ---------------- clean /search/<query> URL helpers ----------------
   encodeSearchQuery() is the ONLY place in this file responsible for
   turning a raw query string into the path segment used at
   /search/<encoded>. script.js owns the inverse (decodeSearchQuery())
   for reading it back out of window.location.pathname on load — keep
   the two in sync if either ever changes. */
function encodeSearchQuery(q) {
  // encodeURIComponent() already turns a literal "+" the user typed
  // into "%2B" (so it can't collide with our own "+" for spaces),
  // and turns spaces into "%20" — swap that %20 to "+" last so the
  // resulting path reads like a classic search string:
  // "user query" -> "user+query".
  return encodeURIComponent(q).replace(/%20/g, "+");
}

/* ---------------- tiny IndexedDB helper ---------------- */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_VIDEOS)) db.createObjectStore(STORE_VIDEOS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_AUTHORS)) db.createObjectStore(STORE_AUTHORS, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetAll(db, store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbPutMany(db, store, records) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    records.forEach((r) => tx.objectStore(store).put(r));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------------- hashing (detects changed content, skips re-embedding unchanged items) ---------------- */
function hashText(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function cosineSim(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are already L2-normalized, so dot product == cosine similarity
}

function idleChunks(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
function runWhenIdle(fn) {
  return new Promise((resolve) => {
    const ric = window.requestIdleCallback || ((cb) => setTimeout(cb, 0));
    ric(() => resolve(fn()));
  });
}

/* ---------------- model (lazy-loaded on first focus/input) ---------------- */
let extractorPromise = null;
function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", MODEL_ID, { quantized: true });
  }
  return extractorPromise;
}
async function embedText(text) {
  const extractor = await getExtractor();
  const out = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(out.data);
}

/* ---------------- search engine state ---------------- */
const engine = {
  ready: false,          // model loaded
  videos: [],             // raw video objects (from fetchAllVideos)
  authors: [],            // raw author objects (from fetchAllAuthors) — may stay empty, see FIX note above
  videoVecs: new Map(),   // id -> { vector, hash, ref (video obj) }
  authorVecs: new Map(),  // id -> { vector, hash, ref (author obj) }
};

function videoSearchId(v) { return String(v.uniqueId ?? v.id ?? ""); }
function videoSearchText(v) { return [v.title, v.author, (v.tags || []).join(" ")].filter(Boolean).join(" "); }
function authorSearchId(a) { return normalizeName(a.name) || String(a.id ?? ""); }
function authorSearchText(a) { return [a.name, a.bio].filter(Boolean).join(" "); }

async function buildOrUpdateIndex(videos, authors) {
  engine.videos = videos;
  engine.authors = authors;

  const db = await openDb();
  const [cachedVideos, cachedAuthors] = await Promise.all([
    idbGetAll(db, STORE_VIDEOS),
    idbGetAll(db, STORE_AUTHORS),
  ]);
  const cachedVideoMap = new Map(cachedVideos.map((r) => [r.id, r]));
  const cachedAuthorMap = new Map(cachedAuthors.map((r) => [r.id, r]));

  // Populate in-memory maps from cache immediately (so exact search + any
  // already-cached semantic vectors work right away, before the model
  // has even loaded for NEW items).
  cachedVideoMap.forEach((r, id) => engine.videoVecs.set(id, { vector: r.vector, hash: r.hash, ref: null }));
  cachedAuthorMap.forEach((r, id) => engine.authorVecs.set(id, { vector: r.vector, hash: r.hash, ref: null }));

  // Figure out what actually needs (re-)embedding.
  const videosToEmbed = [];
  videos.forEach((v) => {
    const id = videoSearchId(v);
    if (!id) return;
    const hash = hashText(videoSearchText(v));
    const cached = cachedVideoMap.get(id);
    engine.videoVecs.set(id, { vector: cached && cached.hash === hash ? cached.vector : null, hash, ref: v });
    if (!cached || cached.hash !== hash) videosToEmbed.push({ id, text: videoSearchText(v), hash });
  });

  const authorsToEmbed = [];
  authors.forEach((a) => {
    const id = authorSearchId(a);
    if (!id) return;
    const hash = hashText(authorSearchText(a));
    const cached = cachedAuthorMap.get(id);
    engine.authorVecs.set(id, { vector: cached && cached.hash === hash ? cached.vector : null, hash, ref: a });
    if (!cached || cached.hash !== hash) authorsToEmbed.push({ id, text: authorSearchText(a), hash });
  });

  // Wire refs for cached-only entries too (needed to render results).
  videos.forEach((v) => { const e = engine.videoVecs.get(videoSearchId(v)); if (e) e.ref = v; });
  authors.forEach((a) => { const e = engine.authorVecs.get(authorSearchId(a)); if (e) e.ref = a; });

  if (videosToEmbed.length === 0 && authorsToEmbed.length === 0) {
    engine.ready = true;
    return;
  }

  // Embed anything new/changed in small idle-time chunks so the page
  // never jank-freezes. First chunk loads the model (one-time cold start).
  const toEmbedAll = [
    ...videosToEmbed.map((x) => ({ ...x, store: STORE_VIDEOS, map: engine.videoVecs })),
    ...authorsToEmbed.map((x) => ({ ...x, store: STORE_AUTHORS, map: engine.authorVecs })),
  ];

  for (const chunk of idleChunks(toEmbedAll, EMBED_CHUNK_SIZE)) {
    await runWhenIdle(async () => {
      const toSave = { [STORE_VIDEOS]: [], [STORE_AUTHORS]: [] };
      for (const item of chunk) {
        const vector = await embedText(item.text);
        item.map.get(item.id).vector = vector;
        toSave[item.store].push({ id: item.id, hash: item.hash, vector });
      }
      if (toSave[STORE_VIDEOS].length) await idbPutMany(db, STORE_VIDEOS, toSave[STORE_VIDEOS]);
      if (toSave[STORE_AUTHORS].length) await idbPutMany(db, STORE_AUTHORS, toSave[STORE_AUTHORS]);
    });
  }

  engine.ready = true;
}

/* ---------------- ranking ---------------- */
function exactScore(haystack, q) {
  const h = normalizeName(haystack);
  if (!h || !q) return -1;
  if (h === q) return 3;
  if (h.startsWith(q)) return 2;
  if (h.includes(q)) return 1;
  return -1;
}

async function search(query) {
  const qRaw = query.trim();
  if (!qRaw) return { authors: [], videos: [] };
  const q = normalizeName(qRaw);

  const authorHits = new Map(); // id -> score
  const videoHits = new Map();

  engine.authorVecs.forEach((entry, id) => {
    const a = entry.ref;
    if (!a) return;
    const s = exactScore(a.name, q);
    if (s > 0) authorHits.set(id, 10 + s); // exact matches always outrank semantic
  });
  engine.videoVecs.forEach((entry, id) => {
    const v = entry.ref;
    if (!v) return;
    const titleScore = exactScore(v.title, q);
    const authorScore = exactScore(v.author, q);
    const tagScore = Array.isArray(v.tags) && v.tags.some((t) => normalizeName(t).includes(q)) ? 1 : -1;
    const best = Math.max(titleScore, authorScore, tagScore);
    if (best > 0) videoHits.set(id, 10 + best);
  });

  // Semantic pass — only if the query is meaningful (2+ chars) and the
  // model has finished loading (falls back silently to exact-only otherwise,
  // which still returns instantly).
  if (qRaw.length >= 2 && engine.ready) {
    try {
      const qVec = await embedText(qRaw);
      engine.authorVecs.forEach((entry, id) => {
        if (authorHits.has(id) || !entry.vector) return;
        const sim = cosineSim(qVec, entry.vector);
        if (sim >= SEMANTIC_MIN_SCORE) authorHits.set(id, sim);
      });
      engine.videoVecs.forEach((entry, id) => {
        if (videoHits.has(id) || !entry.vector) return;
        const sim = cosineSim(qVec, entry.vector);
        if (sim >= SEMANTIC_MIN_SCORE) videoHits.set(id, sim);
      });
    } catch (err) {
      console.warn("[search-ai] semantic search unavailable:", err);
    }
  }

  const authors = [...authorHits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_AUTHOR_RESULTS)
    .map(([id]) => engine.authorVecs.get(id).ref);

  // Actual matches are capped at the video section's total budget —
  // this is what allows the "More Videos" top-up below to compute a
  // clean remainder (never negative, never doubling past the cap).
  const videos = [...videoHits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_VIDEO_RESULTS)
    .map(([id]) => engine.videoVecs.get(id).ref);

  return { authors, videos };
}

/* ---------------- "more videos" continuation ---------------- */
// Picks a batch of videos to show below the direct matches — favors
// most-viewed, falling back to random shuffle if view counts aren't
// present. excludeIds keeps it from repeating whatever's already
// listed above it in the dropdown.
function pickMoreVideos(excludeIds, count) {
  if (count <= 0) return [];
  const pool = engine.videos.filter((v) => !excludeIds.has(videoSearchId(v)));
  const hasViews = pool.some((v) => typeof v.views === "number");
  const ranked = hasViews ? pool.slice().sort((a, b) => (b.views || 0) - (a.views || 0)) : shuffleArray(pool);
  return ranked.slice(0, count);
}

/* ---------------- UI ---------------- */
function injectStyles() {
  if (document.getElementById("search-ai-styles")) return;
  const style = document.createElement("style");
  style.id = "search-ai-styles";
  style.textContent = `
    /* ---- Search bar chrome (clear btn, round submit btn) ----
       Both buttons live INSIDE .search-box, in .sa-btn-cluster —
       never as a sibling/wrapper around .search-box. .search-box
       stays the single, direct child of .header-topbar so every
       breakpoint rule in style.css (desktop max-widths, the mobile
       full-width row) keeps applying to it — and to these buttons —
       automatically, with nothing extra for style.css to know about. */
    .search-box .icon { display: none !important; }
    .search-box {
      position: relative;
      display: flex;
      align-items: center;
    }
    .search-box input#searchInput {
      padding-left: 16px !important;
      padding-right: 78px !important;
    }
    .sa-btn-cluster {
      position: absolute;
      right: 6px;
      top: 50%;
      transform: translateY(-50%);
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .sa-clear-btn {
      flex: 0 0 auto;
      width: 22px;
      height: 22px;
      border: none;
      background: transparent;
      color: #9a9aa0;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      padding: 0;
    }
    .sa-clear-btn:hover { background: rgba(255,255,255,0.08); color: #f1f1f1; }
    .sa-submit-btn {
      flex: 0 0 auto;
      width: 34px;
      height: 34px;
      border-radius: 50%;
      border: 1px solid rgba(255,255,255,0.1);
      background: #1b1b1e;
      color: #d4d4d9;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
    }
    .sa-submit-btn:hover {
      background: #53FC18;
      color: #0e0e10;
      border-color: #53FC18;
    }

    /* Kill native browser chrome on the search input — it collides
       with our own .sa-clear-btn (custom ×) and would otherwise show
       a second, browser-drawn × inside type="search" inputs. */
    .search-box input#searchInput::-webkit-search-cancel-button,
    .search-box input#searchInput::-webkit-search-decoration,
    .search-box input#searchInput::-webkit-search-results-button,
    .search-box input#searchInput::-webkit-search-results-decoration {
      -webkit-appearance: none;
      appearance: none;
    }

    /* ---- Suggestion dropdown ---- */
    .sa-dropdown {
      position: absolute; top: calc(100% + 8px); left: 0; right: 0;
      background: #212121; border: 1px solid rgba(255,255,255,0.08);
      border-radius: 20px; box-shadow: 0 12px 32px rgba(0,0,0,0.5);
      overflow: hidden; z-index: 500; max-height: 70vh; overflow-y: auto;
      display: none; padding: 6px 0;
    }
    .sa-dropdown.open { display: block; }
    .sa-section-label {
      font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
      color: #8a8a92; padding: 10px 20px 4px;
    }
    .sa-item {
      display: flex; align-items: center; gap: 14px; padding: 9px 20px;
      text-decoration: none; color: #f1f1f1; cursor: pointer;
    }
    .sa-item:hover, .sa-item.active { background: rgba(255,255,255,0.08); }
    .sa-icon {
      flex: 0 0 auto; width: 18px; height: 18px; color: #aaaaaa;
      display: flex; align-items: center; justify-content: center;
    }
    .sa-item-text { min-width: 0; flex: 1 1 auto; }
    .sa-item-title {
      font-size: 14px; font-weight: 400; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; color: #f1f1f1;
    }
    .sa-item-title b { font-weight: 700; color: #ffffff; }
    .sa-item-sub { font-size: 12px; color: #aaaaaa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sa-thumb-right {
      flex: 0 0 auto; width: 52px; height: 34px; border-radius: 6px;
      object-fit: cover; background: #3a3a3a;
    }
    .sa-thumb-right.sa-avatar-right { width: 34px; height: 34px; border-radius: 50%; }
    .sa-loading { padding: 14px 20px; font-size: 13px; color: #9a9aa0; text-align: center; }
    .sa-empty { padding: 12px 20px 2px; font-size: 12.5px; color: #9a9aa0; }
  `;
  document.head.appendChild(style);
}

const SA_ICON_SEARCH = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`;
const SA_ICON_CLOSE = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Bolds the first case-insensitive match of the raw (un-normalized)
// query inside text, e.g. highlightMatch("Munna Bhai Gaming", "munna")
// -> "<b>Munna</b> Bhai Gaming". Falls back to plain escaped text if
// the raw query can't be found verbatim (e.g. it only matched after
// accent/punctuation normalization) — highlighting is cosmetic only,
// never required for the match itself.
function highlightMatch(text, rawQuery) {
  const safe = escapeHtml(text || "");
  const q = (rawQuery || "").trim();
  if (!q) return safe;
  const re = new RegExp(escapeRegex(escapeHtml(q)), "i");
  return safe.replace(re, (m) => `<b>${m}</b>`);
}

// Author rows always link straight to that creator's profile page —
// the row IS the link (whole row clickable). Photo comes from the
// same authors-iu6.pages.dev bucket the video cards use; if it 404s,
// onerror just drops the image and the row falls back to a plain
// text suggestion (no broken-image icon).
function itemAuthorHtml(author, rawQuery) {
  const photo = authorImageUrl(author.name);
  return `<a class="sa-item" data-kind="author" href="${authorHref({ name: author.name })}">
    <span class="sa-icon">${SA_ICON_SEARCH}</span>
    <div class="sa-item-text">
      <div class="sa-item-title">${highlightMatch(author.name, rawQuery)}</div>
      <div class="sa-item-sub">Creator</div>
    </div>
    ${photo ? `<img class="sa-thumb-right sa-avatar-right" src="${photo}" alt="" loading="lazy" onerror="this.remove();">` : ""}
  </a>`;
}

// When a query matches nothing (no exact hit, no semantic hit above
// threshold) this picks a fallback batch of videos to show instead of
// a dead-end "no results" screen — favors your most-viewed videos,
// falling back to a random shuffle if view counts aren't present.
// Capped at the same VIDEO_SECTION_TOTAL budget as every other case.
function getRelatedFallback() {
  return pickMoreVideos(new Set(), RELATED_FALLBACK_COUNT);
}

function itemVideoHtml(video, rawQuery) {
  const thumb = video.thumbnail || video.thumb || PLACEHOLDER_IMAGE;
  return `<a class="sa-item" data-kind="video" href="${videoHref(video)}">
    <span class="sa-icon">${SA_ICON_SEARCH}</span>
    <div class="sa-item-text">
      <div class="sa-item-title">${highlightMatch(video.title || "Untitled", rawQuery)}</div>
      <div class="sa-item-sub">${escapeHtml(video.author || "")}</div>
    </div>
    <img class="sa-thumb-right" src="${thumb}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}';">
  </a>`;
}

function initSearchAI() {
  const input = document.getElementById("searchInput");
  const box = document.querySelector(".search-box");
  if (!input || !box) return;

  injectStyles();
  if (getComputedStyle(box).position === "static") box.style.position = "relative";

  const dropdown = document.createElement("div");
  dropdown.className = "sa-dropdown";
  box.appendChild(dropdown);

  let flatResults = []; // [{kind, data}] in render order, for keyboard nav
  let activeIndex = -1;
  let debounceTimer = null;
  let requestSeq = 0;

  function close() {
    dropdown.classList.remove("open");
    dropdown.innerHTML = "";
    flatResults = [];
    activeIndex = -1;
  }

  // Navigates to the clean /search/<query> URL (backed by the
  // Cloudflare Pages rewrite in /_redirects). Always an absolute
  // path — the rewrite lives at the site root, so it applies no
  // matter which page (home, watch, profile, etc.) this was
  // triggered from.
  function submitQuery() {
    const q = input.value.trim();
    if (!q) { input.focus(); return; }
    close();
    window.location.href = `/search/${encodeSearchQuery(q)}`;
  }

  /* -----------------------------------------------------------
     Search bar chrome — a "×" clear button plus a round submit
     button, both injected INSIDE .search-box (in .sa-btn-cluster)
     so no per-page HTML edits are needed and .search-box remains
     the single element style.css sizes/shows/hides at every
     breakpoint. The original decorative .icon from the page markup
     is hidden via injectStyles().

     Also strips native browser affordances (autocomplete dropdown,
     spellcheck squiggly underline, autocorrect/autocapitalize) that
     would otherwise visually clash with our own dropdown/clear
     button.
     ----------------------------------------------------------- */
  function wireBarChrome() {
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("autocapitalize", "off");

    let cluster = box.querySelector(".sa-btn-cluster");
    if (!cluster) {
      cluster = document.createElement("div");
      cluster.className = "sa-btn-cluster";
      box.appendChild(cluster);
    }

    let clearBtn = cluster.querySelector(".sa-clear-btn");
    if (!clearBtn) {
      clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "sa-clear-btn";
      clearBtn.setAttribute("aria-label", "Clear search");
      clearBtn.innerHTML = SA_ICON_CLOSE;
      clearBtn.hidden = !input.value.trim();
      cluster.appendChild(clearBtn);
      clearBtn.addEventListener("click", () => {
        input.value = "";
        clearBtn.hidden = true;
        close();
        input.focus();
      });
    }

    let submitBtn = cluster.querySelector(".sa-submit-btn");
    if (!submitBtn) {
      submitBtn = document.createElement("button");
      submitBtn.type = "button";
      submitBtn.className = "sa-submit-btn";
      submitBtn.setAttribute("aria-label", "Search");
      submitBtn.innerHTML = SA_ICON_SEARCH;
      cluster.appendChild(submitBtn);
      submitBtn.addEventListener("click", submitQuery);
    }

    return clearBtn;
  }

  const clearBtn = wireBarChrome();

  /* -----------------------------------------------------------
     render() — dropdown contents, top to bottom:
       Creators        (author matches, if any — separate budget,
                        not counted against the video total)
       Related Videos  (actual matches for the typed query)
       More Videos     (recommended top-up so Related + More videos
                        always equals VIDEO_SECTION_TOTAL — e.g.
                        5 actual + 1 recommended = 6, or
                        6 actual + 0 recommended = 6)
     ----------------------------------------------------------- */
  function render(authors, videos, loadingSemantic, rawQuery) {
    const matchResults = [
      ...authors.map((a) => ({ kind: "author", data: a })),
      ...videos.map((v) => ({ kind: "video", data: v })),
    ];

    if (!matchResults.length) {
      activeIndex = -1;
      if (loadingSemantic) {
        flatResults = [];
        dropdown.innerHTML = `<div class="sa-loading">Searching…</div>`;
        dropdown.classList.add("open");
        return;
      }
      // Model finished and truly found nothing — never dead-end,
      // show a related-videos fallback instead (capped at
      // VIDEO_SECTION_TOTAL, same budget as every other case).
      const related = getRelatedFallback();
      flatResults = related.map((v) => ({ kind: "video", data: v }));
      dropdown.innerHTML =
        `<div class="sa-empty">No matches for that — here's what people are watching:</div>` +
        `<div class="sa-section-label">Related Videos</div>` +
        related.map((v) => itemVideoHtml(v, "")).join("");
      dropdown.classList.add("open");
      return;
    }

    // Top up the video section to a fixed total of VIDEO_SECTION_TOTAL:
    // actual matches (videos) + recommended fill-ins (moreVideos) always
    // sum to exactly this cap (never more). E.g. 6 actual -> 0 more;
    // 5 actual -> 1 more; 2 actual -> 4 more.
    const shownVideoIds = new Set(videos.map(videoSearchId));
    const remainingSlots = Math.max(0, VIDEO_SECTION_TOTAL - videos.length);
    const moreVideos = pickMoreVideos(shownVideoIds, remainingSlots);

    flatResults = [...matchResults, ...moreVideos.map((v) => ({ kind: "video", data: v }))];
    activeIndex = -1;

    let html = "";
    if (authors.length) {
      html += `<div class="sa-section-label">Creators</div>`;
      html += authors.map((a) => itemAuthorHtml(a, rawQuery)).join("");
    }
    if (videos.length) {
      html += `<div class="sa-section-label">Related Videos</div>`;
      html += videos.map((v) => itemVideoHtml(v, rawQuery)).join("");
    }
    if (moreVideos.length) {
      html += `<div class="sa-section-label">More Videos</div>`;
      html += moreVideos.map((v) => itemVideoHtml(v, "")).join("");
    }
    dropdown.innerHTML = html;
    dropdown.classList.add("open");
  }

  function setActive(index) {
    const items = dropdown.querySelectorAll(".sa-item");
    items.forEach((el) => el.classList.remove("active"));
    if (index >= 0 && items[index]) {
      items[index].classList.add("active");
      items[index].scrollIntoView({ block: "nearest" });
    }
    activeIndex = index;
  }

  async function runSearch(query) {
    const seq = ++requestSeq;
    if (!query) { close(); return; }

    // Fast pass: exact matches only (plus any already-cached semantic
    // vectors), renders near-instantly.
    const fast = await search(query);
    if (seq !== requestSeq) return;
    render(fast.authors, fast.videos, !engine.ready, query);

    // If the model wasn't ready yet, once it finishes loading re-run
    // the same query automatically (only if the box still has focus
    // and the text hasn't changed since).
    if (!engine.ready) {
      getExtractor().then(async () => {
        if (seq !== requestSeq || document.activeElement !== input) return;
        const full = await search(query);
        if (seq !== requestSeq) return;
        render(full.authors, full.videos, false, query);
      }).catch(() => {});
    }
  }

  input.addEventListener("input", () => {
    clearBtn.hidden = !input.value.trim();
    clearTimeout(debounceTimer);
    const query = input.value.trim();
    debounceTimer = setTimeout(() => runSearch(query), DEBOUNCE_MS);
  });

  input.addEventListener("focus", () => {
    getExtractor().catch(() => {}); // warm the model up as soon as the user engages the search box
    if (input.value.trim() && flatResults.length) dropdown.classList.add("open");
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (dropdown.classList.contains("open") && activeIndex >= 0 && flatResults[activeIndex]) {
        const chosen = flatResults[activeIndex];
        window.location.href = chosen.kind === "author"
          ? authorHref({ name: chosen.data.name })
          : videoHref(chosen.data);
      } else {
        submitQuery();
      }
      return;
    }
    if (!dropdown.classList.contains("open") || !flatResults.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(Math.min(activeIndex + 1, flatResults.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (e.key === "Escape") {
      close();
      input.blur();
    }
  });

  document.addEventListener("click", (e) => {
    if (!box.contains(e.target)) close();
  });

  /* -----------------------------------------------------------
     Build/refresh the embedding index once video + author data is
     available. Uses Promise.allSettled (see FIX note at top of file)
     so a broken/empty author feed only means the Creators section
     stays empty — it can no longer take video search down with it.
     ----------------------------------------------------------- */
  Promise.allSettled([fetchAllVideos(), fetchAllAuthors()]).then(([videosResult, authorsResult]) => {
    const videos = videosResult.status === "fulfilled" ? videosResult.value : [];
    const authors = authorsResult.status === "fulfilled" ? authorsResult.value : [];

    if (videosResult.status === "rejected") {
      console.error("[search-ai] failed to load videos — search will be empty until this succeeds:", videosResult.reason);
    }
    if (authorsResult.status === "rejected") {
      console.warn("[search-ai] failed to load authors — Creators suggestions disabled, video search unaffected:", authorsResult.reason);
    }

    return buildOrUpdateIndex(videos, authors);
  }).catch((err) => console.error("[search-ai] failed to build index:", err));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSearchAI);
} else {
  initSearchAI();
}