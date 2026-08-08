/* =========================================================
   script.js — Home page (index.html) grid, search, filters
   Depends on config.js (fetchAllVideos, videoHref, normalizeName,
   categoryHref, dedupeTagCounts, sortTagsAlphaNumericLast,
   buildCappedBrowseTags, PLACEHOLDER_IMAGE, INITIAL_LOAD_COUNT,
   LOAD_MORE_COUNT, MAX_VIDEOS_DISPLAYED, etc.)

   TAGS NOW NAVIGATE TO /categories/<slug> (this revision):
   Tag pills in the sidebar used to be JS-driven <button> elements
   that filtered the CURRENT page in place (state.tag). They're now
   plain <a href="/categories/<slug>"> links to the new /categories
   hub — a real browser navigation, not client-side routing. This
   removes state.tag and its filtering logic entirely: nothing on
   this page reads or sets it anymore. dedupeTagCounts(),
   sortTagsAlphaNumericLast(), and buildCappedBrowseTags() moved to
   config.js so this page and the /categories hub share one copy
   instead of two copies that could drift apart.

   CLEAN /search/<query> URLS (earlier revision, unchanged):
   Search results live at a clean path — /search/<query> — backed by
   a Cloudflare Pages rewrite rule (see /_redirects: "/search/:query
   /index.html  200", same pattern as /models/:slug and
   /categories/:slug). Since that rule rewrites (not redirects), the
   browser's address bar keeps showing /search/<query> while Pages
   actually serves this same index.html underneath.
     - encodeSearchQuery()/decodeSearchQuery() are the read/write
       pair for that path segment. encodeSearchQuery() must stay in
       sync with the copy in search-ai.js.
     - init() reads the query from window.location.pathname first
       (the /search/<query> case), falling back to the old ?q= param.
     - wireSearch()'s commitSearch() calls updateUrlForQuery() after
       committing, so pressing Enter or clicking the search icon
       pushes the URL to /search/<query> (or back to /index.html).
     - A popstate listener re-syncs state.query from the URL on
       browser Back/Forward.

   MORE VIDEOS SECTION (earlier revision, unchanged):
   Whenever the user has actually typed a search and hit Enter
   (state.query is set), the "More Videos" section always appears
   below the search results — even when there ARE matches — as a
   normal continuation to keep browsing. It's built from allVideos
   minus whatever's already shown in the results grid. The original
   dead-end behavior (any filter — search, category, length — coming
   back with 0 results) is unchanged.

   TAG CLOUD FIX (earlier revision, unchanged):
   With 900+ raw tags, hitting "+N more" used to dump the entire
   remainder into the page. Now:
     1. Tags are DEDUPED by normalized form before anything renders.
     2. The BROWSE view (collapsed + "show more") is hard-capped at
        TAG_CLOUD_MAX_VISIBLE unique tags total, not the full set.
     3. The SEARCH box still matches against every raw tag from the
        JSON (uncapped, undeduped) — so nothing is ever unreachable.
   ========================================================= */

