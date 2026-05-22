const TMDB_API_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";
const POSTER_SIZE = "w342";

function tmdbCredentials() {
  return {
    apiKey: process.env.TMDB_API_KEY || "",
    bearerToken: process.env.TMDB_BEARER_TOKEN || process.env.TMDB_ACCESS_TOKEN || ""
  };
}

function authHeaders() {
  const { bearerToken } = tmdbCredentials();
  return bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {};
}

function hasCredentials() {
  const { apiKey, bearerToken } = tmdbCredentials();
  return Boolean(apiKey || bearerToken);
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function releaseYear(value) {
  return String(value || "").match(/\b(18|19|20)\d{2}\b/)?.[0] || "";
}

function scoreResult(result, title, year) {
  let score = 0;
  const wantedTitle = normalizeTitle(title);
  const resultTitle = normalizeTitle(result.title || result.original_title);
  const resultYear = releaseYear(result.release_date);

  if (resultTitle === wantedTitle) score += 10;
  if (resultYear && year && resultYear === year) score += 8;
  if (result.poster_path) score += 4;
  score += Math.min(Number(result.popularity || 0), 50) / 50;

  return score;
}

export function tmdbPosterUrl(path) {
  if (!path) return "";
  return `${TMDB_IMAGE_BASE}/${POSTER_SIZE}${path}`;
}

export async function findTmdbPoster(movie) {
  if (!hasCredentials() || !movie?.title) return null;

  const { apiKey } = tmdbCredentials();
  const year = releaseYear(movie.releaseDate);
  const url = new URL(`${TMDB_API_BASE}/search/movie`);
  url.searchParams.set("query", movie.title);
  url.searchParams.set("include_adult", "false");
  url.searchParams.set("language", "en-US");
  if (year) url.searchParams.set("year", year);
  if (apiKey) url.searchParams.set("api_key", apiKey);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...authHeaders()
    }
  });

  if (!response.ok) {
    throw new Error(`TMDB search failed with ${response.status}`);
  }

  const data = await response.json();
  const results = Array.isArray(data.results) ? data.results : [];
  const best = results
    .filter((result) => result.poster_path)
    .sort((a, b) => scoreResult(b, movie.title, year) - scoreResult(a, movie.title, year))[0];

  if (!best?.poster_path) return null;

  return {
    tmdbId: best.id,
    posterUrl: tmdbPosterUrl(best.poster_path),
    posterPath: best.poster_path,
    releaseDate: best.release_date || "",
    title: best.title || best.original_title || movie.title
  };
}
