const SITE_URL = "https://sexvid18.online";
const META_BASE = "https://json-9xs.pages.dev/meta";
const MAX_URLS = 10000;
const MAX_CONTENT_FILES = 400;
const CACHE_TTL_SECONDS = 3600;
const FETCH_CONCURRENCY = 10;

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toIsoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Mirrors the slugifyName() convention used elsewhere in config.js —
// lowercase, strip non-alphanumerics, collapse to hyphens.
function slugify(str) {
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function fetchContentFile(i) {
  try {
    const res = await fetch(`${META_BASE}/content${i}.json`);
    if (!res.ok) return null;
    const batch = await res.json();
    return Array.isArray(batch) && batch.length ? batch : null;
  } catch {
    return null;
  }
}

async function fetchAllVideos() {
  const videos = [];
  let consecutiveMisses = 0;
  const MAX_CONSECUTIVE_MISSES = 3;

  for (
    let start = 1;
    start <= MAX_CONTENT_FILES && videos.length < MAX_URLS;
    start += FETCH_CONCURRENCY
  ) {
    const batchIndices = [];
    for (let i = start; i < start + FETCH_CONCURRENCY && i <= MAX_CONTENT_FILES; i++) {
      batchIndices.push(i);
    }
    const results = await Promise.all(batchIndices.map(fetchContentFile));

    let allNull = true;
    for (const batch of results) {
      if (batch) {
        allNull = false;
        consecutiveMisses = 0;
        videos.push(...batch);
      }
    }
    if (allNull) {
      consecutiveMisses += FETCH_CONCURRENCY;
      if (consecutiveMisses >= MAX_CONSECUTIVE_MISSES) break;
    }
  }
  return videos.slice(0, MAX_URLS);
}

function urlBlock(loc, lastmod, changefreq, priority, extra = "") {
  return (
    `  <url>\n` +
    `    <loc>${escapeXml(loc)}</loc>` +
    (lastmod ? `\n    <lastmod>${escapeXml(lastmod)}</lastmod>` : "") +
    `\n    <changefreq>${changefreq}</changefreq>\n` +
    `    <priority>${priority}</priority>` +
    extra +
    `\n  </url>`
  );
}

export async function onRequestGet(context) {
  const cache = caches.default;
  const cacheKey = new Request(context.request.url);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let videos = [];
  try {
    videos = await fetchAllVideos();
  } catch (err) {
    videos = [];
  }

  const staticUrls = [
    { loc: `${SITE_URL}/`, priority: "1.0", changefreq: "daily" },
    { loc: `${SITE_URL}/browse`, priority: "0.8", changefreq: "daily" },
  ];

  const seenCategorySlugs = new Set();
  const seenModelSlugs = new Set();

  const staticBlocks = staticUrls.map((u) =>
    urlBlock(u.loc, null, u.changefreq, u.priority)
  );

  const watchBlocks = [];
  const categoryBlocks = [];
  const modelBlocks = [];

  for (const v of videos) {
    // ---- /watch/:slug ---- (derived from title, per your redirect rule)
    const watchSlug = v.slug || slugify(v.title) || v.id;
    if (watchSlug) {
      const lastmod = toIsoDate(v.uploadDate || v.dateAdded);
      const loc = `${SITE_URL}/watch/${encodeURIComponent(watchSlug)}`;

      const videoBlock =
        v.title && v.thumbnailUrl
          ? `\n    <video:video>\n` +
            `      <video:thumbnail_loc>${escapeXml(v.thumbnailUrl)}</video:thumbnail_loc>\n` +
            `      <video:title>${escapeXml(v.title)}</video:title>\n` +
            (v.description
              ? `      <video:description>${escapeXml(v.description.slice(0, 2048))}</video:description>\n`
              : "") +
            (v.previewVideoUrl || v.videoUrl
              ? `      <video:content_loc>${escapeXml(v.previewVideoUrl || v.videoUrl)}</video:content_loc>\n`
              : "") +
            (v.durationSeconds
              ? `      <video:duration>${escapeXml(v.durationSeconds)}</video:duration>\n`
              : "") +
            `    </video:video>`
          : "";

      watchBlocks.push(urlBlock(loc, lastmod, "weekly", "0.7", videoBlock));
    }

    // ---- /categories/:slug ---- (derived from tags)
    const tags = Array.isArray(v.tags) ? v.tags : [];
    for (const tag of tags) {
      const catSlug = slugify(tag);
      if (catSlug && !seenCategorySlugs.has(catSlug)) {
        seenCategorySlugs.add(catSlug);
        const loc = `${SITE_URL}/categories/${encodeURIComponent(catSlug)}`;
        categoryBlocks.push(urlBlock(loc, null, "weekly", "0.6"));
      }
    }

    // ---- /models/:slug ---- (derived from author)
    const author = v.author || v.creator || v.channel;
    if (author) {
      const modelSlug = slugify(author);
      if (modelSlug && !seenModelSlugs.has(modelSlug)) {
        seenModelSlugs.add(modelSlug);
        const loc = `${SITE_URL}/models/${encodeURIComponent(modelSlug)}`;
        modelBlocks.push(urlBlock(loc, null, "weekly", "0.6"));
      }
    }
  }

  const allBlocks = [
    ...staticBlocks,
    ...watchBlocks,
    ...categoryBlocks,
    ...modelBlocks,
  ].slice(0, MAX_URLS);

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
    `        xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">\n` +
    allBlocks.join("\n") +
    `\n</urlset>`;

  const response = new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
    },
  });

  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
