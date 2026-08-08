/* =========================================================
   config.js — Global site configuration
   Add your GitHub-hosted (or any static-hosted) videos.json files to
   JSON_URLS below — every page merges all of them into one video pool.
   ========================================================= */

/* =========================================================
   DAILY JSON MANIFEST
   Your data project gets a new file added every day (1day.json,
   2day.json, 3day.json, ...). We deliberately do NOT hardcode each
   day's filename here — that would mean editing + redeploying
   config.js (and therefore the whole SITE project) every single day
   just to add one line. Instead, this reads a tiny manifest.json file
   — hosted in the DATA project, right next to the day-files — that
   simply LISTS which files currently exist. Adding a new day becomes
   a change to the DATA project only; this file never needs to change
   again.

   FIX (freshness): no caching of the manifest or the merged video
   list. Every call re-discovers which content*.json files exist and
   re-fetches + re-merges + re-shuffles them, so a newly uploaded
   content3.json (or content4.json, etc.) shows up on the very next
   page load — not up to 5/15 minutes later, and not "until the tab
   closes" like the old sessionStorage cache did.

   FIX (speed): discovery no longer fires up to CONTENT_FILE_MAX (200)
   HEAD requests on every load. Browsers queue concurrent requests to
   the same host (often ~6 at a time), so 200 of them serialize into a
   long wait — that was the actual cause of the loading screen hanging
   on the logo for a long time, not the logo/loader itself.

   Instead this does an exponential-then-binary search assuming
   contiguous numbering (content1.json, content2.json, content3.json,
   ... with no gaps, which matches "a new file gets added every day"):
     1. Check content1, content2, content4, content8, ... doubling
        each time until one comes back missing.
     2. Binary-search the gap between the last hit and first miss.
   Total requests for, say, 50 files: ~12 instead of 50-200 — and it
   scales logarithmically, so even thousands of files stay fast.
   Still fully fresh (cache: "no-store" on every check, every load).
   ========================================================= */

const DATA_BASE_URL = "https://json-9xs.pages.dev/meta";

const CONTENT_FILE_PREFIX = "content";
const CONTENT_FILE_MAX = 5000; // safety ceiling for the exponential search — cheap to raise, doesn't cost extra requests unless you actually have this many files

const FALLBACK_JSON_URLS = [`${DATA_BASE_URL}/content1.json`];

