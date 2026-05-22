import express from "express";
import "./env.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { scrapeDiary } from "./scraper/diaryScraper.js";
import { isLikelyDirectImageUrl, mergeEntriesIntoMovies } from "./scraper/normalizers.js";
import { scrapeMovieDetails, scrapeReviewForEntry } from "./scraper/reviewScraper.js";
import { closeBrowser } from "./scraper/browserFetch.js";
import { findTmdbPoster } from "./scraper/tmdbClient.js";
import { createLogger } from "./logger.js";

const log = createLogger("server");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(__dirname, "public");
const CACHE_PATH = path.join(__dirname, "data", "cache.json");
const PORT = process.env.PORT || 3000;

const USERS = ["tgibs97", "theonlysaneone", "inscrutablejule", "kieutpie"];

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ── HTTP request logger ───────────────────────────────────────────────────────
app.use((req, _res, next) => {
  const start = Date.now();
  _res.on("finish", () => {
    // Skip noisy static asset requests; only log /api/* and page routes
    if (!req.path.startsWith("/api/") && !req.path.startsWith("/movie/") && req.path !== "/") return;
    log.info(`${req.method} ${req.path} → ${_res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

function emptyCache() {
  return {
    lastRefreshed: null,
    users: USERS,
    moviesBySlug: {},
    failures: []
  };
}

async function readCache() {
  if (_cache) {
    log.debug(`cache read (memory) — ${Object.keys(_cache.moviesBySlug || {}).length} movie(s), lastRefreshed=${_cache.lastRefreshed || "never"}`);
    return _cache;
  }
  // Cold start — load from disk once.
  try {
    const raw = await fs.readFile(CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const movieCount = Object.keys(parsed.moviesBySlug || {}).length;
    log.info(`cache loaded from disk — ${movieCount} movie(s), lastRefreshed=${parsed.lastRefreshed || "never"}`);
    _cache = { ...emptyCache(), ...parsed, users: USERS };
    return _cache;
  } catch (error) {
    if (error.code === "ENOENT") {
      log.info("no cache file found — starting with empty cache");
    } else {
      log.error(`failed to read cache: ${error.message}`);
    }
    _cache = emptyCache();
    return _cache;
  }
}

// Single shared in-memory cache. All requests mutate the same object so
// concurrent poster/detail lookups accumulate their changes rather than
// each overwriting the others' work when they flush to disk.
let _cache = null;

// Serialise all writes so concurrent requests never race on the same rename target.
let _writeLock = Promise.resolve();

async function writeCache(cache) {
  // Keep the in-memory pointer in sync immediately (synchronous) so the next
  // readCache() call sees the latest state even before the disk write finishes.
  _cache = cache;

  const doWrite = async () => {
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    const tmp = `${CACHE_PATH}.${randomUUID()}.tmp`;
    const movieCount = Object.keys(cache.moviesBySlug || {}).length;
    log.debug(`writing cache — ${movieCount} movie(s)`);
    await fs.writeFile(tmp, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
    try {
      await fs.rename(tmp, CACHE_PATH);
      log.debug("cache written successfully");
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      log.error(`cache write failed: ${err.message}`);
      throw err;
    }
  };
  // Chain onto the lock; use doWrite as both fulfil and reject handler so a
  // failed write doesn't permanently break the chain for future writes.
  _writeLock = _writeLock.then(doWrite, doWrite);
  return _writeLock;
}

function summariesFromCache(cache) {
  return Object.values(cache.moviesBySlug || {}).sort((a, b) =>
    String(b.latestWatchedDate || "").localeCompare(String(a.latestWatchedDate || ""))
  ).map((movie) => ({
    ...movie,
    posterUrl: isLikelyDirectImageUrl(movie.posterUrl) ? movie.posterUrl : ""
  }));
}

async function refreshCache() {
  const done = log.timer("full refresh");
  log.info(`starting full refresh for ${USERS.length} user(s): ${USERS.join(", ")}`);

  const entries = [];
  const failures = [];

  for (const username of USERS) {
    const result = await scrapeDiary(username);
    entries.push(...result.entries);
    failures.push(...result.failures);
    log.info(`[${username}] contributed ${result.entries.length} entries, ${result.failures.length} failure(s)`);
  }

  const movies = mergeEntriesIntoMovies(entries);
  const movieCount = Object.keys(movies).length;
  log.info(`merged into ${movieCount} unique movie(s) from ${entries.length} total entries`);

  if (failures.length > 0) {
    log.warn(`${failures.length} scrape failure(s) during refresh:`);
    for (const f of failures) {
      log.warn(`  ${f.username} — ${f.message} (${f.url})`);
    }
  }

  const cache = {
    lastRefreshed: new Date().toISOString(),
    users: USERS,
    moviesBySlug: movies,
    failures
  };

  await writeCache(cache);
  done();
  return cache;
}

async function hydrateMovieDetail(cache, slug, { preservePoster = false } = {}) {
  const movie = cache.moviesBySlug?.[slug];
  if (!movie) {
    log.warn(`hydrateMovieDetail: slug "${slug}" not found in cache`);
    return null;
  }

  let changed = false;

  if (!movie.details || !Object.keys(movie.details).length) {
    log.info(`[${slug}] fetching movie details (not cached)`);
    const details = await scrapeMovieDetails(slug);
    movie.details = details;
    if (!preservePoster && !isLikelyDirectImageUrl(movie.posterUrl) && details.posterUrl) {
      movie.posterUrl = details.posterUrl;
      log.debug(`[${slug}] updated poster from details`);
    }
    changed = true;
  } else {
    log.debug(`[${slug}] movie details already cached`);
  }

  const unchecked = movie.entries.filter((e) => !e.reviewChecked);
  if (unchecked.length > 0) {
    log.info(`[${slug}] checking ${unchecked.length} unchecked review(s)`);
  }

  for (let index = 0; index < movie.entries.length; index += 1) {
    const entry = movie.entries[index];
    if (entry.reviewChecked) continue;
    movie.entries[index] = await scrapeReviewForEntry(entry);
    changed = true;
  }

  if (changed) {
    cache.moviesBySlug[slug] = movie;
    await writeCache(cache);
  }

  return {
    ...movie,
    posterUrl: isLikelyDirectImageUrl(movie.posterUrl) ? movie.posterUrl : ""
  };
}

async function resolvePoster(cache, slug) {
  const movie = cache.moviesBySlug?.[slug];
  if (!movie) {
    log.warn(`resolvePoster: slug "${slug}" not found in cache`);
    return "";
  }

  if (isLikelyDirectImageUrl(movie.posterUrl)) {
    log.debug(`[${slug}] poster already resolved (${movie.posterSource || "cached"})`);
    return movie.posterUrl;
  }

  log.info(`[${slug}] resolving poster — trying TMDB first`);

  try {
    const tmdbPoster = await findTmdbPoster(movie);
    if (tmdbPoster?.posterUrl) {
      log.info(`[${slug}] poster resolved via TMDB (tmdbId=${tmdbPoster.tmdbId})`);
      movie.posterUrl = tmdbPoster.posterUrl;
      movie.posterSource = "tmdb";
      movie.tmdbId = tmdbPoster.tmdbId;
      if (!movie.releaseDate && tmdbPoster.releaseDate) {
        movie.releaseDate = tmdbPoster.releaseDate.slice(0, 4);
      }
      cache.moviesBySlug[slug] = movie;
      await writeCache(cache);
      return movie.posterUrl;
    } else {
      log.info(`[${slug}] TMDB returned no poster — falling back to Letterboxd scrape`);
    }
  } catch (error) {
    log.error(`[${slug}] TMDB lookup failed: ${error.message}`);
  }

  try {
    const details = await scrapeMovieDetails(slug);
    if (details.posterUrl && isLikelyDirectImageUrl(details.posterUrl)) {
      log.info(`[${slug}] poster resolved via Letterboxd scrape`);
      movie.posterUrl = details.posterUrl;
      movie.posterSource = "letterboxd";
      movie.details = { ...(movie.details || {}), ...details };
      cache.moviesBySlug[slug] = movie;
      await writeCache(cache);
      return movie.posterUrl;
    } else {
      log.warn(`[${slug}] Letterboxd scrape returned no usable poster`);
    }
  } catch (error) {
    log.error(`[${slug}] Letterboxd poster scrape failed: ${error.message}`);
  }

  log.warn(`[${slug}] could not resolve poster from any source`);
  return "";
}

app.get("/api/movies", async (req, res) => {
  const cache = await readCache();
  const movies = summariesFromCache(cache);
  log.info(`GET /api/movies — returning ${movies.length} movie(s)`);
  res.json({
    lastRefreshed: cache.lastRefreshed,
    users: USERS,
    failures: cache.failures || [],
    movies
  });
});

app.get("/api/movies/:slug", async (req, res) => {
  const { slug } = req.params;
  log.info(`GET /api/movies/${slug}`);
  const cache = await readCache();
  const movie = await hydrateMovieDetail(cache, slug);
  if (!movie) {
    log.warn(`movie not found: ${slug}`);
    res.status(404).json({ error: "Movie not found in cache. Run a refresh first." });
    return;
  }
  res.json({ movie, lastRefreshed: cache.lastRefreshed });
});

app.get("/api/posters/:slug", async (req, res) => {
  const { slug } = req.params;
  log.info(`GET /api/posters/${slug}`);
  const cache = await readCache();
  const posterUrl = await resolvePoster(cache, slug);
  if (!posterUrl) {
    log.warn(`no poster found for ${slug}`);
    res.status(404).send("Poster not found");
    return;
  }
  log.debug(`redirecting poster for ${slug} → ${posterUrl}`);
  res.redirect(302, posterUrl);
});

app.post("/api/refresh/:slug", async (req, res) => {
  const { slug } = req.params;
  log.info(`POST /api/refresh/${slug} — force-refreshing single movie`);
  try {
    const cache = await readCache();
    if (!cache.moviesBySlug?.[slug]) {
      log.warn(`refresh requested for unknown slug: ${slug}`);
      res.status(404).json({ error: "Movie not found in cache." });
      return;
    }
    const movie = cache.moviesBySlug[slug];
    movie.details = {};
    movie.entries = movie.entries.map((e) => ({ ...e, reviewChecked: false, reviewText: "", hasReview: false }));
    cache.moviesBySlug[slug] = movie;
    await writeCache(cache);
    log.info(`[${slug}] cleared cached details and review data — re-hydrating`);

    // preservePoster: true so re-scraping the film page can't overwrite the poster
    const hydrated = await hydrateMovieDetail(cache, slug, { preservePoster: true });

    log.info(`[${slug}] single-movie refresh complete`);
    res.json({ movie: hydrated, lastRefreshed: cache.lastRefreshed });
  } catch (error) {
    log.error(`single-movie refresh failed for ${slug}: ${error.message}`);
    res.status(500).json({ error: "Refresh failed", message: error.message });
  }
});

app.post("/api/refresh", async (req, res) => {
  log.info("POST /api/refresh — full refresh requested");
  try {
    const cache = await refreshCache();
    const movies = summariesFromCache(cache);
    log.info(`full refresh complete — ${movies.length} movie(s) in response`);
    res.json({
      lastRefreshed: cache.lastRefreshed,
      users: USERS,
      failures: cache.failures,
      movies
    });
  } catch (error) {
    log.error(`full refresh failed: ${error.message}`);
    res.status(500).json({ error: "Refresh failed", message: error.message });
  }
});

app.get("/movie/:slug", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "movie.html"));
});

app.get("*", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// Delete any .tmp files left over from a previous crashed write.
fs.readdir(path.dirname(CACHE_PATH))
  .then((files) => {
    const stale = files.filter((f) => f.endsWith(".tmp"));
    if (stale.length > 0) {
      log.warn(`cleaning up ${stale.length} stale .tmp file(s) from previous run`);
    }
    return Promise.all(
      stale.map((f) => fs.unlink(path.join(path.dirname(CACHE_PATH), f)).catch(() => {}))
    );
  })
  .catch(() => {});

const server = app.listen(PORT, () => {
  log.info("═══════════════════════════════════════════");
  log.info(`Letterboxd Together running at http://localhost:${PORT}`);
  log.info(`Users : ${USERS.join(", ")}`);
  log.info(`Cache : ${CACHE_PATH}`);
  log.info(`Root  : ${ROOT}`);
  log.info(`Node  : ${process.version}`);
  log.info(`Env   : ${process.env.NODE_ENV || "development"}`);
  log.info(`Log   : ${process.env.LOG_LEVEL || "info"}`);
  log.info("═══════════════════════════════════════════");
});

async function shutdown() {
  log.info("shutting down — closing server and browser");
  server.close();
  await closeBrowser();
  log.info("shutdown complete");
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
