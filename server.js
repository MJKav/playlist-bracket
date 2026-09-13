// Playlist Bracket — tiny zero-dependency server.
// Serves the static site and proxies Spotify's public embed + oEmbed data
// (the browser can't read embed pages directly because of CORS).

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3100;
const PUBLIC_DIR = path.join(__dirname, "public");
// Behind a hosting proxy (Render sets RENDER=true) the visitor's IP is in X-Forwarded-For.
const TRUST_PROXY = process.env.TRUST_PROXY === "1" || process.env.RENDER === "true";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const ID_RE = /^[A-Za-z0-9]{22}$/;

// Abuse protection: each visitor gets a budget of Spotify lookups per window,
// and the whole server never runs more than a handful of Spotify requests at once.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_BUDGET = Number(process.env.RATE_BUDGET) || 1500;
const MAX_CONCURRENT_UPSTREAM = 12;
const MAX_QUEUED_UPSTREAM = 400;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "frame-src https://open.spotify.com",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status }, extra);
}

// ---------- caching & limits ----------

// Small LRU cache with expiry, so memory stays bounded on small hosts.
class Cache {
  constructor(max, ttlMs) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    this.map.delete(key);
    if (entry.expires < Date.now()) return undefined;
    this.map.set(key, entry);
    return entry.value;
  }
  has(key) {
    return this.get(key) !== undefined;
  }
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}

const HOUR = 60 * 60 * 1000;
const collectionCache = new Cache(300, 10 * 60 * 1000);
const trackCache = new Cache(5000, 24 * HOUR);
const artCache = new Cache(10000, 24 * HOUR); // id -> url | null

function createLimiter(max, maxQueue) {
  let active = 0;
  const queue = [];
  return async (fn) => {
    if (active < max) active++;
    else if (queue.length >= maxQueue) throw httpError(503, "The server is busy right now. Try again in a moment.");
    else await new Promise((resolve) => queue.push(resolve)); // a finishing task hands over its slot
    try {
      return await fn();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}
const upstream = createLimiter(MAX_CONCURRENT_UPSTREAM, MAX_QUEUED_UPSTREAM);

const buckets = new Map(); // ip -> { used, resetAt }

function charge(ip, cost) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now >= b.resetAt) {
    b = { used: 0, resetAt: now + RATE_WINDOW_MS };
    buckets.set(ip, b);
  }
  if (b.used + cost > RATE_BUDGET) {
    const secs = Math.ceil((b.resetAt - now) / 1000);
    const mins = Math.ceil(secs / 60);
    throw httpError(429, `You've made a lot of requests. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`, {
      retryAfter: secs,
    });
  }
  b.used += cost;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (now >= b.resetAt) buckets.delete(ip);
}, 60 * 1000).unref();

// The leftmost forwarded address can be spoofed, but that only lets someone dodge
// their own limit — the global upstream cap still protects Spotify.
function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers["x-forwarded-for"];
    if (fwd) return String(fwd).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

// ---------- Spotify helpers ----------

function fetchText(url, timeoutMs = 15000) {
  return upstream(async () => {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "en" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, url: res.url, text: await res.text() };
  });
}

function extractEntity(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity ?? null;
  } catch {
    return null;
  }
}

