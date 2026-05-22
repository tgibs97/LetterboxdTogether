import express from "express";
import "./env.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { scrapeDiary } from "./scraper/diaryScraper.js";
import { compareDatesDesc, isLikelyDirectImageUrl, mergeEntriesIntoMovies } from "./scraper/normalizers.js";
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

function validRefreshUsers(requestedUsers) {
  if (requestedUsers === undefined) {
    return USERS;
  }

  if (!Array.isArray(requestedUsers)) return [];

  return [...new Set(requestedUsers)]
    .filter((username) => USERS.includes(username));
}

function entriesFromUnselectedUsers(cache, selectedUsers) {
  const selected = new Set(selectedUsers);
  return Object.values(cache.moviesBySlug || {})
    .flatMap((movie) => movie.entries || [])
    .filter((entry) => !selected.has(entry.username));
}

function entriesForUser(cache, username) {
  return Object.values(cache.moviesBySlug || {})
    .flatMap((movie) => movie.entries || [])
    .filter((entry) => entry.username === username);
}

function entryKey(entry) {
  return [
    entry.username || "",
    entry.slug || "",
    entry.watchedDate || "",
    entry.reviewUrl || ""
  ].join("|");
}

function appendMissingCachedEntries(entries, cachedEntries) {
  const existing = new Set(entries.map(entryKey));
  for (const cachedEntry of cachedEntries) {
    const key = entryKey(cachedEntry);
    if (existing.has(key)) continue;
    entries.push(cachedEntry);
    existing.add(key);
  }
}

function preserveCachedMovieData(movies, previousMovies) {
  for (const [slug, movie] of Object.entries(movies)) {
    const previous = previousMovies?.[slug];
    if (!previous) continue;

    movie.details = previous.details || movie.details || {};
    movie.posterSource = previous.posterSource || movie.posterSource;
    movie.tmdbId = previous.tmdbId || movie.tmdbId;

    if (!isLikelyDirectImageUrl(movie.posterUrl) && isLikelyDirectImageUrl(previous.posterUrl)) {
      movie.posterUrl = previous.posterUrl;
    }
  }

  return movies;
}

function updateMovieRollups(movie) {
  movie.entries = (movie.entries || []).sort((a, b) => compareDatesDesc(a.watchedDate, b.watchedDate));
  movie.latestWatchedDate = movie.entries[0]?.watchedDate || "";
  movie.watchedBy = [...new Set(movie.entries.map((entry) => entry.username).filter(Boolean))].sort();

  const ratings = movie.entries
    .map((entry) => entry.rating)
    .filter((rating) => typeof rating === "number" && !Number.isNaN(rating));
  movie.averageRating = ratings.length
    ? Number((ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length).toFixed(2))
    : null;

  return movie;
}

async function refreshCache(selectedUsers = USERS) {
  const done = log.timer("refresh");
  const usersToRefresh = validRefreshUsers(selectedUsers);

  if (usersToRefresh.length === 0) {
    throw new Error("No valid users selected for refresh.");
  }

  log.info(`starting refresh for ${usersToRefresh.length} user(s): ${usersToRefresh.join(", ")}`);

  const previousCache = await readCache();

  const entries = entriesFromUnselectedUsers(previousCache, usersToRefresh);
  const failures = [];

  for (const username of usersToRefresh) {
    const result = await scrapeDiary(username);
    entries.push(...result.entries);
    failures.push(...result.failures);

    if (result.failures.length > 0) {
      appendMissingCachedEntries(entries, entriesForUser(previousCache, username));
      log.warn(`[${username}] had scrape failures, retained missing cached entries for this user`);
    }

    log.info(`[${username}] contributed ${result.entries.length} entries, ${result.failures.length} failure(s)`);
  }

  const movies = preserveCachedMovieData(
    mergeEntriesIntoMovies(entries),
    previousCache.moviesBySlug
  );
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
    failures,
    lastRefreshUsers: usersToRefresh
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
  res.json({ movie, users: USERS, lastRefreshed: cache.lastRefreshed });
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
    const usersToRefresh = req.body?.users === undefined
      ? USERS
      : [...new Set(Array.isArray(req.body.users) ? req.body.users : [])]
        .filter((username) => USERS.includes(username));

    if (usersToRefresh.length === 0) {
      res.status(400).json({ error: "No valid users selected for refresh.", users: USERS });
      return;
    }

    const selectedUsers = new Set(usersToRefresh);
    const existingUsers = new Set((movie.entries || []).map((entry) => entry.username));
    movie.details = {};
    movie.entries = movie.entries.map((entry) => selectedUsers.has(entry.username)
      ? { ...entry, reviewChecked: false, reviewText: "", hasReview: false }
      : entry
    );
    for (const username of usersToRefresh) {
      if (existingUsers.has(username)) continue;
      movie.entries.push({
        username,
        slug,
        title: movie.title,
        releaseDate: movie.releaseDate,
        posterUrl: movie.posterUrl,
        watchedDate: "",
        rating: null,
        reviewUrl: "",
        viewingNumber: null,
        hasReview: false,
        reviewText: "",
        reviewChecked: false,
        probeOnly: true
      });
    }
    cache.moviesBySlug[slug] = movie;
    await writeCache(cache);
    log.info(`[${slug}] cleared cached details and review data — re-hydrating`);

    // preservePoster: true so re-scraping the film page can't overwrite the poster
    const hydrated = await hydrateMovieDetail(cache, slug, { preservePoster: true });
    hydrated.entries = hydrated.entries
      .filter((entry) => !(entry.probeOnly && !entry.hasReview))
      .map(({ probeOnly, ...entry }) => entry);
    updateMovieRollups(hydrated);
    cache.moviesBySlug[slug] = hydrated;
    await writeCache(cache);

    log.info(`[${slug}] single-movie refresh complete`);
    res.json({ movie: hydrated, users: USERS, lastRefreshed: cache.lastRefreshed, refreshedUsers: usersToRefresh });
  } catch (error) {
    log.error(`single-movie refresh failed for ${slug}: ${error.message}`);
    res.status(500).json({ error: "Refresh failed", message: error.message });
  }
});

app.post("/api/refresh", async (req, res) => {
  const usersToRefresh = validRefreshUsers(req.body?.users);
  log.info(`POST /api/refresh — refresh requested for ${usersToRefresh.join(", ") || "no valid users"}`);

  if (usersToRefresh.length === 0) {
    res.status(400).json({ error: "No valid users selected for refresh.", users: USERS });
    return;
  }

  try {
    const cache = await refreshCache(usersToRefresh);
    const movies = summariesFromCache(cache);
    log.info(`refresh complete — ${movies.length} movie(s) in response`);
    res.json({
      lastRefreshed: cache.lastRefreshed,
      users: USERS,
      failures: cache.failures,
      refreshedUsers: usersToRefresh,
      movies
    });
  } catch (error) {
    log.error(`refresh failed: ${error.message}`);
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
