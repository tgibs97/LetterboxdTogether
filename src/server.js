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

function emptyCache() {
  return {
    lastRefreshed: null,
    users: USERS,
    moviesBySlug: {},
    failures: []
  };
}

async function readCache() {
  try {
    const raw = await fs.readFile(CACHE_PATH, "utf8");
    return { ...emptyCache(), ...JSON.parse(raw), users: USERS };
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`[cache] Failed to read cache: ${error.message}`);
    }
    return emptyCache();
  }
}

// Serialise all writes so concurrent requests never race on the same rename target.
let _writeLock = Promise.resolve();

async function writeCache(cache) {
  const doWrite = async () => {
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    const tmp = `${CACHE_PATH}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
    try {
      await fs.rename(tmp, CACHE_PATH);
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
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
  const entries = [];
  const failures = [];

  for (const username of USERS) {
    const result = await scrapeDiary(username);
    entries.push(...result.entries);
    failures.push(...result.failures);
  }

  const cache = {
    lastRefreshed: new Date().toISOString(),
    users: USERS,
    moviesBySlug: mergeEntriesIntoMovies(entries),
    failures
  };

  await writeCache(cache);
  return cache;
}

async function hydrateMovieDetail(cache, slug) {
  const movie = cache.moviesBySlug?.[slug];
  if (!movie) return null;

  let changed = false;

  if (!movie.details || !Object.keys(movie.details).length) {
    const details = await scrapeMovieDetails(slug);
    movie.details = details;
    if (!isLikelyDirectImageUrl(movie.posterUrl) && details.posterUrl) {
      movie.posterUrl = details.posterUrl;
    }
    changed = true;
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
  if (!movie) return "";

  if (isLikelyDirectImageUrl(movie.posterUrl)) return movie.posterUrl;

  try {
    const tmdbPoster = await findTmdbPoster(movie);
    if (tmdbPoster?.posterUrl) {
      movie.posterUrl = tmdbPoster.posterUrl;
      movie.posterSource = "tmdb";
      movie.tmdbId = tmdbPoster.tmdbId;
      if (!movie.releaseDate && tmdbPoster.releaseDate) {
        movie.releaseDate = tmdbPoster.releaseDate.slice(0, 4);
      }
      cache.moviesBySlug[slug] = movie;
      await writeCache(cache);
      return movie.posterUrl;
    }
  } catch (error) {
    console.error(`[tmdb:${slug}] ${error.message}`);
  }

  try {
    const details = await scrapeMovieDetails(slug);
    if (details.posterUrl && isLikelyDirectImageUrl(details.posterUrl)) {
      movie.posterUrl = details.posterUrl;
      movie.posterSource = "letterboxd";
      movie.details = { ...(movie.details || {}), ...details };
      cache.moviesBySlug[slug] = movie;
      await writeCache(cache);
      return movie.posterUrl;
    }
  } catch (error) {
    console.error(`[letterboxd-poster:${slug}] ${error.message}`);
  }

  return "";
}

app.get("/api/movies", async (req, res) => {
  const cache = await readCache();
  res.json({
    lastRefreshed: cache.lastRefreshed,
    users: USERS,
    failures: cache.failures || [],
    movies: summariesFromCache(cache)
  });
});

app.get("/api/movies/:slug", async (req, res) => {
  const cache = await readCache();
  const movie = await hydrateMovieDetail(cache, req.params.slug);
  if (!movie) {
    res.status(404).json({ error: "Movie not found in cache. Run a refresh first." });
    return;
  }
  res.json({ movie, lastRefreshed: cache.lastRefreshed });
});

app.get("/api/posters/:slug", async (req, res) => {
  const cache = await readCache();
  const posterUrl = await resolvePoster(cache, req.params.slug);
  if (!posterUrl) {
    res.status(404).send("Poster not found");
    return;
  }
  res.redirect(302, posterUrl);
});

app.post("/api/refresh/:slug", async (req, res) => {
  const { slug } = req.params;
  try {
    const cache = await readCache();
    if (!cache.moviesBySlug?.[slug]) {
      res.status(404).json({ error: "Movie not found in cache." });
      return;
    }
    const movie = cache.moviesBySlug[slug];
    movie.details = {};
    movie.entries = movie.entries.map((e) => ({ ...e, reviewChecked: false, reviewText: "", hasReview: false }));
    cache.moviesBySlug[slug] = movie;
    await writeCache(cache);
    const hydrated = await hydrateMovieDetail(cache, slug);
    res.json({ movie: hydrated, lastRefreshed: cache.lastRefreshed });
  } catch (error) {
    console.error(`[refresh:${slug}] ${error.message}`);
    res.status(500).json({ error: "Refresh failed", message: error.message });
  }
});

app.post("/api/refresh", async (req, res) => {
  try {
    const cache = await refreshCache();
    res.json({
      lastRefreshed: cache.lastRefreshed,
      users: USERS,
      failures: cache.failures,
      movies: summariesFromCache(cache)
    });
  } catch (error) {
    console.error(`[refresh] ${error.message}`);
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
  .then((files) =>
    Promise.all(
      files
        .filter((f) => f.endsWith(".tmp"))
        .map((f) => fs.unlink(path.join(path.dirname(CACHE_PATH), f)).catch(() => {}))
    )
  )
  .catch(() => {});

const server = app.listen(PORT, () => {
  console.log(`Letterboxd Together running at http://localhost:${PORT}`);
  console.log(`Project root: ${ROOT}`);
});

async function shutdown() {
  server.close();
  await closeBrowser();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
