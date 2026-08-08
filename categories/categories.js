/* =========================================================
   categories.js — /categories hub
   Lives at SITE ROOT (not inside /categories/) — see the IMPORTANT
   note in /_redirects: the /categories/:slug wildcard rewrite
   matches any single path segment after /categories/, including a
   filename, so a script placed inside that folder can get
   intercepted by the rewrite instead of served as JS.

   Depends on config.js (fetchAllVideos, normalizeName, escapeHtml,
   categoryHref, currentCategorySlugFromUrl, dedupeTagCounts,
   buildCappedBrowseTags, videoGridBatchHtml, wireVideoCardPreviews,
   wireLazyAdCards, shuffleArray, INITIAL_LOAD_COUNT, LOAD_MORE_COUNT,
   MAX_VIDEOS_DISPLAYED, MORE_VIDEOS_INITIAL_COUNT).

   TWO MODES, decided purely by the URL:

   1. /categories/  (or /categories/index.html) — no slug.
      Shows a landing grid of every category AND every (deduped,
      capped) tag as a clickable tile, each linking to
      /categories/<slug>. Real <a href> links — no client routing,
      so this page never needs to guess "how deep am I" the way the
      old relative-link code used to.

   2. /categories/<slug>  — Cloudflare Pages rewrites this to this
      same index.html (see /_redirects: "/categories/:slug
      /categories/  200"), so the browser's address bar keeps
      showing /categories/<slug> while this file runs underneath.
      currentCategorySlugFromUrl() (config.js) reads the slug back
      out of the path. Videos are matched against BOTH video.category
      and video.tags, normalized the same way authorHref()/
      currentAuthorKeyFromUrl() already match author slugs — so a
      slug works whether it came from a "category" pill or a "tag"
      pill; the visitor doesn't need to know which kind it was.
   ========================================================= */

