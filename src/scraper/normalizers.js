const MONTHS = {
  jan: "01",
  january: "01",
  feb: "02",
  february: "02",
  mar: "03",
  march: "03",
  apr: "04",
  april: "04",
  may: "05",
  jun: "06",
  june: "06",
  jul: "07",
  july: "07",
  aug: "08",
  august: "08",
  sep: "09",
  sept: "09",
  september: "09",
  oct: "10",
  october: "10",
  nov: "11",
  november: "11",
  dec: "12",
  december: "12"
};

export function text(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function slugFromFilmUrl(href) {
  const match = String(href || "").match(/\/film\/([^/]+)\/?/);
  return match?.[1] || "";
}

export function normalizePosterUrl(url) {
  if (!url) return "";
  const cleaned = String(url).trim();
  if (!cleaned || cleaned.startsWith("data:")) return "";
  if (cleaned.startsWith("/")) return `https://letterboxd.com${cleaned}`;
  return cleaned.startsWith("//") ? `https:${cleaned}` : cleaned;
}

export function isLikelyDirectImageUrl(url) {
  const value = String(url || "");
  if (!value) return false;
  if (/empty-poster/i.test(value)) return false;
  if (/letterboxd\.com\/film\/[^/]+\/image-\d+\/?$/i.test(value)) return false;
  return /\.(avif|webp|jpe?g|png)(\?|#|$)/i.test(value) || /(^|\.)ltrbxd\.com\//i.test(value);
}

export function parseRating(raw) {
  const value = text(raw);
  if (!value) return null;
  let rating = 0;
  for (const char of value) {
    if (char === "\u2605") rating += 1;
    if (char === "\u00bd") rating += 0.5;
  }
  return rating || null;
}

export function formatRating(rating) {
  if (rating == null || Number.isNaN(rating)) return "No rating";
  return Number(rating).toFixed(Number.isInteger(rating) ? 0 : 1);
}

export function starsForRating(rating) {
  if (rating == null || Number.isNaN(rating)) return "";
  const full = Math.floor(rating);
  const half = rating % 1 >= 0.5;
  return `${"\u2605".repeat(full)}${half ? "\u00bd" : ""}`;
}

export function parseMonthYear(raw) {
  const value = text(raw).toLowerCase();
  const monthName = Object.keys(MONTHS).find((month) =>
    new RegExp(`\\b${month}\\b`, "i").test(value)
  );
  const year = value.match(/\b(19|20)\d{2}\b/)?.[0] || "";
  return {
    month: monthName ? MONTHS[monthName] : "",
    year
  };
}

export function buildWatchedDate(year, month, day) {
  const cleanDay = String(day || "").match(/\d{1,2}/)?.[0] || "";
  if (!year || !month || !cleanDay) return "";
  return `${year}-${month}-${cleanDay.padStart(2, "0")}`;
}

export function compareDatesDesc(a, b) {
  return String(b || "").localeCompare(String(a || ""));
}

export function mergeEntriesIntoMovies(entries) {
  const moviesBySlug = {};

  for (const entry of entries) {
    if (!entry.slug) continue;

    if (!moviesBySlug[entry.slug]) {
      moviesBySlug[entry.slug] = {
        slug: entry.slug,
        title: entry.title,
        releaseDate: entry.releaseDate,
        posterUrl: entry.posterUrl,
        letterboxdUrl: `https://letterboxd.com/film/${entry.slug}/`,
        latestWatchedDate: entry.watchedDate,
        watchedBy: [],
        averageRating: null,
        details: {},
        entries: []
      };
    }

    const movie = moviesBySlug[entry.slug];
    if (!movie.posterUrl && entry.posterUrl) movie.posterUrl = entry.posterUrl;
    if (!movie.releaseDate && entry.releaseDate) movie.releaseDate = entry.releaseDate;
    if (!movie.title && entry.title) movie.title = entry.title;

    movie.entries.push(entry);
    movie.entries.sort((a, b) => compareDatesDesc(a.watchedDate, b.watchedDate));
    movie.latestWatchedDate = movie.entries[0]?.watchedDate || "";
    movie.watchedBy = [...new Set(movie.entries.map((item) => item.username))].sort();

    const ratings = movie.entries
      .map((item) => item.rating)
      .filter((rating) => typeof rating === "number" && !Number.isNaN(rating));
    movie.averageRating = ratings.length
      ? Number((ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length).toFixed(2))
      : null;
  }

  return moviesBySlug;
}