(function () {
  "use strict";

  let allVideos = [];
  let filtered = [];       // current working set after search/filters/sort
  let shownCount = 0;
  let scrollObserver = null; // re-armed on each rerender(); disconnected once the 33-cap or end-of-list is hit

  const state = {
    query: "",
    category: null,
    quick: null,      // "recent" | "popular" | "trending" | "random"
    length: null,     // "short" | "long"
    sort: "random",
  };

  /* ---------------- clean /search/<query> URL helpers ----------------
     encodeSearchQuery() must match the copy in search-ai.js exactly —
     that file builds the URL when you search from any page on the
     site; this file only needs to read it back out again on the
     homepage. decodeSearchQuery() is the exact inverse. */
  function encodeSearchQuery(q) {
    return encodeURIComponent(q).replace(/%20/g, "+");
  }
  function decodeSearchQuery(str) {
    return decodeURIComponent(str.replace(/\+/g, "%20"));
  }

  // Pulls the current search query out of the URL, preferring the
  // clean /search/<query> path and falling back to the legacy
  // ?q=<query> param for any old links still floating around.
  function readQueryFromUrl() {
    const pathMatch = window.location.pathname.match(/\/search\/([^/]+)\/?$/);
    if (pathMatch) return decodeSearchQuery(pathMatch[1]);
    const qParam = new URLSearchParams(window.location.search).get("q");
    return qParam || "";
  }

  // Pushes the address bar to /search/<query> (or back to /index.html
  // when the query is cleared) WITHOUT reloading the page — used when
  // the user searches from right here on the homepage, so the URL
  // stays honest even though rerender() never navigates anywhere.
  function updateUrlForQuery(query) {
    const newPath = query ? `/search/${encodeSearchQuery(query)}` : "/index.html";
    if (window.location.pathname === newPath) return;
    history.pushState({ q: query }, "", newPath);
  }

  function durationToSeconds(d) {
    if (typeof d === "number") return d;
    if (!d) return 0;
    const parts = String(d).split(":").map(Number);
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }

  /* ---------------- Filtering / sorting ---------------- */
  function applyFilters() {
    let list = allVideos.slice();

    if (state.query) {
      const q = normalizeName(state.query);
      list = list.filter((v) => {
        const inTitle = normalizeName(v.title).includes(q);
        const inAuthor = normalizeName(v.author).includes(q);
        const inTags = Array.isArray(v.tags) && v.tags.some((t) => normalizeName(t).includes(q));
        return inTitle || inAuthor || inTags;
      });
    }

    if (state.category) {
      list = list.filter((v) => normalizeName(v.category) === normalizeName(state.category));
    }

    if (state.length === "short") list = list.filter((v) => durationToSeconds(v.duration) < 20 * 60);
    if (state.length === "long") list = list.filter((v) => durationToSeconds(v.duration) >= 20 * 60);

    if (state.quick === "popular" || state.quick === "trending") {
      list = list.slice().sort((a, b) => (b.views || 0) - (a.views || 0));
    } else if (state.quick === "recent") {
      list = list.slice().sort((a, b) => new Date(b.uploadDate || b.date || 0) - new Date(a.uploadDate || a.date || 0));
    } else if (state.quick === "random") {
      list = shuffleArray(list);
    } else {
      switch (state.sort) {
        case "newest": list = list.slice().sort((a, b) => new Date(b.uploadDate || b.date || 0) - new Date(a.uploadDate || a.date || 0)); break;
        case "oldest": list = list.slice().sort((a, b) => new Date(a.uploadDate || a.date || 0) - new Date(b.uploadDate || b.date || 0)); break;
        case "views": list = list.slice().sort((a, b) => (b.views || 0) - (a.views || 0)); break;
        case "alpha": list = list.slice().sort((a, b) => (a.title || "").localeCompare(b.title || "")); break;
        default: list = shuffleArray(list);
      }
    }

    return list;
  }

  function updateTitle() {
    const titleEl = document.getElementById("gridTitle");
    if (state.query) titleEl.textContent = `Search results for "${state.query}"`;
    else if (state.category) titleEl.textContent = state.category;
    else if (state.quick === "recent") titleEl.textContent = "Recently Added";
    else if (state.quick === "popular" || state.quick === "trending") titleEl.textContent = "Most Viewed";
    else titleEl.textContent = "All Videos";
  }

  function renderSkeletonBatch(count) {
    const grid = document.getElementById("videoGrid");
    grid.insertAdjacentHTML("beforeend", Array.from({ length: count }, skeletonCardHtml).join(""));
  }

  function skeletonCardHtml() {
    return `<div class="video-card skeleton-card" aria-hidden="true">
      <div class="video-thumb-wrap skeleton-shimmer"></div>
      <div class="video-card-info">
        <div class="skeleton-line skeleton-shimmer" style="width:85%;"></div>
        <div class="skeleton-line skeleton-shimmer" style="width:45%;"></div>
      </div>
    </div>`;
  }

  // Caps the home grid at MAX_VIDEOS_DISPLAYED total. Once that many
  // cards have been placed, no further batches render — the loader
  // hides itself and wireInfiniteScroll() stops re-arming the observer.
  function renderBatch() {
    const grid = document.getElementById("videoGrid");
    const startIndex = shownCount; // cards already placed before this batch
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

  /* -----------------------------------------------------------
     "More Videos" section below the main grid. Two reasons it shows:

       1. DEAD-END (any filter combo — search, category, length —
          comes back with 0 results): shows a random batch from the
          whole catalog instead of leaving the page blank.

       2. ACTIVE SEARCH WITH RESULTS (state.query is set and filtered
          isn't empty): also shows a batch here, drawn from allVideos
          minus whatever's already in the results grid, as a normal
          "keep browsing" continuation under the search results.

     Any other browsing mode (category, quick filter, plain "All
     Videos") with actual results hides the section, same as before.
     ----------------------------------------------------------- */
  function renderMoreVideosFallback() {
    const section = document.getElementById("moreVideosSection");
    const grid = document.getElementById("moreVideosGrid");

    const isDeadEnd = filtered.length === 0;
    const isSearchWithResults = !!state.query && filtered.length > 0;

    if (!isDeadEnd && !isSearchWithResults) {
      section.style.display = "none";
      grid.innerHTML = "";
      return;
    }

    section.style.display = "";

    let pool;
    if (isDeadEnd) {
      // Nothing matched at all — pull from the whole catalog so the
      // section never comes up empty.
      pool = shuffleArray(allVideos);
    } else {
      // Results exist — exclude them so "More Videos" doesn't just
      // repeat what's already shown above it.
      const shownIds = new Set(filtered.map((v) => String(v.uniqueId ?? v.id)));
      pool = shuffleArray(allVideos.filter((v) => !shownIds.has(String(v.uniqueId ?? v.id))));
    }

    const batch = pool.slice(0, MORE_VIDEOS_INITIAL_COUNT || 18);
    grid.innerHTML = videoGridBatchHtml(batch, 0);
    wireVideoCardPreviews(grid);
    wireLazyAdCards(grid);
  }

  // (Re)wires the scroll-triggered loader. Disconnects any previous
  // observer first (safe to call on every rerender), and skips
  // creating a new one at all once the 33-video cap or the end of the
  // filtered list has been reached — this is what actually enforces
  // "no more than 33 videos, ever" on scroll.
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

  function rerender() {
    filtered = applyFilters();
    shownCount = 0;
    document.getElementById("videoGrid").innerHTML = "";
    updateTitle();
    renderBatch();
    renderMoreVideosFallback();
    wireInfiniteScroll(); // re-arm (or correctly skip) for the new filtered set
  }

  /* ---------------- Sidebar: categories ---------------- */
  function renderCategoryFilters() {
    const wrap = document.getElementById("categoryFilters");
    const categories = [...new Set(allVideos.map((v) => v.category).filter(Boolean))].sort();
    wrap.innerHTML = categories.map((c) =>
      `<button class="filter-btn" data-category="${escapeHtml(c)}">${escapeHtml(c)}</button>`
    ).join("");
    wrap.querySelectorAll("[data-category]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const isActive = btn.classList.contains("active");
        wrap.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
        state.category = isActive ? null : btn.dataset.category;
        if (!isActive) btn.classList.add("active");
        state.quick = null;
        rerender();
      });
    });
  }

  /* ---------------- Sidebar: tags ----------------
     900+ raw tags in the data. Tag pills are plain links to the
     /categories hub (see categoryHref() in config.js) — clicking one
     navigates away rather than filtering this page, so there's no
     click-wiring here at all beyond the "+N more" expand/collapse
     toggle, which is purely a display concern.
  --------------------------------------------------- */
  const TAG_CLOUD_COLLAPSED_COUNT = 24;  // shown before "+N more" is clicked
  const TAG_SEARCH_RESULTS_CAP = 160;    // safety cap on rendered search matches (typing narrows this fast anyway)

  function renderTagCloud() {
    const wrap = document.getElementById("tagCloud");
    const searchInput = document.getElementById("tagSearchInput");

    // Raw, un-deduped counts — this is what the SEARCH box matches
    // against, so every one of the 900+ original tags stays findable
    // even though the browse view below only shows a deduped subset.
    const rawTagCounts = {};
    allVideos.forEach((v) => (v.tags || []).forEach((t) => { rawTagCounts[t] = (rawTagCounts[t] || 0) + 1; }));
    const allRawTagNames = Object.keys(rawTagCounts);

    // Deduped, capped set (config.js) — this is what the BROWSE view
    // (collapsed + "show more") actually renders. Guaranteed to be
    // <= TAG_CLOUD_MAX_VISIBLE.
    const { visible: browseTags, totalUniqueAfterDedupe } = buildCappedBrowseTags(rawTagCounts);
    const hiddenBeyondCap = totalUniqueAfterDedupe - browseTags.length; // tags that exist but aren't in the browse view at all

    function pillHtml(t) {
      return `<a class="tag-pill" href="${categoryHref(t)}">${escapeHtml(t)}</a>`;
    }

    // Default (no search query) view: collapsed to
    // TAG_CLOUD_COLLAPSED_COUNT, with a "+N more" toggle that reveals
    // the rest of the DEDUPED, CAPPED set only — never the full 900+.
    // If there are tags beyond the cap, a small hint points people at
    // the search box instead of dumping everything on screen.
    function renderCollapsedView() {
      const visibleTags = browseTags.slice(0, TAG_CLOUD_COLLAPSED_COUNT);
      const restTags = browseTags.slice(TAG_CLOUD_COLLAPSED_COUNT);
      const hiddenCount = restTags.length;

      const hintHtml = hiddenBeyondCap > 0
        ? `<span class="tag-cloud-hint">+${hiddenBeyondCap} more — search above</span>`
        : "";

      wrap.innerHTML =
        visibleTags.map(pillHtml).join("") +
        (hiddenCount > 0
          ? `<span class="tag-cloud-rest" hidden>${restTags.map(pillHtml).join("")}</span>
             <button type="button" class="tag-pill tag-cloud-toggle" data-toggle-tags>+${hiddenCount} more</button>`
          : "") +
        hintHtml;

      const toggleBtn = wrap.querySelector("[data-toggle-tags]");
      if (toggleBtn) {
        toggleBtn.addEventListener("click", () => {
          const restEl = wrap.querySelector(".tag-cloud-rest");
          const expanding = restEl.hasAttribute("hidden");
          if (expanding) {
            restEl.removeAttribute("hidden");
            toggleBtn.textContent = "Show less";
          } else {
            restEl.setAttribute("hidden", "");
            toggleBtn.textContent = `+${hiddenCount} more`;
          }
        });
      }
    }

    // Search-active view: matches against the FULL raw tag list (all
    // 900+, undeduped) so nothing is ever unreachable — just capped
    // at TAG_SEARCH_RESULTS_CAP rendered results as a sanity limit,
    // since a broad query could otherwise still return hundreds.
    function renderSearchResults(query) {
      const q = normalizeName(query);
      const matches = sortTagsAlphaNumericLast(
        allRawTagNames.filter((t) => normalizeName(t).includes(q))
      );
      if (!matches.length) {
        wrap.innerHTML = `<span class="tag-cloud-empty">No tags match "${escapeHtml(query)}"</span>`;
        return;
      }
      const shown = matches.slice(0, TAG_SEARCH_RESULTS_CAP);
      const overflow = matches.length - shown.length;
      wrap.innerHTML = shown.map(pillHtml).join("") +
        (overflow > 0 ? `<span class="tag-cloud-hint">+${overflow} more — refine your search</span>` : "");
    }

    renderCollapsedView();

    if (searchInput) {
      searchInput.value = "";
      let debounceTimer;
      searchInput.addEventListener("input", () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const q = searchInput.value.trim();
          if (!q) renderCollapsedView();
          else renderSearchResults(q);
        }, 200);
      });
    }
  }

  /* ---------------- Wiring ---------------- */
  function wireQuickFilters() {
    document.querySelectorAll(".sidebar-section [data-quick]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const isActive = btn.classList.contains("active");
        document.querySelectorAll("[data-quick]").forEach((b) => b.classList.remove("active"));
        state.quick = isActive ? null : btn.dataset.quick;
        if (!isActive) btn.classList.add("active");
        rerender();
      });
    });
  }

  function wireLengthFilters() {
    document.querySelectorAll("[data-length]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const isActive = btn.classList.contains("active");
        document.querySelectorAll("[data-length]").forEach((b) => b.classList.remove("active"));
        state.length = isActive ? null : btn.dataset.length;
        if (!isActive) btn.classList.add("active");
        rerender();
      });
    });
  }

  function wireSort() {
    document.getElementById("sortSelect").addEventListener("change", (e) => {
      state.sort = e.target.value;
      state.quick = null;
      document.querySelectorAll("[data-quick]").forEach((b) => b.classList.remove("active"));
      rerender();
    });
  }

  // Typing no longer live-filters the grid. The grid only updates
  // when the user commits the search — either by pressing Enter or
  // by clicking the search icon button. Committing ALSO pushes the
  // address bar to /search/<query> (or back to /index.html when
  // cleared) via updateUrlForQuery(), so the URL always reflects
  // what's on screen even though this never triggers a full page
  // navigation.
  function wireSearch() {
    const input = document.getElementById("searchInput");
    const submitBtn = document.getElementById("searchSubmitBtn");

    function commitSearch() {
      const value = input.value.trim();
      if (value === state.query) return; // no-op if nothing changed
      state.query = value;
      updateUrlForQuery(value);
      rerender();
    }

    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      commitSearch();
    });

    if (submitBtn) {
      submitBtn.addEventListener("click", (e) => {
        e.preventDefault();
        commitSearch();
      });
    }

    // Optional but recommended: if the user clears the box entirely
    // and blurs, treat that as "clear search" so old results don't
    // stick around silently. Remove this block if you don't want it.
    input.addEventListener("blur", () => {
      if (input.value.trim() === "" && state.query !== "") {
        state.query = "";
        updateUrlForQuery("");
        rerender();
      }
    });

    // Browser Back/Forward: re-sync state + the input box from
    // whatever URL we've landed back on (either /search/<query> or a
    // plain page with no query at all) and re-render to match.
    window.addEventListener("popstate", () => {
      const q = readQueryFromUrl();
      input.value = q;
      state.query = q;
      rerender();
    });
  }

  function wireBackToTop() {
    const btn = document.getElementById("backToTopBtn");
    if (!btn) return;
    let ticking = false;
    window.addEventListener("scroll", () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        btn.classList.toggle("show", window.scrollY > 900);
        ticking = false;
      });
    }, { passive: true });
    btn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  function wireMobileSidebar() {
    const sidebar = document.getElementById("sidebar");
    const overlay = document.getElementById("sidebarOverlay");
    document.getElementById("hamburgerBtn").addEventListener("click", () => {
      sidebar.classList.add("open");
      overlay.classList.add("show");
    });
    document.getElementById("sidebarClose").addEventListener("click", closeSidebar);
    overlay.addEventListener("click", closeSidebar);
    function closeSidebar() {
      sidebar.classList.remove("open");
      overlay.classList.remove("show");
    }
  }

  /* ---------------- Boot ---------------- */
  async function init() {
    // Skeleton placeholders paint immediately (no network wait) so the
    // grid never shows a blank page while content loads — matters a
    // lot at scale on slower connections/devices.
    renderSkeletonBatch(Math.min(INITIAL_LOAD_COUNT, MAX_VIDEOS_DISPLAYED));

    try {
      allVideos = await fetchAllVideos();
    } catch (err) {
      console.error("[script] fetchAllVideos failed:", err);
      document.getElementById("videoGrid").innerHTML = "";
      const titleEl = document.getElementById("gridTitle");
      if (titleEl) titleEl.textContent = "Couldn't load videos — check console.";
      return;
    }
    renderCategoryFilters();
    renderTagCloud();
    wireQuickFilters();
    wireLengthFilters();
    wireSort();
    wireSearch();
    wireMobileSidebar();
    wireBackToTop();

    // Prefer the clean /search/<query> path; falls back to the old
    // ?q= param automatically (see readQueryFromUrl()).
    const q = readQueryFromUrl();
    if (q) {
      document.getElementById("searchInput").value = q;
      state.query = q;
    }

    rerender();
  }

  document.addEventListener("DOMContentLoaded", init);
})();