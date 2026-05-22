import * as cheerio from "cheerio";
import { absoluteUrl, fetchLetterboxd, logScrapeFailure } from "./letterboxdClient.js";
import { normalizePosterUrl, slugFromFilmUrl, text } from "./normalizers.js";

const MAX_VIEWING_ATTEMPTS = 10;

function cleanReviewText(raw) {
  return raw
    .replace(/This review may contain spoilers\.(\s*I can handle the truth\.?)?\s*/gi, "")
    .replace(/^[\w\s]+['’]s review published on Letterboxd:\s*/i, "")
    .trim();
}

function extractReviewText($) {
  const selectors = [
    ".body-text.-prose",
    ".review .body-text",
    ".review .body-text p",
    ".js-review-body",
    ".review .content-wrap"
  ];

  for (const selector of selectors) {
    const value = text($(selector).first().text());
    if (value) return cleanReviewText(value);
  }

  return "";
}

function extractWatchedDate($) {
  const dateHref = $("a[href*='/films/diary/for/']").first().attr("href") || "";
  const match = dateHref.match(/for\/(\d{4})\/(\d{2})\/(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;

  return "";
}

function extractRuntime($) {
  const runtimeText = text($("p.text-link, .runtime, [class*='runtime']").text());
  return runtimeText.match(/\b\d+\s*mins?\b/i)?.[0] || "";
}

function reviewMatches($, expectedSlug, expectedWatchedDate) {
  const canonical =
    $("link[rel='canonical']").attr("href") ||
    $("meta[property='og:url']").attr("content") ||
    "";
  const pageSlug = slugFromFilmUrl(canonical) || slugFromFilmUrl($("a[href*='/film/']").first().attr("href"));
  if (pageSlug && pageSlug !== expectedSlug) return false;

  const watchedDate = extractWatchedDate($);
  if (watchedDate && expectedWatchedDate && watchedDate !== expectedWatchedDate) {
    return false;
  }

  return true;
}

export async function scrapeReviewForEntry(entry) {
  const candidates = [];
  if (entry.reviewUrl) {
    candidates.push({
      url: absoluteUrl(entry.reviewUrl),
      viewingNumber: entry.viewingNumber ?? null
    });
  }
  for (let viewingNumber = 0; viewingNumber < MAX_VIEWING_ATTEMPTS; viewingNumber += 1) {
    candidates.push({
      url: absoluteUrl(`/${entry.username}/film/${entry.slug}/${viewingNumber}/`),
      viewingNumber
    });
  }

  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);

    try {
      const { html } = await fetchLetterboxd(candidate.url);
      const $ = cheerio.load(html);

      if (!reviewMatches($, entry.slug, entry.watchedDate)) continue;

      const reviewText = extractReviewText($);
      return {
        ...entry,
        reviewUrl: candidate.url,
        viewingNumber: candidate.viewingNumber,
        hasReview: Boolean(reviewText),
        reviewText: reviewText || "",
        reviewChecked: true
      };
    } catch (error) {
      if (error?.status === 403 || error?.status === 404) continue;
      logScrapeFailure(`review:${entry.username}:${entry.slug}`, error);
      break;
    }
  }

  return {
    ...entry,
    reviewUrl: entry.reviewUrl || "",
    viewingNumber: entry.viewingNumber ?? null,
    hasReview: Boolean(entry.reviewText),
    reviewText: entry.reviewText || "",
    reviewChecked: true
  };
}

export async function scrapeMovieDetails(slug) {
  try {
    const { html } = await fetchLetterboxd(`/film/${slug}/`);
    const $ = cheerio.load(html);

    const director = text(
      $("#tab-crew a[href*='/director/']").first().text() ||
        $("a[href*='/director/']").first().text()
    );
    const runtime = extractRuntime($);
    const genres = $("a[href*='/films/genre/']")
      .map((_, element) => text($(element).text()))
      .get()
      .filter(Boolean);
    const description = text(
      $("meta[name='description']").attr("content") ||
        $(".truncate .body-text").first().text()
    );
    const posterUrl = normalizePosterUrl(
      $("meta[property='og:image']").attr("content") || $("img").first().attr("src")
    );

    return {
      director,
      runtime,
      genres: [...new Set(genres)],
      description,
      posterUrl
    };
  } catch (error) {
    logScrapeFailure(`movie:${slug}`, error);
    return {};
  }
}