(function () {
  "use strict";

  let allVideos = [];
  let filtered = [];
  let shownCount = 0;
  let scrollObserver = null;

  function skeletonCardHtml() {
    return `<div class="video-card skeleton-card" aria-hidden="true">
      <div class="video-thumb-wrap skeleton-shimmer"></div>
      <div class="video-card-info">
        <div class="skeleton-line skeleton-shimmer" style="width:85%;"></div>
        <div class="skeleton-line skeleton-shimmer" style="width:45%;"></div>
      </div>
    </div>`;
  }

  function renderSkeletonBatch(count) {
    const grid = document.getElementById("videoGrid");
    grid.insertAdjacentHTML("beforeend", Array.from({ length: count }, skeletonCardHtml).join(""));
  }

  function matchesKey(video, key) {
    if (normalizeName(video.category) === key) return true;
    return Array.isArray(video.tags) && video.tags.some((t) => normalizeName(t) === key);
  }

  // Recovers a nicely-cased display name for the slug — prefers a
  // matching category name, falls back to a matching tag's original
  // casing, falls back to the raw slug itself if nothing matches
  // (e.g. a stale/typo'd link).
  function findDisplayName(key, rawSlug) {
    for (const v of allVideos) {
      if (normalizeName(v.category) === key) return v.category;
    }
    for (const v of allVideos) {
      const hit = (v.tags || []).find((t) => normalizeName(t) === key);
      if (hit) return hit;
    }
    return rawSlug;
  }

  function renderBatch() {
    const grid = document.getElementById("videoGrid");
    const startIndex = shownCount;
    const remainingCap = MAX_VIDEOS_DISPLAYED - shownCount;

    if (remainingCap <= 0) {
      document.getElementById("loaderWrap").style.display = "none";
      return;
    }

    const batchSize = shownCount === 0 ? INITIAL_LOAD_COUNT : LOAD_MORE_COUNT;
    const next = filtered.slice(shownCount, shownCount + Math.min(batchSize, remainingCap));

    grid.insertAdjacentHTML("beforeend", videoGridBatchHtml(next, startIndex));
    shownCount += next.length;
    wireVideoCardPreviews(grid);
    wireLazyAdCards(grid);

    const doneLoading = shownCount >= filtered.length || shownCount >= MAX_VIDEOS_DISPLAYED;
    document.getElementById("loaderWrap").style.display = doneLoading ? "none" : "";
  }

  function wireInfiniteScroll() {
    if (scrollObserver) {
      scrollObserver.disconnect();
      scrollObserver = null;
    }
    if (shownCount >= filtered.length || shownCount >= MAX_VIDEOS_DISPLAYED) return;

    const sentinel = document.getElementById("scrollSentinel");
    scrollObserver = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) return;
      if (shownCount >= filtered.length || shownCount >= MAX_VIDEOS_DISPLAYED) {
        scrollObserver.disconnect();
        scrollObserver = null;
        return;
      }
      renderBatch();
      if (shownCount >= filtered.length || shownCount >= MAX_VIDEOS_DISPLAYED) {
        scrollObserver.disconnect();
        scrollObserver = null;
      }
    }, { rootMargin: "600px" });
    scrollObserver.observe(sentinel);
  }

  function showLanding() {
    document.getElementById("categoriesLanding").style.display = "";
    document.getElementById("videoGridSection").style.display = "none";
  }

  function showVideoGrid() {
    document.getElementById("categoriesLanding").style.display = "none";
    document.getElementById("videoGridSection").style.display = "";
  }

  // Tile now shows only the name — no count badge.
  function categoryTileHtml(name) {
    return `<a class="category-tile" href="${categoryHref(name)}">
      <span class="category-tile-name">${escapeHtml(name)}</span>
    </a>`;
  }

  function renderLandingGrid() {
    document.getElementById("gridTitle").textContent = "Browse Categories & Tags";
    showLanding();

    // Categories: alphabetical. (Counts are still tallied to derive
    // the category name list, but are no longer rendered on tiles.)
    const categoryCounts = {};
    allVideos.forEach((v) => {
      if (!v.category) return;
      categoryCounts[v.category] = (categoryCounts[v.category] || 0) + 1;
    });
    const categoryNames = Object.keys(categoryCounts).sort((a, b) => a.localeCompare(b));

    document.getElementById("categoriesGrid").innerHTML =
      categoryNames.map((c) => categoryTileHtml(c)).join("") ||
      `<p class="empty-state">No categories yet.</p>`;

    // Tags: dedupe near-duplicates and cap the browse view — same
    // treatment as the home page's sidebar tag cloud (config.js).
    const rawTagCounts = {};
    allVideos.forEach((v) => (v.tags || []).forEach((t) => { rawTagCounts[t] = (rawTagCounts[t] || 0) + 1; }));
    const { visible: tagNames } = buildCappedBrowseTags(rawTagCounts);

    document.getElementById("tagsGrid").innerHTML =
      tagNames.map((t) => categoryTileHtml(t)).join("") ||
      `<p class="empty-state">No tags yet.</p>`;
  }

  // Minimum result count below which the page tops itself up with
  // more videos rather than looking sparse/empty. A tag with just 1-2
  // matches (or none at all) still gets a full page of browsing
  // material below it.
  const MIN_RESULTS_BEFORE_TOPUP = MORE_VIDEOS_INITIAL_COUNT || 18;

  function renderMoreVideosTopup(alreadyShown) {
    const section = document.getElementById("moreVideosSection");
    const grid = document.getElementById("moreVideosGrid");

    if (alreadyShown.length >= MIN_RESULTS_BEFORE_TOPUP) {
      section.style.display = "none";
      grid.innerHTML = "";
      return;
    }

    section.style.display = "";
    const shownIds = new Set(alreadyShown.map((v) => String(v.uniqueId ?? v.id)));
    const pool = shuffleArray(allVideos.filter((v) => !shownIds.has(String(v.uniqueId ?? v.id))));
    const needed = MIN_RESULTS_BEFORE_TOPUP - alreadyShown.length;
    const batch = pool.slice(0, Math.max(needed, MORE_VIDEOS_INITIAL_COUNT || 18));

    grid.innerHTML = videoGridBatchHtml(batch, 0);
    wireVideoCardPreviews(grid);
    wireLazyAdCards(grid);
  }

  function renderCategoryListing(rawSlug) {
    const key = normalizeName(decodeURIComponent(rawSlug));
    const displayName = findDisplayName(key, rawSlug);

    document.getElementById("gridTitle").textContent = `Category: ${displayName}`;
    showVideoGrid();

    filtered = allVideos.filter((v) => matchesKey(v, key));
    shownCount = 0;
    const grid = document.getElementById("videoGrid");
    grid.innerHTML = "";

    if (!filtered.length) {
      grid.innerHTML = `<p class="empty-state">No videos found for "${escapeHtml(displayName)}" yet — here's more to watch instead.</p>`;
      document.getElementById("loaderWrap").style.display = "none";
      renderMoreVideosTopup([]);
      return;
    }

    renderBatch();
    wireInfiniteScroll();
    renderMoreVideosTopup(filtered);
  }

  async function init() {
    renderSkeletonBatch(Math.min(INITIAL_LOAD_COUNT, MAX_VIDEOS_DISPLAYED));

    try {
      allVideos = await fetchAllVideos();
    } catch (err) {
      console.error("[categories] fetchAllVideos failed:", err);
      document.getElementById("videoGrid").innerHTML = "";
      document.getElementById("gridTitle").textContent = "Couldn't load videos — check console.";
      return;
    }
    document.getElementById("videoGrid").innerHTML = "";

    const rawSlug = currentCategorySlugFromUrl();
    if (rawSlug) {
      renderCategoryListing(rawSlug);
    } else {
      renderLandingGrid();
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();