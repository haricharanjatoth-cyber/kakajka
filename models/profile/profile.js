(function () {
  "use strict";

  let allVideos = [];
  let currentAuthor = null;  // { name, profilePhoto (nullable), country (nullable) }
  let authorVideos = [];     // ALL of this author's videos, unfiltered
  let displayedAuthorVideos = []; // authorVideos, filtered by activeTag if any
  let moreVideos = [];
  let activeTag = null;
  let ptagsMinimized = false; // tags-box minimize state, survives re-renders

  let authorShownRef = { count: 0 };
  let moreShownRef = { count: 0 };

  const COUNTRY_NAME_TO_CODE = {
    "united states": "us",
    "india": "in",
    "united kingdom": "gb",
    "canada": "ca",
    "australia": "au",
    "germany": "de",
    "france": "fr",
    "brazil": "br",
    "russia": "ru",
    "japan": "jp",
    "spain": "es",
    "italy": "it",
    "mexico": "mx",
    "netherlands": "nl",
    "philippines": "ph",
  };

  function resolveCountryCode(countryName) {
    if (!countryName) return null;
    const key = String(countryName).trim().toLowerCase();
    if (typeof window.getCountryCode === "function") {
      const fromHelper = window.getCountryCode(countryName);
      if (fromHelper) return String(fromHelper).toLowerCase();
    }
    if (window.COUNTRY_NAME_TO_CODE && window.COUNTRY_NAME_TO_CODE[key]) {
      return window.COUNTRY_NAME_TO_CODE[key];
    }
    return COUNTRY_NAME_TO_CODE[key] || null;
  }

  function flagUrlForCountry(countryName) {
    const code = resolveCountryCode(countryName);
    return code ? `https://flagcdn.com/24x18/${code}.png` : null;
  }

  /* -----------------------------------------------------------
     PROFILE-PAGE GRID AD CADENCE — same building blocks as
     watch.js's related-grid cadence (adCardHtml/pickRowAdKey from
     config.js, one card ad + one row ad per cycle), tuned to this
     page's 3-column .video-grid (same column count the home page
     grid uses) instead of watch.js's 4-column related grid.

     One cycle = 2 rows of 4 cells (8 cells): 7 real videos + 1
     video-card-sized ad filling the 8th (last) cell, then a
     full-width thin row ad on its own row closing the cycle.
     PROFILE_VIDEOS_PER_CYCLE (7) is used as the batch size for both
     the initial render and every Load More click, so a batch never
     starts or ends mid-cycle.
     ----------------------------------------------------------- */
  const PROFILE_GRID_COLUMNS = 4;
  const PROFILE_CARD_ROWS_PER_CYCLE = 2;
  const PROFILE_VIDEOS_PER_CYCLE =
    PROFILE_GRID_COLUMNS * PROFILE_CARD_ROWS_PER_CYCLE - 1; // 7
  const PROFILE_CARD_AD_KEY = "banner300x250";
  let __profileAdSeq = 0;

  function profileCardAdHtml() {
    const uid = `pradcard-${Date.now().toString(36)}-${__profileAdSeq++}`;
    return `
      <div class="ad-card" id="${uid}" data-ad-key="${PROFILE_CARD_AD_KEY}">
        <div class="ad-label">Advertisement</div>
        <div class="ad-slot"></div>
      </div>`;
  }

  // Interleaves both ad types into a batch of videos, counting
  // position from startIndex so cadence stays correct across the
  // initial render and every Load More batch.
  function profileGridBatchHtml(videos, startIndex) {
    let html = "";
    videos.forEach((video, i) => {
      html += videoCardHtml(video);
      const position = startIndex + i + 1;
      if (position % PROFILE_VIDEOS_PER_CYCLE === 0) {
        html += profileCardAdHtml();
        html += adCardHtml(pickRowAdKey());
      }
    });
    return html;
  }

  // Renders one batch (PROFILE_VIDEOS_PER_CYCLE videos worth) into
  // gridId using the cadence above, wiring hover previews and lazy ad
  // fill exactly like watch.js's renderRelatedBatch() does.
  function renderChunk(pool, shownRef, gridId, loaderWrapId, chunkSize) {
    const grid = document.getElementById(gridId);
    const next = pool.slice(shownRef.count, shownRef.count + chunkSize);
    grid.insertAdjacentHTML("beforeend", profileGridBatchHtml(next, shownRef.count));
    shownRef.count += next.length;
    wireVideoCardPreviews(grid);
    wireLazyAdCards(grid);
    document.getElementById(loaderWrapId).style.display = shownRef.count < pool.length ? "" : "none";
  }

  // The slug is the primary key used both to query the models table
  // and (as a fallback) to match against video authors, so it's
  // always read straight from the URL/path with no normalization
  // beyond decodeURIComponent — normalizeName()/slugifyName() are
  // applied later, at the point each comparison actually needs them.
  function currentAuthorSlugFromUrl() {
    const fromQuery = new URLSearchParams(window.location.search).get("name");
    if (fromQuery) return slugifyName(fromQuery);
    const match = window.location.pathname.match(
      new RegExp(`/${MODELS_FOLDER}/([^/]+?)(?:\\.html)?/?$`)
    );
    return match ? decodeURIComponent(match[1]) : null;
  }

  /* -----------------------------------------------------------
     Fetches exactly the four columns the models table has:
     slug, name, profile_link, country. No other fields are read or
     assumed — if a column is null/missing in the row, the caller is
     responsible for leaving that part of the UI blank (or falling
     back, for the avatar) rather than substituting a placeholder.
     ----------------------------------------------------------- */
  async function fetchModelFromApi(slug) {
    try {
      const res = await fetch(`${PROFILE_API_URL}/models/${encodeURIComponent(slug)}`);
      if (!res.ok) return null; // includes a plain 404 for "no row" — not an error, just absent
      const data = await res.json().catch(() => null);
      const row = data && data.model ? data.model : null;
      if (!row || !row.name) return null;
      return {
        slug: row.slug || slug,
        name: row.name,
        profileLink: row.profile_link || null,
        country: row.country || null,
      };
    } catch (err) {
      console.error("[profile] fetchModelFromApi failed:", err);
      return null;
    }
  }

  // Finds the author's real display name by looking at how their
  // videos actually spell it, matching the URL slug against each
  // video's author name (both sides run through normalizeName, which
  // strips case/accents/punctuation/hyphens so slug vs. spaced-name
  // differences don't matter). Used only when there's no models row.
  function findAuthorNameFromVideos(slug) {
    const key = normalizeName(slug);
    if (!key) return null;
    const match = allVideos.find((v) => v.author && normalizeName(v.author) === key);
    return match ? match.author : null;
  }

  async function init() {
    const slug = currentAuthorSlugFromUrl();
    if (!slug) { showNotFound(); return; }

    try {
      allVideos = await fetchAllVideos();
    } catch (err) {
      console.error("[profile] failed to load video pool:", err);
      allVideos = [];
    }

    // 1. Look up curated details in the models table first — this is
    //    the authoritative source for name/avatar/country.
    const modelRow = await fetchModelFromApi(slug);

    // 2. No row? Fall back to whatever name their videos use, so the
    //    page still works for authors that don't have a models entry
    //    yet — just without curated details.
    const resolvedName = modelRow ? modelRow.name : findAuthorNameFromVideos(slug);

    // 3. Truly nothing to show (no models row AND no matching video) —
    //    only now is this a real "not found".
    if (!resolvedName) { showNotFound(); return; }

    // Avatar: prefer the curated models.profile_link. If there's no
    // models row at all, or the row exists but has no profile_link,
    // fall back to the hand-uploaded authors-iu6.pages.dev bucket
    // (same source + slug logic the video cards already use).
    const fallbackAvatarUrl = typeof authorImageUrl === "function" ? authorImageUrl(resolvedName) : null;
    const avatarUrl = (modelRow && modelRow.profileLink) ? modelRow.profileLink : fallbackAvatarUrl;

    currentAuthor = {
      name: resolvedName,
      profilePhoto: avatarUrl, // may still be null if authorImageUrl() couldn't build one
      country: modelRow ? modelRow.country : null,
    };

    authorVideos = videosByAuthorName(currentAuthor.name, allVideos);
    const authorIds = new Set(authorVideos.map((v) => String(v.uniqueId ?? v.id)));
    moreVideos = shuffleArray(allVideos.filter((v) => !authorIds.has(String(v.uniqueId ?? v.id))));

    renderProfile();
  }

  // Unique tags across all of this author's videos, alphabetical.
  function getAuthorTags() {
    const set = new Set();
    authorVideos.forEach((v) => (v.tags || []).forEach((t) => set.add(t)));
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  /* -----------------------------------------------------------
     TAGS ROW — single flex-wrapped box, capped at 3 rows by CSS
     max-height (see .ptags-wrap in profile.html's <style>). Two
     independent toggles sit above it:

       - Minimize: collapses the box down to just the first row
         (max-height: 1 row) without touching the DOM, so active-tag
         state and scroll position are never disturbed.
       - Filter: reveals a search input that live-filters the pill
         list and temporarily lifts the row cap entirely while a
         query is active, so a filtered match is never hidden behind
         the 3-row clip. The prior minimize state is restored once
         the query is cleared.

     Both toggles' states live in outer scope (ptagsMinimized) or are
     re-derived from the DOM (filter open/closed), so the whole thing
     stays correct across the repeated renderTagsRow() calls that
     happen on every tag click.
     ----------------------------------------------------------- */
  function renderTagsRow() {
    const wrap = document.getElementById("profileTagsRow");
    const tags = getAuthorTags();

    if (!tags.length) {
      wrap.style.display = "none";
      wrap.innerHTML = "";
      return;
    }

    wrap.style.display = "";
    wrap.innerHTML = `
      <div class="ptags-box">
        <div class="ptags-header">
          <button type="button" class="ptags-filter-btn" id="ptagsFilterBtn" aria-label="Filter tags">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
            </svg>
            Filter
          </button>
          <button type="button" class="ptags-minimize-btn" id="ptagsMinimizeBtn" aria-expanded="true">
            <svg class="ptags-minimize-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="18 15 12 9 6 15"/>
            </svg>
            <span id="ptagsMinimizeLabel">Minimize</span>
          </button>
        </div>
        <div class="ptags-filter-row" id="ptagsFilterRow" hidden>
          <input type="search" id="ptagsFilterInput" class="ptags-filter-input" placeholder="Filter this author's tags…">
        </div>
        <div class="ptags-wrap" id="ptagsWrap"></div>
      </div>`;

    function pillHtml(t) {
      const active = activeTag === t ? " active" : "";
      return `<button type="button" class="ptag-pill${active}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`;
    }

    const wrapEl = document.getElementById("ptagsWrap");

    function renderPills(list) {
      wrapEl.innerHTML = list.length
        ? list.map(pillHtml).join("")
        : `<span class="ptags-empty">No tags match</span>`;
      wrapEl.querySelectorAll("[data-tag]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const wasActive = activeTag === btn.dataset.tag;
          activeTag = wasActive ? null : btn.dataset.tag;
          renderTagsRow();          // rebuild so active state is consistent everywhere
          renderAuthorVideoSection();
        });
      });
    }

    renderPills(tags);
    wrapEl.classList.toggle("ptags-minimized", ptagsMinimized);

    // ---- Minimize toggle: collapse to just the first row ----
    const minimizeBtn = document.getElementById("ptagsMinimizeBtn");
    const minimizeLabel = document.getElementById("ptagsMinimizeLabel");
    function syncMinimizeUi() {
      minimizeBtn.classList.toggle("is-minimized", ptagsMinimized);
      minimizeBtn.setAttribute("aria-expanded", String(!ptagsMinimized));
      minimizeLabel.textContent = ptagsMinimized ? "Show tags" : "Minimize";
    }
    syncMinimizeUi();
    minimizeBtn.addEventListener("click", () => {
      ptagsMinimized = !ptagsMinimized;
      wrapEl.classList.toggle("ptags-minimized", ptagsMinimized);
      syncMinimizeUi();
    });

    // ---- Filter toggle: reveal search box, lift the row cap while
    // a query is active so no filtered match is ever clipped ----
    const filterBtn = document.getElementById("ptagsFilterBtn");
    const filterRow = document.getElementById("ptagsFilterRow");
    const filterInput = document.getElementById("ptagsFilterInput");
    filterBtn.addEventListener("click", () => {
      const showing = filterRow.hidden;
      filterRow.hidden = !showing;
      filterBtn.classList.toggle("open", showing);
      if (showing) {
        filterInput.focus();
      } else {
        filterInput.value = "";
        wrapEl.classList.remove("ptags-unclamped");
        wrapEl.classList.toggle("ptags-minimized", ptagsMinimized);
        renderPills(tags);
      }
    });

    let debounceTimer;
    filterInput.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const q = normalizeName(filterInput.value.trim());
        const hasQuery = !!q;
        wrapEl.classList.toggle("ptags-unclamped", hasQuery);
        wrapEl.classList.toggle("ptags-minimized", !hasQuery && ptagsMinimized);
        renderPills(q ? tags.filter((t) => normalizeName(t).includes(q)) : tags);
      }, 150);
    });
  }

  // (Re)renders the author's own video grid based on activeTag, resetting
  // pagination each time the filter changes. Safe to call repeatedly —
  // clears the grid and rewires the Load More button from scratch so no
  // duplicate click handlers pile up. Resetting authorShownRef.count to 0
  // here also restarts the ad cadence cleanly from the top of the grid
  // every time the tag filter changes.
  function renderAuthorVideoSection() {
    displayedAuthorVideos = activeTag
      ? authorVideos.filter((v) => Array.isArray(v.tags) && v.tags.includes(activeTag))
      : authorVideos.slice();

    const grid = document.getElementById("authorVideoGrid");
    grid.innerHTML = "";
    authorShownRef = { count: 0 };

    const initial = Math.min(AUTHOR_VIDEOS_INITIAL_COUNT, displayedAuthorVideos.length);
    while (authorShownRef.count < initial) {
      renderChunk(displayedAuthorVideos, authorShownRef, "authorVideoGrid", "authorLoaderWrap", AUTHOR_VIDEOS_LOAD_MORE_COUNT);
    }

    const loadMoreBtn = document.getElementById("authorLoadMoreBtn");
    loadMoreBtn.onclick = () =>
      renderChunk(displayedAuthorVideos, authorShownRef, "authorVideoGrid", "authorLoaderWrap", AUTHOR_VIDEOS_LOAD_MORE_COUNT);

    document.getElementById("profileVideoCount").textContent =
      `${displayedAuthorVideos.length} video${displayedAuthorVideos.length === 1 ? "" : "s"}` +
      (activeTag ? ` — tag: ${activeTag}` : "");
  }

  function renderProfile() {
    document.getElementById("profileContent").style.display = "";
    document.getElementById("profileVideoSections").style.display = "";

    /* Avatar: the circular frame (#profileAvatarWrap) always renders
       and always reserves its layout space, whether or not an image
       ends up loading — so the header never reflows depending on
       whether this particular author has a photo. Only the <img>
       inside it is conditionally shown: hidden outright if we have
       no URL at all, and hidden again on a load error (e.g. the
       authors-iu6.pages.dev fallback 404ing because that file hasn't
       been uploaded for this author yet). */
    const avatarEl = document.getElementById("profileAvatar");
    if (currentAuthor.profilePhoto) {
      avatarEl.src = currentAuthor.profilePhoto;
      avatarEl.alt = currentAuthor.name;
      avatarEl.style.display = "";
      avatarEl.onerror = function () {
        this.onerror = null;
        this.removeAttribute("src");
        this.style.display = "none";
      };
    } else {
      avatarEl.removeAttribute("src");
      avatarEl.alt = "";
      avatarEl.style.display = "none";
    }

    document.getElementById("profileName").textContent = currentAuthor.name;

    /* Country: only shown if the models table has a value. No
       guessing, no default. */
    const countryRow = document.getElementById("profileCountryRow");
    const flagEl = document.getElementById("profileCountryFlag");
    const countryNameEl = document.getElementById("profileCountryName");

    if (currentAuthor.country) {
      countryNameEl.textContent = currentAuthor.country;
      const flagUrl = flagUrlForCountry(currentAuthor.country);
      if (flagUrl) {
        flagEl.src = flagUrl;
        flagEl.alt = currentAuthor.country;
        flagEl.style.display = "";
        flagEl.onerror = function () { this.style.display = "none"; };
      } else {
        flagEl.style.display = "none";
      }
      countryRow.style.display = "";
    } else {
      countryRow.style.display = "none";
    }

    const title = `${currentAuthor.name} — StreamHub`;
    document.title = title;
    document.getElementById("pageTitle").textContent = title;
    document.getElementById("pageDescription").setAttribute(
      "content", `Watch all videos from ${currentAuthor.name} on StreamHub.`
    );

    renderTagsRow();
    renderAuthorVideoSection();

    moreShownRef = { count: 0 };
    const initialMore = Math.min(MORE_VIDEOS_INITIAL_COUNT, moreVideos.length);
    while (moreShownRef.count < initialMore) {
      renderChunk(moreVideos, moreShownRef, "moreVideosGrid", "moreLoaderWrap", MORE_VIDEOS_LOAD_MORE_COUNT);
    }
    document.getElementById("moreLoadMoreBtn").onclick = () =>
      renderChunk(moreVideos, moreShownRef, "moreVideosGrid", "moreLoaderWrap", MORE_VIDEOS_LOAD_MORE_COUNT);
  }

  function showNotFound() {
    document.getElementById("notFoundBanner").style.display = "";
    document.title = "Creator not found — StreamHub";
  }

  function wireHeaderSearch() {
    const input = document.getElementById("searchInput");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) {
        window.location.href = `../index.html?q=${encodeURIComponent(input.value.trim())}`;
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    wireHeaderSearch();
    init();
  });
})();