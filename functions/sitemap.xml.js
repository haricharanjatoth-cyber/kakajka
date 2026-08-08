const SITE_URL = "https://sexvid18.online";
const META_BASE = "https://json-9xs.pages.dev/meta";
const MAX_URLS = 10000;
const MAX_CONTENT_FILES = 400;
const CACHE_TTL_SECONDS = 3600;
const FETCH_CONCURRENCY = 10; // parallel batch size

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
  const MAX_CONSECUTIVE_MISSES = 3; // tolerate transient gaps instead of stopping on the first miss

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

export async function onRequestGet(context) {
  const cache = caches.default;
  const cacheKey = new Request(context.request.url);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let videos = [];
  try {
    videos = await fetchAllVideos();
  } catch (err) {
    // Degrade gracefully: still serve static URLs rather than a 500
    videos = [];
  }

  const staticUrls = [
    { loc: `${SITE_URL}/`, priority: "1.0", changefreq: "daily" },
    { loc: `${SITE_URL}/browse`, priority: "0.8", changefreq: "daily" },
  ];

  const urlBlocks = [
    ...staticUrls.map(
      (u) =>
        `  <url>\n` +
        `    <loc>${escapeXml(u.loc)}</loc>\n` +
        `    <changefreq>${u.changefreq}</changefreq>\n` +
        `    <priority>${u.priority}</priority>\n` +
        `  </url>`
    ),
    ...videos.map((v) => {
      const slug = v.slug || v.id;
      const lastmod = toIsoDate(v.uploadDate || v.dateAdded);
      const loc = `${SITE_URL}/watch/${encodeURIComponent(slug)}`;

      // Optional video: block — only emitted if you have the fields.
      // Comment out if you'd rather keep this a plain URL sitemap.
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

      return (
        `  <url>\n` +
        `    <loc>${escapeXml(loc)}</loc>` +
        (lastmod ? `\n    <lastmod>${escapeXml(lastmod)}</lastmod>` : "") +
        `\n    <changefreq>weekly</changefreq>\n` +
        `    <priority>0.7</priority>` +
        videoBlock +
        `\n  </url>`
      );
    }),
  ];

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
    `        xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">\n` +
    urlBlocks.join("\n") +
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