function pickImage(entity) {
  const cover = entity?.coverArt?.sources?.[0]?.url;
  if (cover) return cover;
  const imgs = entity?.visualIdentity?.image;
  if (Array.isArray(imgs) && imgs.length) {
    const mid = imgs.find((i) => i.maxWidth === 300);
    return (mid || imgs[imgs.length - 1]).url;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Spotify's edge occasionally returns 5xx or stalls; retry a couple of times.
async function fetchEmbed(type, id, attempts = 3) {
  let lastStatus = 0;
  for (let n = 0; n < attempts; n++) {
    if (n) await sleep(600 * n);
    let res;
    try {
      res = await fetchText(`https://open.spotify.com/embed/${type}/${id}`, 12000);
    } catch (err) {
      if (err.status || n === attempts - 1) throw err;
      continue;
    }
    lastStatus = res.status;
    if (res.status === 404) throw httpError(404, `That ${type} wasn't found. Is it public?`);
    if (res.status >= 500 || res.status === 429) continue;
    if (res.status !== 200) break;
    const entity = extractEntity(res.text);
    if (!entity) throw httpError(502, "Couldn't read data from Spotify's embed page.");
    return entity;
  }
  throw httpError(502, `Spotify is having trouble right now (status ${lastStatus}). Try again in a moment.`);
}

// Run async fn over items with limited concurrency.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch {
        out[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function getCollection(type, id) {
  const key = `${type}:${id}`;
  const cached = collectionCache.get(key);
  if (cached) return cached;

  const e = await fetchEmbed(type, id);
  const image = pickImage(e);
  const list = Array.isArray(e.trackList) ? e.trackList : [];
  const tracks = [];
  let skipped = 0;
  for (const t of list) {
    const m = /^spotify:track:([A-Za-z0-9]{22})$/.exec(t.uri || "");
    if (!m) {
      skipped++; // local files, podcast episodes, etc.
      continue;
    }
    tracks.push({
      id: m[1],
      name: t.title || "Unknown song",
      artists: t.subtitle || "",
      image: type === "album" ? image : null,
      durationMs: t.duration || 0,
      explicit: !!t.isExplicit,
    });
  }
  const data = {
    type,
    id,
    name: e.name || e.title || `Spotify ${type}`,
    owner: e.subtitle || "",
    image,
    tracks,
    skipped,
    // Spotify's embed only exposes the first 100 items of a playlist.
    maybeTruncated: type === "playlist" && list.length >= 100,
  };
  collectionCache.set(key, data);
  return data;
}

async function getTrack(id) {
  const cached = trackCache.get(id);
  if (cached) return cached;
  const e = await fetchEmbed("track", id);
  const track = {
    id,
    name: e.name || e.title || "Unknown song",
    artists: Array.isArray(e.artists) ? e.artists.map((a) => a.name).join(", ") : "",
    image: pickImage(e),
    durationMs: e.duration || 0,
    explicit: !!e.isExplicit,
  };
  trackCache.set(id, track);
  if (track.image) artCache.set(id, track.image);
  return track;
}

async function getArt(id) {
  const cached = artCache.get(id);
  if (cached !== undefined) return cached;
  const url = `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/track/${id}`)}`;
  const j = await upstream(async () => {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`oEmbed ${res.status}`);
    return res.json();
  });
  const art = j.thumbnail_url || null;
  artCache.set(id, art);
  return art;
}

// Resolve share links like https://spotify.link/abc123 to a playlist/album.
async function resolveShareLink(link) {
  let u;
  try {
    u = new URL(link);
  } catch {
    throw httpError(400, "That doesn't look like a link.");
  }
  if (!/(^|\.)spotify\.(link|app\.link|com)$/.test(u.hostname)) {
    throw httpError(400, "Only Spotify links are supported.");
  }
  const { url, text } = await fetchText(u.href);
  const re = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(playlist|album)\/([A-Za-z0-9]{22})/i;
  const m = re.exec(url) || re.exec(text);
  if (!m) throw httpError(404, "Couldn't find a playlist or album behind that link.");
  return { type: m[1].toLowerCase(), id: m[2] };
}

// ---------- HTTP plumbing ----------

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": MIME[".json"],
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) reject(httpError(413, "Request too large."));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function parseIds(list, max) {
  const ids = [...new Set((list || []).filter((x) => ID_RE.test(x)))];
  if (!ids.length) throw httpError(400, "No valid track IDs.");
  if (ids.length > max) throw httpError(400, `At most ${max} IDs per request.`);
  return ids;
}

async function handleApi(req, res, url, ip) {
  const route = url.pathname;

  if (route === "/api/health") {
    return sendJson(res, 200, { ok: true });
  }

  if (route === "/api/collection" && req.method === "GET") {
    const type = url.searchParams.get("type");
    const id = url.searchParams.get("id") || "";
    if (!["playlist", "album"].includes(type)) throw httpError(400, "type must be playlist or album.");
    if (!ID_RE.test(id)) throw httpError(400, "That doesn't look like a valid Spotify ID.");
    charge(ip, 1);
    return sendJson(res, 200, await getCollection(type, id));
  }

  if (route === "/api/resolve" && req.method === "GET") {
    charge(ip, 1);
    return sendJson(res, 200, await resolveShareLink(url.searchParams.get("url") || ""));
  }

  if (route === "/api/tracks" && req.method === "POST") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      throw err.status ? err : httpError(400, "Invalid JSON.");
    }
    const ids = parseIds(body.ids, 50);
    charge(ip, Math.max(1, ids.filter((id) => !trackCache.has(id)).length));
    const results = await mapLimit(ids, 8, getTrack);
    return sendJson(res, 200, {
      tracks: results.filter(Boolean),
      failed: ids.filter((_, i) => !results[i]),
    });
  }

  if (route === "/api/art" && req.method === "GET") {
    const ids = parseIds((url.searchParams.get("ids") || "").split(","), 50);
    charge(ip, Math.max(1, ids.filter((id) => !artCache.has(id)).length));
    const results = await mapLimit(ids, 8, getArt);
    const art = {};
    ids.forEach((id, i) => {
      if (results[i]) art[id] = results[i];
    });
    return sendJson(res, 200, { art });
  }

  throw httpError(404, "Unknown API route.");
}

function sendPlain(res, status, text, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS, ...headers });
  res.end(text);
}

function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendPlain(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
  }
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return sendPlain(res, 400, "Bad request");
  }
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(PUBLIC_DIR, "." + rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    return sendPlain(res, 403, "Forbidden");
  }
  fs.readFile(file, (err, data) => {
    if (err) return sendPlain(res, 404, "Not found");
    const ext = path.extname(file);
    const headers = {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
      ...SECURITY_HEADERS,
    };
    if (ext === ".html") headers["Content-Security-Policy"] = CSP;
    res.writeHead(200, headers);
    res.end(data);
  });
}

async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    return sendPlain(res, 400, "Bad request");
  }
  if (!url.pathname.startsWith("/api/")) return serveStatic(req, res, url);

  try {
    await handleApi(req, res, url, clientIp(req));
  } catch (err) {
    const status = err.status || (err.name === "TimeoutError" ? 504 : 500);
    if (status >= 500) console.error(`[api] ${url.pathname}:`, err.message);
    const headers = err.retryAfter ? { "Retry-After": String(err.retryAfter) } : {};
    sendJson(
      res,
      status,
      { error: err.status ? err.message : "Couldn't reach Spotify. Check your connection and try again." },
      headers
    );
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("[server]", err);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Server error");
  });
});

server.listen(PORT, () => {
  console.log(`Playlist Bracket running at http://localhost:${PORT}`);
});

// Hosts stop the old instance with SIGTERM during deploys; let in-flight requests finish.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