async function contentFileExists(n) {
  try {
    const res = await fetch(`${DATA_BASE_URL}/${CONTENT_FILE_PREFIX}${n}.json`, {
      method: "HEAD",
      cache: "no-store",
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

async function resolveJsonUrls() {
  try {
    if (!(await contentFileExists(1))) {
      throw new Error(`${CONTENT_FILE_PREFIX}1.json not found under ${DATA_BASE_URL}`);
    }

    // Exponential search: find an upper bound that does NOT exist.
    let lastExists = 1;
    let probe = 2;
    while (probe <= CONTENT_FILE_MAX && (await contentFileExists(probe))) {
      lastExists = probe;
      probe *= 2;
    }
    const upperBoundMissing = Math.min(probe, CONTENT_FILE_MAX + 1);

    // Binary search the exact boundary between lastExists (present)
    // and upperBoundMissing (absent or past the safety ceiling).
    let lo = lastExists;
    let hi = upperBoundMissing;
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (await contentFileExists(mid)) lo = mid;
      else hi = mid;
    }

    const count = lo;
    const files = Array.from({ length: count }, (_, i) => `${CONTENT_FILE_PREFIX}${i + 1}.json`);
    return files.map((f) => `${DATA_BASE_URL}/${f}`);
  } catch (err) {
    console.warn("[data] could not discover content*.json files — using FALLBACK_JSON_URLS:", err);
    return FALLBACK_JSON_URLS;
  }
}

/* =========================================================
   MODEL / AUTHOR PROFILE JSON POOL
   ========================================================= */
const AUTHOR_JSON_URLS = [
  "https://json-9xs.pages.dev/model/authors.json"
];

// Used for MATCHING (e.g. video.author text -> author record). Strips
// every non-alphanumeric character, including hyphens, so "Abella
// Danger" and "abella-danger" both normalize to "abelladanger" and
// compare equal.
function normalizeName(str) {
  return String(str || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Used for URL GENERATION (pretty, readable slugs). Keeps word
// boundaries as single hyphens instead of collapsing them away, so
// "Abella Danger" -> "abella-danger" rather than "abelladanger".
// normalizeName() is still what's used to MATCH a slug back to an
// author record, since normalizeName also strips hyphens — so a slug
// built here and a name normalized there always agree.
function slugifyName(str) {
  return String(str || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function videosByAuthorName(name, allVideos) {
  const key = normalizeName(name);
  if (!key) return [];
  return allVideos.filter((v) => normalizeName(v.author) === key);
}

/* =========================================================
   CATEGORY / TAG LINKS + SHARED TAG DEDUPE HELPERS

   Root-absolute, same reasoning as videoHref()/authorHref(): a
   category or tag pill can appear on ANY page (home sidebar, search
   page, the categories hub itself), so its link must resolve
   correctly no matter how deep or how-rewritten the current URL is.

   dedupeTagCounts / sortTagsAlphaNumericLast / buildCappedBrowseTags
   live here (not in script.js) because BOTH the home page's sidebar
   tag cloud and the /categories hub need the exact same "merge
   near-duplicate tags, cap the browse view" logic. Keeping one copy
   here means the two pages can never quietly drift out of sync with
   each other.
   ========================================================= */
const CATEGORIES_FOLDER = "categories";
const TAG_CLOUD_MAX_VISIBLE = 160; // ABSOLUTE ceiling for any "browse all tags" view, no matter how many raw tags exist

function categoryHref(name) {
  return `/${CATEGORIES_FOLDER}/${slugifyName(name)}`;
}

// Reads the slug straight out of /categories/<slug> (root-relative,
// so it works regardless of current page). Returns the raw
// (decoded, un-normalized) slug string, or null if there isn't one —
// i.e. we're on the plain /categories/ landing page.
function currentCategorySlugFromUrl() {
  const match = window.location.pathname.match(
    new RegExp(`/${CATEGORIES_FOLDER}/([^/]+?)/?$`)
  );
  return match ? decodeURIComponent(match[1]) : null;
}

// Groups raw tags by normalized form (normalizeName strips case,
// accents, and punctuation) and merges their counts. For each group,
// keeps whichever original spelling/casing was used most often as
// the display label — the "canonical" variant a real user is most
// likely to recognize.
function dedupeTagCounts(tagCounts) {
  const groups = new Map(); // normalized key -> { display, count, displayCount }
  Object.keys(tagCounts).forEach((rawTag) => {
    const key = normalizeName(rawTag);
    if (!key) return;
    const count = tagCounts[rawTag];
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { display: rawTag, count, displayCount: count });
    } else {
      existing.count += count;
      if (count > existing.displayCount) {
        existing.display = rawTag;
        existing.displayCount = count;
      }
    }
  });
  return groups;
}

// Alphabetical (case-insensitive), but tags that START with a digit
// (e.g. "18", "2026", "4k") sort AFTER every letter-leading tag,
// instead of before them the way a plain string sort would put them
// (since "1" < "A" in character code order). Within each group,
// still plain alphabetical/numeric order.
function sortTagsAlphaNumericLast(tags) {
  const alpha = [];
  const digitLeading = [];
  tags.forEach((t) => (/^[0-9]/.test(t) ? digitLeading : alpha).push(t));
  alpha.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  digitLeading.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
  return [...alpha, ...digitLeading];
}

// Builds the capped browse list: dedupe everything first, rank the
// resulting unique tags by how many videos use them (most-used
// first), then take only the top TAG_CLOUD_MAX_VISIBLE. This is the
// ONLY function that decides what a "browse tags" view can ever
// contain — it hard-returns an array whose length can never exceed
// TAG_CLOUD_MAX_VISIBLE, so however messy the raw tag data is (900,
// 5000, whatever), every browse view is capped by construction.
function buildCappedBrowseTags(rawTagCounts) {
  const groups = dedupeTagCounts(rawTagCounts);
  const ranked = Array.from(groups.values()).sort((a, b) => b.count - a.count);
  const topByUsage = ranked.slice(0, TAG_CLOUD_MAX_VISIBLE).map((g) => g.display);
  return {
    visible: sortTagsAlphaNumericLast(topByUsage), // alphabetize AFTER capping, for a clean display order
    totalUniqueAfterDedupe: groups.size,
  };
}

// Site branding
const SITE_NAME = "seXvid18";

// Pagination
const INITIAL_LOAD_COUNT = 27;   // videos shown on first paint
const LOAD_MORE_COUNT = 9;       // videos appended per infinite-scroll batch
const MAX_VIDEOS_DISPLAYED = 33; // hard cap for index.html — grid stops loading past this, scroll observer disconnects

const RELATED_INITIAL_COUNT = 6;
const RELATED_LOAD_MORE_COUNT = 6;

const AUTHOR_VIDEOS_INITIAL_COUNT = 12;
const AUTHOR_VIDEOS_LOAD_MORE_COUNT = 9;
const MORE_VIDEOS_INITIAL_COUNT = 18;
const MORE_VIDEOS_LOAD_MORE_COUNT = 9;

// Ads
const ADS_AFTER_ROWS = 5;   // insert a full-width banner ad after every N rows
const GRID_COLUMNS_DESKTOP = 3;

const PLACEHOLDER_IMAGE = "placeholder.webp";
const PLACEHOLDER_AVATAR = "placeholder-avatar.webp";

const VIDEO_FILES_FOLDER = "v";      // physical folder on disk holding watch.html / watch.js — UNCHANGED
const WATCH_PAGE_FILE = "watch.html"; // the actual file Cloudflare Pages serves
const WATCH_ROUTE_SEGMENT = "watch";  // public URL segment at SITE ROOT — see /_redirects:
                                       // "/watch/:slug   /v/watch.html   200"
                                       // (same one-segment pattern as /models/:slug,
                                       // /search/:query, /categories/:slug)

const MODELS_FOLDER = "models";

const PROFILE_API_URL = "https://data.bots62340.workers.dev";

const VIDEO_API_URL = "https://video-api.olivia-rose-or2005.workers.dev";

async function fetchVideoApiData(uniqueId) {
  if (!uniqueId) return null;
  try {
    const res = await fetch(`${VIDEO_API_URL}/video/${encodeURIComponent(uniqueId)}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data) return null;
    return {
      directVideoUrl: data.directVideoUrl || null,
      views: typeof data.views === "number" ? data.views : null,
    };
  } catch (err) {
    console.error("[video-api] fetchVideoApiData failed:", err);
    return null;
  }
}

async function fetchDirectVideoUrl(uniqueId) {
  const data = await fetchVideoApiData(uniqueId);
  return data ? data.directVideoUrl : null;
}

/* =========================================================
   PROFILE PHOTO UPLOAD — Cloudflare Worker + Cloudinary
   ========================================================= */
const PHOTO_UPLOAD_API_URL = "https://still-star-bfbb.jaginisupriya7.workers.dev/";
const PROFILE_PHOTO_MAX_BYTES = 200 * 1024;
const PROFILE_PHOTO_MAX_DIMENSION = 800;

async function compressImageToLimit(file, maxBytes = PROFILE_PHOTO_MAX_BYTES, maxDimension = PROFILE_PHOTO_MAX_DIMENSION) {
  const bitmap = await createImageBitmap(file);
  let { width, height } = bitmap;
  if (width > maxDimension || height > maxDimension) {
    const scale = maxDimension / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);

  let quality = 0.9;
  let blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
  while (blob && blob.size > maxBytes && quality > 0.3) {
    quality -= 0.1;
    blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
  }
  if (!blob || blob.size > maxBytes) {
    throw new Error("Couldn't compress this image below 200KB — try a smaller photo.");
  }
  return blob;
}

async function uploadProfilePhoto(uid, file) {
  if (typeof PHOTO_UPLOAD_API_URL === "undefined" || PHOTO_UPLOAD_API_URL.includes("YOUR-NEW-WORKER")) {
    throw new Error("Photo upload isn't configured yet (PHOTO_UPLOAD_API_URL in config.js).");
  }
  const compressed = await compressImageToLimit(file);

  const form = new FormData();
  form.append("file", compressed, "profile.jpg");
  form.append("uid", uid);

  const res = await fetch(`${PHOTO_UPLOAD_API_URL}/upload-photo`, { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (HTTP ${res.status})`);
  return data.url;
}

/* =========================================================
   MULTI-FILE VIDEO POOL

   FIX: fetchAllVideos() no longer reads or writes sessionStorage /
   localStorage at all. Every call:
     1. re-resolves the current list of content*.json files
     2. fetches ALL of them in parallel with cache: "no-store" (so the
        browser's HTTP cache can't silently serve a stale copy either)
     3. merges everything into one pool, deduping by uniqueId/id so a
        video listed in two files only counts once
     4. shuffles the merged pool fresh, every single call

   This guarantees "every file counted equally, every load random."
   The tradeoff is one extra network round-trip per page load instead
   of relying on a cache — for a video-listing site that's the right
   tradeoff, since it's the only way new content shows up immediately.
   ========================================================= */
function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function fetchAllVideos(urls = null) {
  if (!urls) urls = await resolveJsonUrls();

  const results = await Promise.allSettled(
    urls.map((url) =>
      fetch(url, { cache: "no-store" }).then((res) => {
        if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
        return res.json();
      })
    )
  );

  const merged = [];
  const seen = new Set();
  let failCount = 0;

  results.forEach((r, i) => {
    if (r.status !== "fulfilled") {
      failCount++;
      console.error(`[fetchAllVideos] failed to load "${urls[i]}":`, r.reason);
      return;
    }
    const list = Array.isArray(r.value) ? r.value : (r.value.videos || []);
    list.forEach((video) => {
      const key = String(video.uniqueId ?? video.id ?? "");
      if (key) {
        if (seen.has(key)) return;
        seen.add(key);
      }
      merged.push(video);
    });
  });

  if (failCount === urls.length && urls.length > 0) {
    throw new Error(`All ${urls.length} JSON file(s) failed to load — check that your content*.json files are reachable and DATA_BASE_URL in config.js is correct.`);
  }

  return shuffleArray(merged);
}

/* =========================================================
   MULTI-FILE MODEL/AUTHOR PROFILE POOL

   FIX: same treatment — no caching, fetch fresh every call.
   ========================================================= */
async function fetchAllAuthors(urls = AUTHOR_JSON_URLS) {
  const results = await Promise.allSettled(
    urls.map((url) =>
      fetch(url, { cache: "no-store" }).then((res) => {
        if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
        return res.json();
      })
    )
  );

  const merged = [];
  const seen = new Set();
  let failCount = 0;

  results.forEach((r, i) => {
    if (r.status !== "fulfilled") {
      failCount++;
      console.error(`[fetchAllAuthors] failed to load "${urls[i]}":`, r.reason);
      return;
    }
    const list = Array.isArray(r.value) ? r.value : (r.value.authors || []);
    list.forEach((author) => {
      const key = normalizeName(author.name) || String(author.id ?? "");
      if (key) {
        if (seen.has(key)) return;
        seen.add(key);
      }
      merged.push(author);
    });
  });

  if (failCount === urls.length && urls.length > 0) {
    throw new Error(`All ${urls.length} author JSON file(s) failed to load — check AUTHOR_JSON_URLS in config.js.`);
  }

  return merged;
}

/* =========================================================
   AD CODES
   ========================================================= */
const AD_CODES = {
  smartlinkUrl: `https://reactahead.com/c4wzssx484?key=dc68fb020c2eb81627b57d6ffb786adc`,

  nativeBanner: `<script async="async" data-cfasync="false" src="https://reactahead.com/ec9457550ad5ce8d7a3387c69e4a2a37/invoke.js"></script>
<div id="container-ec9457550ad5ce8d7a3387c69e4a2a37"></div>`,
  banner468x60: `<script>
  atOptions = {
    'key' : '028b7513756668e783905e43ad4e940f',
    'format' : 'iframe',
    'height' : 60,
    'width' : 468,
    'params' : {}
  };
</script>
<script src="https://reactahead.com/028b7513756668e783905e43ad4e940f/invoke.js"></script>`,
  banner300x250: `<script>
  atOptions = {
    'key' : 'e509b1345f1f74d5f712e43b1047345b',
    'format' : 'iframe',
    'height' : 250,
    'width' : 300,
    'params' : {}
  };
</script>
<script src="https://reactahead.com/e509b1345f1f74d5f712e43b1047345b/invoke.js"></script>`,
  banner160x300: `<script>
  atOptions = {
    'key' : '0582b1fa2e335c54fc693348ba38660e',
    'format' : 'iframe',
    'height' : 300,
    'width' : 160,
    'params' : {}
  };
</script>
<script src="https://reactahead.com/0582b1fa2e335c54fc693348ba38660e/invoke.js"></script>`,
  banner160x600: `<script>
  atOptions = {
    'key' : 'c81401802d42416704294ceadea4c35a',
    'format' : 'iframe',
    'height' : 600,
    'width' : 160,
    'params' : {}
  };
</script>
<script src="https://reactahead.com/c81401802d42416704294ceadea4c35a/invoke.js"></script>`,
  banner320x50: `<script>
  atOptions = {
    'key' : '32cfd76eff1b697e0aa3f977762e3293',
    'format' : 'iframe',
    'height' : 50,
    'width' : 320,
    'params' : {}
  };
</script>
<script src="https://reactahead.com/32cfd76eff1b697e0aa3f977762e3293/invoke.js"></script>`,
  banner728x90: `<script>
  atOptions = {
    'key' : 'd353454d1c82d0d1095355f65774ecb5',
    'format' : 'iframe',
    'height' : 90,
    'width' : 728,
    'params' : {}
  };
</script>
<script src="https://reactahead.com/d353454d1c82d0d1095355f65774ecb5/invoke.js"></script>`,
};

const AD_SLOT_DIMENSIONS = {
  banner468x60: [468, 60],
  banner300x250: [300, 250],
  banner160x300: [160, 300],
  banner160x600: [160, 600],
  banner320x50: [320, 50],
  banner728x90: [728, 90],
};

function injectAdCode(container, codeString, adKey) {
  if (!container || !codeString || !codeString.trim()) return false;
  container.innerHTML = "";

  const dims = AD_SLOT_DIMENSIONS[adKey];
  const iframe = document.createElement("iframe");
  iframe.title = "advertisement";
  iframe.scrolling = "no";
  iframe.style.border = "0";
  iframe.style.display = "block";
  iframe.style.margin = "0 auto";
  iframe.style.maxWidth = "100%";
  iframe.style.width = dims ? dims[0] + "px" : "100%";
  iframe.style.height = dims ? dims[1] + "px" : "100%";

  iframe.setAttribute(
    "sandbox",
    "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
  );

  iframe.srcdoc =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>` +
    `html,body{margin:0;padding:0;background:transparent;overflow:hidden;` +
    `display:flex;align-items:center;justify-content:center;}` +
    `</style></head><body>${codeString}</body></html>`;

  container.appendChild(iframe);
  return true;
}

function injectPageLevelAds() {
  [AD_CODES.socialBar, AD_CODES.popunder].forEach((code) => {
    if (!code || !code.trim()) return;
    const temp = document.createElement("div");
    temp.innerHTML = code;
    Array.from(temp.childNodes).forEach((node) => {
      if (node.tagName === "SCRIPT") {
        const s = document.createElement("script");
        Array.from(node.attributes).forEach((attr) => s.setAttribute(attr.name, attr.value));
        s.textContent = node.textContent;
        document.body.appendChild(s);
      } else {
        document.body.appendChild(node);
      }
    });
  });
}

function fillAdSlot(el, adKey) {
  if (!el) return false;
  const code = AD_CODES[adKey];
  if (code && code.trim()) return injectAdCode(el, code, adKey);
  return false;
}

const MOBILE_AD_KEY = "banner320x50";
const MOBILE_AD_BREAKPOINT = 840;
const MOBILE_AD_DISMISS_KEY = "streamhub_mobile_ad_dismissed";

function renderMobileAdBar() {
  if (document.getElementById("mobileAdBar")) return;
  if (window.innerWidth > MOBILE_AD_BREAKPOINT) return;
  if (typeof AD_CODES === "undefined" || !AD_CODES[MOBILE_AD_KEY] || !AD_CODES[MOBILE_AD_KEY].trim()) return;
  try {
    if (sessionStorage.getItem(MOBILE_AD_DISMISS_KEY) === "1") return;
  } catch (e) { /* storage unavailable — just show it */ }

  const bar = document.createElement("div");
  bar.id = "mobileAdBar";
  bar.className = "mobile-ad-bar";

  const slot = document.createElement("div");
  slot.className = "ad-slot";
  bar.appendChild(slot);

  const closeBtn = document.createElement("button");
  closeBtn.className = "mobile-ad-bar-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close ad");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => {
    bar.remove();
    try { sessionStorage.setItem(MOBILE_AD_DISMISS_KEY, "1"); } catch (e) { /* ignore */ }
  });
  bar.appendChild(closeBtn);

  document.body.appendChild(bar);
  fillAdSlot(slot, MOBILE_AD_KEY);
}

if (typeof window !== "undefined") {
  let mobileAdResizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(mobileAdResizeTimer);
    mobileAdResizeTimer = setTimeout(() => {
      const bar = document.getElementById("mobileAdBar");
      if (window.innerWidth > MOBILE_AD_BREAKPOINT) {
        if (bar) bar.remove();
      } else if (!bar) {
        renderMobileAdBar();
      }
    }, 200);
  });
}

function openSmartlink() {
  if (AD_CODES.smartlinkUrl) window.open(AD_CODES.smartlinkUrl, "_blank", "noopener,noreferrer");
}

// ---------------------------------------------------------------
// SINGLE WATCH-PAGE ROUTING / SITE-ROOT-AWARE LINKS / SHARED VIDEO CARD
// ---------------------------------------------------------------
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function getPreviewUrl(video) {
  const url = video.previewVideoUrl || video.previewUrl || video.preview || video.previewVideo || video.previewSrc || null;
  return url ? String(url).trim() : null;
}

/* =========================================================
   AUTHOR AVATAR IMAGES (video-card meta)

   Images live at AUTHOR_IMG_BASE_URL/<slug>.jpg, one per author,
   uploaded by hand — so not every author necessarily has one yet.
   authorImageUrl() just builds the expected URL from the same
   slugifyName() used for the profile link, so the filename always
   matches the profile slug (e.g. "Aften Opal" -> aften-opal.jpg).

   There's no way to check existence without a request, and we don't
   want a broken-image icon or a placeholder avatar flashing in when
   a file is missing — the requirement is "if it's not there, don't
   display it at all." So the <img> is rendered with an inline
   onerror handler that removes the whole avatar element from the DOM
   the moment the browser fails to load it (404, etc.) — this fires
   before the user ever sees a broken-image icon, and leaves the
   author name link exactly as it looked before (no avatar).
   ========================================================= */
const AUTHOR_IMG_BASE_URL = "https://authors-iu6.pages.dev";

function authorImageUrl(authorName) {
  const slug = slugifyName(authorName);
  return slug ? `${AUTHOR_IMG_BASE_URL}/${slug}.jpg` : null;
}

/* ---------------------------------------------------------------
   Video card markup.

   The card is not a single <a> wrapping everything, because the
   author name is its OWN link to the author's profile page (nested
   <a> tags are invalid HTML and browsers will break out of the outer
   link when they hit one).

   Structure:
     <div class="video-card">           <- outer container (not a link)
       <a class="video-card-media">     <- thumbnail + title, -> watch page
       <a class="video-card-author">    <- avatar (optional) + name, -> profile page
     </div>

   authorHref() is defined further down in this same file but that's
   fine — function declarations are hoisted, so it's callable here.
   --------------------------------------------------------------- */
function videoCardHtml(video) {
  const thumb = video.thumbnail || video.thumb || PLACEHOLDER_IMAGE;
  const title = escapeHtml(video.title || "Untitled");
  const author = escapeHtml(video.author || "");
  const preview = getPreviewUrl(video);
  const authorLink = video.author ? authorHref({ name: video.author }) : null;
  const avatarUrl = video.author ? authorImageUrl(video.author) : null;

  const avatarHtml = avatarUrl
    ? `<img class="video-card-author-avatar" src="${escapeHtml(avatarUrl)}" alt=""
         loading="lazy" width="24" height="24"
         onerror="this.remove();">`
    : "";

  return `
    <div class="video-card">
      <a class="video-card-media" href="${videoHref(video)}">
        <div class="video-thumb-wrap">
          <img class="video-thumb" src="${thumb}" alt="${title}" loading="lazy"
               onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}';">
          ${preview ? `<video class="video-preview" muted loop playsinline preload="none" src="${preview}"></video>` : ""}
          ${video.duration ? `<span class="video-duration">${escapeHtml(video.duration)}</span>` : ""}
        </div>
        <div class="video-card-title">${title}</div>
      </a>
      ${author ? `<a class="video-card-author" href="${authorLink}">${avatarHtml}<span class="video-card-author-name">${author}</span></a>` : ""}
    </div>`;
}

// ---------------------------------------------------------------
// IN-FEED / FULL-ROW BANNER ADS (inside video grids)
// A thin, wide banner (728x90 on desktop, 320x50 on narrow screens)
// spanning the full width of the grid row. Left EMPTY at insert time
// — wireLazyAdCards() only fills it once it scrolls near the viewport.
// ---------------------------------------------------------------
let __inFeedAdSeq = 0;

// Picks the right banner size for the CURRENT viewport at the moment
// the ad card markup is built. If the window is later resized across
// the breakpoint, the ad already rendered keeps whatever size it was
// given — same tradeoff the existing sticky mobile bar already makes.
function pickRowAdKey() {
  const isNarrow = typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(max-width: 840px)").matches
    : false;
  return isNarrow ? "banner320x50" : "banner728x90";
}

function adCardHtml(adKey) {
  const uid = `adrow-${Date.now().toString(36)}-${__inFeedAdSeq++}`;
  return `
    <div class="ad-card ad-card--row" id="${uid}" data-ad-key="${escapeHtml(adKey)}">
      <div class="ad-label">Advertisement</div>
      <div class="ad-slot"></div>
    </div>`;
}

function wireLazyAdCards(container) {
  if (!container) return;
  const cards = container.querySelectorAll(".ad-card:not([data-filled])");
  if (!cards.length) return;

  if (!("IntersectionObserver" in window)) {
    cards.forEach((card) => {
      card.dataset.filled = "1";
      fillAdSlot(card.querySelector(".ad-slot"), card.dataset.adKey);
    });
    return;
  }

  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const card = entry.target;
      if (card.dataset.filled) { io.unobserve(card); return; }
      card.dataset.filled = "1";
      fillAdSlot(card.querySelector(".ad-slot"), card.dataset.adKey);
      io.unobserve(card);
    });
  }, { rootMargin: "400px 0px" });

  cards.forEach((card) => io.observe(card));
}

// Builds a batch of video cards with a full-row banner ad spliced in
// after every (ADS_AFTER_ROWS * GRID_COLUMNS_DESKTOP) cards — i.e.
// after every 5 rows of the 3-column desktop grid — counting from
// `startIndex` so cadence stays correct across infinite-scroll batches.
function videoGridBatchHtml(videos, startIndex) {
  const perAdBlock = Math.max(1, ADS_AFTER_ROWS * GRID_COLUMNS_DESKTOP);
  let html = "";
  videos.forEach((video, i) => {
    html += videoCardHtml(video);
    const position = startIndex + i + 1;
    if (position % perAdBlock === 0) {
      html += adCardHtml(pickRowAdKey());
    }
  });
  return html;
}

/* Hover-preview is wired specifically to .video-card-media (the
   thumbnail link) instead of the whole .video-card, so hovering the
   author name underneath doesn't trigger preview playback — it just
   behaves like a normal link into the profile page. */
function wireVideoCardPreviews(container) {
  if (!container || !window.matchMedia || !window.matchMedia("(hover: hover)").matches) return;
  container.querySelectorAll(".video-card-media").forEach((media) => {
    if (media.dataset.previewWired) return;
    media.dataset.previewWired = "1";
    const video = media.querySelector(".video-preview");
    if (!video) return;
    let hoverTimer;
    media.addEventListener("mouseenter", () => {
      hoverTimer = setTimeout(() => {
        video.style.display = "block";
        video.currentTime = 0;
        video.play().catch(() => { /* autoplay blocked — non-fatal */ });
      }, 250);
    });
    media.addEventListener("mouseleave", () => {
      clearTimeout(hoverTimer);
      video.pause();
      video.style.display = "none";
    });
  });
}

/* =========================================================
   ROOT-ABSOLUTE INTERNAL LINKS

   FIX (root cause of the /search/models/... bug):
   videoHref() and authorHref() used to build RELATIVE paths
   ("v/watch.html", "models/slug") and relied on siteRootPrefix() to
   guess "../" vs "" by regex-matching the current pathname against
   /v/... or /models/.... That guess had no idea about every other
   clean-URL section on the site (e.g. /search/<query>, and whatever
   gets added next) that is ALSO one path segment deep because of a
   Cloudflare Pages rewrite rule — so on those pages it guessed wrong
   and the relative link resolved against the wrong base, producing
   things like /search/models/kristel-jack instead of
   /models/kristel-jack.

   Root-absolute paths (leading "/") resolve identically from ANY
   current URL, no matter how deep it is or which rewrite served it.
   That removes the guessing entirely instead of teaching it one more
   special case — this class of bug can't recur as new rewritten
   sections get added later.

   siteRootPrefix() is intentionally removed: nothing needs it anymore.
   ========================================================= */

/* FIX (this revision): clean /watch/<title-slug> video URLs, at SITE
   ROOT (not under /v/) — "domain/watch/title".

   videoHref() now builds "/watch/<slugified-title>" using the same
   slugifyName() already used for author/category slugs. Add this
   rewrite to /_redirects, alongside your existing /models/:slug,
   /search/:query, and /categories/:slug rules:

       /watch/:slug        /v/watch.html        200

   currentVideoSlugFromUrl() reads the slug back out of that clean
   path (same pattern as currentAuthorKeyFromUrl() /
   currentCategorySlugFromUrl()), and falls back to the legacy
   ?id=<uniqueId> query param so any old bookmarks/links still work.
   watch.js matches the slug back to a video by slugifying every
   video's title and comparing — see resolveVideoFromSlug() there.

   CAVEAT — titles are not guaranteed unique. If two videos share the
   exact same title, they'll produce the exact same slug and the
   first match in your JSON wins; the other becomes unreachable by
   its title URL. uniqueId (the old scheme) never had this problem.
   If that turns out to matter for your catalog, the usual fix is a
   short suffix, e.g. `${slugifyName(video.title)}-${video.uniqueId}`
   — ask if you want that version instead. */
function videoHref(video) {
  return `/${WATCH_ROUTE_SEGMENT}/${slugifyName(video.title)}`;
}

function currentVideoSlugFromUrl() {
  const match = window.location.pathname.match(
    new RegExp(`/${WATCH_ROUTE_SEGMENT}/([^/]+?)/?$`)
  );
  if (match) return decodeURIComponent(match[1]);
  // legacy fallback: old /v/watch.html?id=<uniqueId> links
  return new URLSearchParams(window.location.search).get("id");
}

const AUTHOR_PAGE_FILE = "profile.html";

// Builds a clean, root-absolute, hyphenated slug URL: "/models/abella-danger".
// Assumes a real file exists at models/<slug>.html (or
// models/<slug>/index.html) for every author you link to.
function authorHref(author) {
  return `/${MODELS_FOLDER}/${slugifyName(author.name)}`;
}

// Reads `?name=` first; falls back to parsing the slug straight out of
// the URL path, so it works whether the page was reached via the old
// query-string link style or the new clean-URL style — both resolve
// to the same normalized key.
function currentAuthorKeyFromUrl() {
  const fromQuery = new URLSearchParams(window.location.search).get("name");
  if (fromQuery) return normalizeName(fromQuery);

  const match = window.location.pathname.match(
    new RegExp(`/${MODELS_FOLDER}/([^/]+?)(?:\\.html)?/?$`)
  );
  return match ? normalizeName(decodeURIComponent(match[1])) : null;
}