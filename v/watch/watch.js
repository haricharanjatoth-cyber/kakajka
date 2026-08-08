/* =========================================================
   v/watch/watch.js — logic for the single dynamic watch template (v/watch.html,
   served at the clean root URL /watch/<title-slug> via the
   /_redirects rewrite — see config.js).
   Depends on config.js having already loaded (fetchAllVideos,
   fetchVideoApiData, fetchDirectVideoUrl, videoHref, authorHref,
   categoryHref, currentVideoSlugFromUrl, slugifyName, normalizeName,
   videosByAuthorName, videoCardHtml, adCardHtml, pickRowAdKey,
   fillAdSlot, wireLazyAdCards, PLACEHOLDER_IMAGE).
   ========================================================= */

(function () {
  "use strict";

  let allVideos = [];
  let currentVideo = null;
  let relatedPool = [];      // full candidate list (search-filtered or not)
  let relatedShownCount = 0;
  let searchActive = false;

  function formatViews(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M views";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K views";
    return n + " views";
  }

  function formatDate(d) {
    if (!d) return "";
    const dt = new Date(d);
    if (isNaN(dt)) return "";
    return dt.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  /* ---------------- Player ---------------- */
  // Video hosting/embed URLs commonly look nothing like a plain file —
  // treat anything ending in a known video-file extension as a direct
  // file for <video>, and everything else (embed pages, iframes from a
  // third-party host) as something that needs an <iframe> instead.
  function looksLikeDirectVideoFile(url) {
    return /\.(mp4|webm|ogg|ogv|mov|m3u8)(\?.*)?$/i.test(url);
  }

  // Fetches the worker's data for this video ONCE and returns it, so
  // both the player and the live view count can be filled in from the
  // same network call instead of hitting the worker twice.
  async function resolveVideoApiData(video) {
    // 1) Already embedded in this video's own JSON entry — no network
    //    call needed. Covers datasets where the playable link ships
    //    directly instead of being looked up from VIDEO_API_URL. In
    //    this case there's no live view count from the worker either.
    const inline = video.directVideoUrl || video.videoUrl || video.src || video.embedUrl;
    if (inline) return { directVideoUrl: inline, views: null };

    // 2) Fall back to the Cloudflare Worker lookup by uniqueId (or id,
    //    if that's the field this video's JSON entry uses instead),
    //    which returns both directVideoUrl and views together.
    try {
      const data = await fetchVideoApiData(video.uniqueId ?? video.id);
      return data || { directVideoUrl: null, views: null };
    } catch (err) {
      console.error("[watch] fetchVideoApiData threw:", err);
      return { directVideoUrl: null, views: null };
    }
  }

  async function renderPlayer(video, apiData) {
    const wrap = document.getElementById("playerWrap");
    const directUrl = apiData.directVideoUrl;

    if (!directUrl) {
      wrap.innerHTML = `
        <div class="player-error">
          This video isn't available to play right now — no playable link is on
          file for it yet (checked the video's own JSON entry and the
          VIDEO_API_URL worker for uniqueId "${video.uniqueId ?? video.id}", both came back
          empty). If you expect one, check DevTools → Network for a failed
          request to ${VIDEO_API_URL} — a 404 there means no row exists yet for
          this uniqueId; a CORS error means the Worker needs to allow this
          site's origin.
        </div>`;
      return;
    }

    if (looksLikeDirectVideoFile(directUrl)) {
      wrap.innerHTML = `
        <video class="watch-player" controls preload="metadata"
               poster="${video.thumbnail || video.thumb || PLACEHOLDER_IMAGE}">
          <source src="${directUrl}">
          Your browser doesn't support HTML5 video.
        </video>`;
      const videoEl = wrap.querySelector("video");
      videoEl.addEventListener("error", () => {
        console.error("[watch] <video> failed to load source:", directUrl, videoEl.error);
        wrap.innerHTML = `
          <div class="player-error">
            The video source didn't load (HTTP error, wrong format, or the host
            blocked this site from embedding it). Direct link:
            <a href="${directUrl}" target="_blank" rel="noopener noreferrer">open it directly</a>.
          </div>`;
      });
    } else {
      // Not a recognizable direct file — treat as an embeddable page
      // (common for third-party video hosts that only give you an
      // embed/player URL, not a raw .mp4).
      //
      // sandbox is the actual fix for ad-redirect hijacking: it blocks
      // the embedded page/ads from navigating this tab away
      // (top.location / window.top.location tricks) AND from opening
      // new tabs/windows (window.open, target="_blank" popups),
      // because neither allow-top-navigation* nor allow-popups is
      // listed. Everything a normal player legitimately needs is still
      // granted: allow-scripts (JS execution), allow-same-origin (the
      // player's own storage/XHR), allow-forms (any in-player UI forms),
      // allow-presentation (fullscreen/casting APIs some players use).
      //
      // referrerpolicy="no-referrer" is a bonus hardening step so the
      // ad network on the other side gets no referrer info about this
      // site to branch its redirect behavior on.
      wrap.innerHTML = `
        <iframe class="watch-player" src="${directUrl}" allowfullscreen
                allow="autoplay; encrypted-media; picture-in-picture"
                sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"
                referrerpolicy="no-referrer"
                style="border:0; width:100%; height:100%;"></iframe>`;
    }
  }

  /* ---------------- Info / meta ---------------- */
  function renderInfo(video) {
    document.getElementById("watchTitle").textContent = video.title || "Untitled";

    const authorLink = document.getElementById("watchAuthorLink");
    if (video.author) {
      authorLink.textContent = video.author;
      authorLink.href = authorHref({ name: video.author });
      authorLink.style.display = "";
    }

    // Views are NOT taken from the static JSON here — they're only
    // ever set from the live TurboVIPlay fetch, in updateViewsDisplay(),
    // once resolveVideoApiData() resolves. Kept hidden until then.
    document.getElementById("watchViews").style.display = "none";
    document.getElementById("watchDate").textContent = formatDate(video.uploadDate || video.date);

    // FIX (this revision): tag pills below the video now navigate to
    // the /categories/<slug> hub — same categoryHref() helper used by
    // the home page sidebar tag cloud and the /categories page itself
    // (see config.js) — instead of the old <button> that ran an
    // in-page related-video search via runSearch(). Real <a> links,
    // real navigation, consistent with how tags behave everywhere
    // else on the site. No click-wiring needed anymore since it's a
    // plain link, not a JS-driven button.
    const tagsEl = document.getElementById("watchTags");
    const tags = Array.isArray(video.tags) ? video.tags : [];
    tagsEl.innerHTML = tags.map((t) =>
      `<a class="tag-pill" href="${categoryHref(t)}">${escapeHtml(t)}</a>`
    ).join("");

    document.getElementById("watchDescription").textContent = video.description || "";
  }

  // Sets the live view count from TurboVIPlay, fetched via the D1/
  // Worker lookup. If the worker didn't return a number (lookup
  // failed, video's URL was inline with no worker record, etc.), the
  // whole views element stays hidden rather than showing a stale/fake
  // number or an empty icon with no text next to it.
  function updateViewsDisplay(views) {
    const wrap = document.getElementById("watchViews");
    if (typeof views !== "number") { wrap.style.display = "none"; return; }
    document.getElementById("watchViewsCount").textContent = formatViews(views);
    wrap.style.display = "";
  }

  function wireLikeButton(video) {
    const btn = document.getElementById("likeBtn");
    const lib = window.StreamHubLibrary;
    if (!lib) { btn.style.display = "none"; return; }
    function refresh() {
      const liked = lib.isLiked(video.uniqueId ?? video.id);
      btn.textContent = liked ? "♥ Liked" : "♡ Like";
      btn.style.color = liked ? "var(--accent)" : "";
    }
    refresh();
    btn.addEventListener("click", () => { lib.toggleLike(video); refresh(); });
  }

  function updateHeadMeta(video) {
    const title = `${video.title || "Watch"} — StreamHub`;
    document.getElementById("pageTitle").textContent = title;
    document.title = title;
    const desc = (video.description || `Watch ${video.title || "this video"} on StreamHub.`).slice(0, 160);
    document.getElementById("pageDescription").setAttribute("content", desc);
    document.getElementById("ogTitle").setAttribute("content", title);
    document.getElementById("ogDescription").setAttribute("content", desc);
    document.getElementById("twitterTitle").setAttribute("content", title);
    document.getElementById("twitterDescription").setAttribute("content", desc);
    const thumb = video.thumbnail || video.thumb;
    if (thumb) {
      document.getElementById("ogImage").setAttribute("content", thumb);
      document.getElementById("twitterImage").setAttribute("content", thumb);
    }
    // videoHref(video) — not window.location — is the canonical source
    // of truth for this video's URL: it's the exact "/watch/<slug>"
    // path every card/link on the site points to, so the canonical tag
    // always matches regardless of how this page was actually reached
    // (clean slug, legacy ?id=, trailing slash, etc.).
    const canonicalUrl = window.location.origin + videoHref(video);
    document.getElementById("canonicalLink").setAttribute("href", canonicalUrl);
    document.getElementById("ogUrl").setAttribute("content", canonicalUrl);
  }

  /* ---------------- Related videos (+ in-page search) ---------------- */

  /* -----------------------------------------------------------
     WATCH-PAGE-ONLY related-grid ad cadence.

     The related grid here renders 4 cards per row (independent
     from GRID_COLUMNS_DESKTOP in config.js, which is 3 and is
     used only for the home page grid — untouched).

     One full cycle =
       - 3 rows of 4 cells (12 cells total): 11 real videos +
         1 video-CARD-sized ad filling the 12th (last) cell
       - followed by 1 full-width THIN ROW ad, on its own row,
         closing out the cycle — reuses config.js's existing
         adCardHtml()/pickRowAdKey() UNCHANGED, the same
         "long and thin" ad already used on the home page grid.

     RELATED_BATCH_SIZE is exactly one cycle's worth of real
     videos (11), used for both the initial render and every
     "Load More" batch, so a batch never starts or ends mid-cycle
     — that's what avoids stray/lone items in the grid.
     ----------------------------------------------------------- */
  const RELATED_GRID_COLUMNS = 4;                 // watch-page related grid: 4 cards per row
  const RELATED_CARD_ROWS_PER_CYCLE = 3;          // 3 rows of video/ad-card cells before the thin row ad
  const RELATED_VIDEOS_PER_CYCLE =
    RELATED_GRID_COLUMNS * RELATED_CARD_ROWS_PER_CYCLE - 1; // 11 — last cell of those 3 rows is the card ad
  const RELATED_CARD_AD_KEY = "banner300x250";    // closest existing ad size to a video-card footprint
  const RELATED_BATCH_SIZE = RELATED_VIDEOS_PER_CYCLE;      // one full clean cycle of real videos per batch
  let __relatedAdSeq = 0;

  function relatedCardAdHtml() {
    const uid = `reladcard-${Date.now().toString(36)}-${__relatedAdSeq++}`;
    return `
      <div class="ad-card" id="${uid}" data-ad-key="${RELATED_CARD_AD_KEY}">
        <div class="ad-label">Advertisement</div>
        <div class="ad-slot"></div>
      </div>`;
  }

  // Interleaves both ad types into the related pool. Positions are
  // counted from `startIndex` so cadence stays correct across the
  // initial render and every subsequent "Load More" batch — and since
  // every batch is exactly RELATED_VIDEOS_PER_CYCLE (11) real videos,
  // startIndex is always a multiple of that cycle, so the pattern
  // never starts mid-row.
  function relatedGridBatchHtml(videos, startIndex) {
    let html = "";
    videos.forEach((video, i) => {
      html += videoCardHtml(video);
      const position = startIndex + i + 1;
      if (position % RELATED_VIDEOS_PER_CYCLE === 0) {
        // Fills the 12th cell of the 3-row (4-col) block.
        html += relatedCardAdHtml();
        // Closes the cycle with a full-width row ad on its own row —
        // reuses config.js's existing full-width row ad, unchanged.
        html += adCardHtml(pickRowAdKey());
      }
    });
    return html;
  }

  function buildDefaultRelatedPool(video) {
    const sameAuthor = video.author ? videosByAuthorName(video.author, allVideos) : [];
    const sameAuthorIds = new Set(sameAuthor.map((v) => String(v.uniqueId ?? v.id)));
    const videoTags = new Set((video.tags || []).map((t) => String(t).toLowerCase()));

    const byTag = allVideos.filter((v) => {
      const id = String(v.uniqueId ?? v.id);
      if (id === String(video.uniqueId ?? video.id)) return false;
      if (sameAuthorIds.has(id)) return false;
      return Array.isArray(v.tags) && v.tags.some((t) => videoTags.has(String(t).toLowerCase()));
    });

    const rest = allVideos.filter((v) => {
      const id = String(v.uniqueId ?? v.id);
      return id !== String(video.uniqueId ?? video.id) && !sameAuthorIds.has(id) && !byTag.includes(v);
    });

    return [
      ...sameAuthor.filter((v) => String(v.uniqueId ?? v.id) !== String(video.uniqueId ?? video.id)),
      ...byTag,
      ...shuffleArray(rest),
    ];
  }

  // Renders related-video batches through relatedGridBatchHtml() above
  // (watch-page-only cadence: 11 videos + 1 card ad filling 3 rows of
  // 4, then a full-width thin row ad), still using wireLazyAdCards()
  // from config.js for the lazy-fill-on-scroll behavior — that helper
  // works on any ".ad-card", row-sized or card-sized, since it only
  // keys off data-ad-key.
  function renderRelatedBatch() {
    const grid = document.getElementById("relatedGrid");
    const startIndex = relatedShownCount;
    const nextBatch = relatedPool.slice(relatedShownCount, relatedShownCount + RELATED_BATCH_SIZE);
    grid.insertAdjacentHTML("beforeend", relatedGridBatchHtml(nextBatch, startIndex));
    relatedShownCount += nextBatch.length;
    wireVideoCardPreviews(grid);
    wireLazyAdCards(grid);

    const loaderWrap = document.getElementById("relatedLoaderWrap");
    loaderWrap.style.display = relatedShownCount < relatedPool.length ? "" : "none";
  }

  // Only the first RELATED_BATCH_SIZE videos (one full clean cycle)
  // render up front. Everything past that only loads when the person
  // clicks "Load More", via renderRelatedBatch() above — always in
  // further whole cycles, so the ad cadence never breaks mid-row.
  function resetRelatedGrid(pool) {
    relatedPool = pool;
    const grid = document.getElementById("relatedGrid");
    grid.innerHTML = "";
    relatedShownCount = 0;

    const initialBatch = Math.min(RELATED_BATCH_SIZE, relatedPool.length);
    const firstChunk = relatedPool.slice(0, initialBatch);
    grid.insertAdjacentHTML("beforeend", relatedGridBatchHtml(firstChunk, 0));
    relatedShownCount = firstChunk.length;

    wireVideoCardPreviews(grid);
    wireLazyAdCards(grid);
    document.getElementById("relatedLoaderWrap").style.display =
      relatedShownCount < relatedPool.length ? "" : "none";
  }

  document.getElementById("relatedLoadMoreBtn").addEventListener("click", renderRelatedBatch);

  /* In-page search: filters the related pool without leaving the page,
     so playback of the current video is never interrupted. Still used
     by the watch page's own search box (wireInPageSearch() below) —
     tags no longer call this, they navigate to /categories/<slug>
     instead (see renderInfo() above). */
  function runSearch(query) {
    const searchInput = document.getElementById("searchInput");
    searchInput.value = query;
    const heading = document.querySelector(".related-heading");
    const q = normalizeName(query);

    if (!q) {
      searchActive = false;
      heading.textContent = "Related Videos";
      resetRelatedGrid(buildDefaultRelatedPool(currentVideo));
      return;
    }

    searchActive = true;
    heading.textContent = `Search results for "${query}"`;
    const matches = allVideos.filter((v) => {
      const id = String(v.uniqueId ?? v.id);
      if (id === String(currentVideo.uniqueId ?? currentVideo.id)) return false;
      const inTitle = normalizeName(v.title).includes(q);
      const inAuthor = normalizeName(v.author).includes(q);
      const inTags = Array.isArray(v.tags) && v.tags.some((t) => normalizeName(t).includes(q));
      return inTitle || inAuthor || inTags;
    });

    if (matches.length) {
      resetRelatedGrid(matches);
    } else {
      // Never dead-end a search — fall back to a random pool instead.
      heading.textContent = `No matches for "${query}" — more videos`;
      resetRelatedGrid(shuffleArray(allVideos.filter((v) =>
        String(v.uniqueId ?? v.id) !== String(currentVideo.uniqueId ?? currentVideo.id)
      )));
    }
  }

  function wireInPageSearch() {
    const input = document.getElementById("searchInput");
    let debounceTimer;
    input.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => runSearch(input.value.trim()), 300);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); clearTimeout(debounceTimer); runSearch(input.value.trim()); }
    });
  }

  /* ---------------- Boot ---------------- */

  // Matches the /watch/<slug> path back to a video.
  //   1. Preferred: compare against slugifyName(video.title) — the
  //      exact same function videoHref() used to BUILD the link, so a
  //      slug generated by config.js always matches back here.
  //   2. Legacy fallback: old links used ?id=<uniqueId>/<id> — if the
  //      slug from the URL doesn't match any title, try it as a raw
  //      uniqueId/id instead, so bookmarks from before this change
  //      keep working.
  function resolveVideoFromSlug(rawSlug) {
    if (!rawSlug) return null;
    const bySlug = allVideos.find((v) => slugifyName(v.title) === rawSlug);
    if (bySlug) return bySlug;
    return allVideos.find((v) => String(v.uniqueId ?? v.id) === String(rawSlug)) || null;
  }

  async function init() {
    const slug = currentVideoSlugFromUrl();
    if (!slug) {
      showNotFound();
      return;
    }

    try {
      allVideos = await fetchAllVideos();
    } catch (err) {
      console.error("[watch] fetchAllVideos failed:", err);
      showNotFound();
      return;
    }

    currentVideo = resolveVideoFromSlug(slug);
    if (!currentVideo) {
      showNotFound();
      return;
    }

    document.getElementById("watchContent").style.display = "";
    updateHeadMeta(currentVideo);
    renderInfo(currentVideo);

    const apiData = await resolveVideoApiData(currentVideo);
    renderPlayer(currentVideo, apiData);
    updateViewsDisplay(apiData.views);

    wireLikeButton(currentVideo);
    if (window.StreamHubLibrary) window.StreamHubLibrary.addToHistory(currentVideo);
    resetRelatedGrid(buildDefaultRelatedPool(currentVideo));
    wireInPageSearch();
  }

  function showNotFound() {
    document.getElementById("notFoundBanner").style.display = "";
    document.getElementById("watchContent").style.display = "none";
    document.querySelector(".related-section").style.display = "none";
    document.title = "Video not found — StreamHub";
  }

  document.addEventListener("DOMContentLoaded", init);
})();
