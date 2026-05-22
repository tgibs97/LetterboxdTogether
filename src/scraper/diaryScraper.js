import * as cheerio from "cheerio";
import { absoluteUrl, fetchLetterboxd, logScrapeFailure } from "./letterboxdClient.js";
import { createLogger } from "../logger.js";
import {
  buildWatchedDate,
  isLikelyDirectImageUrl,
  normalizePosterUrl,
  parseMonthYear,
  parseRating,
  slugFromFilmUrl,
  text
} from "./normalizers.js";

const DIARY_ROW_SELECTORS = [
  "tr.diary-entry-row",
  "tr.js-watch-entry-row",
  "tbody tr:has(a[href*='/film/'])"
];

function firstAttr($, element, selectors, attr) {
  for (const selector of selectors) {
    const value = $(element).find(selector).first().attr(attr);
    if (value) return value;
  }
  return "";
}

function findPosterUrl($, row) {
  const srcset = firstAttr($, row, ["img"], "srcset");
  if (srcset) {
    const candidate = srcset
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean)
      .pop();
    if (isLikelyDirectImageUrl(candidate)) return normalizePosterUrl(candidate);
  }

  const inlineImage = normalizePosterUrl(firstAttr($, row, ["img"], "src"));
  if (isLikelyDirectImageUrl(inlineImage)) return inlineImage;

  const dataImage = normalizePosterUrl(firstAttr($, row, [".film-poster"], "data-image-url"));
  if (isLikelyDirectImageUrl(dataImage)) return dataImage;

  return "";
}

function extractRows($) {
  for (const selector of DIARY_ROW_SELECTORS) {
    const rows = $(selector).toArray();
    if (rows.length) return rows;
  }
  return [];
}

function extractNextPage($, currentUrl) {
  const nextHref =
    $("a.next").attr("href") ||
    $("a[rel='next']").attr("href") ||
    $(".paginate-nextprev a:contains('Next')").attr("href") ||
    $("a:contains('Next')").filter((_, link) => /page\/\d+/.test($(link).attr("href") || "")).attr("href");

  if (!nextHref) return "";
  const nextUrl = absoluteUrl(nextHref);
  return nextUrl === currentUrl ? "" : nextUrl;
}

function extractEntry($, row, username, currentMonthYear) {
  const $row = $(row);
  const poster = $row.find(".film-poster").first();
  const posterData = $row.find("[data-item-slug],[data-film-slug]").first();
  const filmLink = $row
    .find("a[href*='/film/']")
    .filter((_, link) => !/\/poster\//.test($(link).attr("href") || ""))
    .first();
  const href =
    filmLink.attr("href") ||
    posterData.attr("data-target-link") ||
    poster.attr("data-target-link") ||
    "";
  const slug =
    posterData.attr("data-item-slug") ||
    posterData.attr("data-film-slug") ||
    poster.attr("data-film-slug") ||
    slugFromFilmUrl(href);
  const title =
    text(posterData.attr("data-item-name")?.replace(/\s+\((18|19|20)\d{2}\)$/, "")) ||
    text(poster.attr("data-film-name")) ||
    text(filmLink.attr("title")) ||
    text(filmLink.text()) ||
    text($row.find("h2,h3,.film-title").first().text());

  const releaseDate =
    text($row.find(".td-released a").first().text()) ||
    text($row.find("td").eq(3).text()).match(/\b(18|19|20)\d{2}\b/)?.[0] ||
    "";

  const day =
    text($row.find(".td-calendar-day a").first().text()) ||
    text($row.find(".td-day a").first().text()) ||
    text($row.find(".daydate").first().text()) ||
    text($row.find(".col-daydate").first().text()).match(/\b\d{1,2}\b/)?.[0] ||
    text($row.find("td").eq(1).text()).match(/\b\d{1,2}\b/)?.[0] ||
    "";
  const watchedDate = buildWatchedDate(
    currentMonthYear.year,
    currentMonthYear.month,
    day
  );

  const rating =
    parseRating($row.find(".rating").first().text()) ||
    parseRating($row.find(".td-rating").first().text()) ||
    parseRating($row.text());

  const reviewLink = $row
    .find("a")
    .filter((_, link) => /review/i.test(text($(link).text())))
    .first();

  if (!slug || !title || !watchedDate) return null;

  const hasReview = Boolean(reviewLink.length);

  return {
    username,
    slug,
    title,
    releaseDate,
    posterUrl: findPosterUrl($, row),
    watchedDate,
    rating,
    reviewUrl: reviewLink.attr("href") ? absoluteUrl(reviewLink.attr("href")) : "",
    viewingNumber: null,
    hasReview,
    reviewText: "",
    reviewChecked: !hasReview
  };
}

export function parseDiaryPage(html, username, url) {
  const $ = cheerio.load(html);
  const entries = [];
  let currentMonthYear = { month: "", year: "" };

  for (const row of extractRows($)) {
    const rowMonthYear =
      text($(row).find(".td-calendar-month").text()) ||
      text($(row).find(".td-month").text()) ||
      text($(row).find(".monthdate").text()) ||
      text($(row).find(".col-monthdate").text()) ||
      text($(row).find("td").first().text()).match(/[A-Za-z]{3,9}\s+(19|20)\d{2}/)?.[0] ||
      "";

    if (rowMonthYear) {
      const parsed = parseMonthYear(rowMonthYear);
      currentMonthYear = {
        month: parsed.month || currentMonthYear.month,
        year: parsed.year || currentMonthYear.year
      };
    }

    const entry = extractEntry($, row, username, currentMonthYear);
    if (entry) entries.push(entry);
  }

  return {
    entries,
    nextUrl: extractNextPage($, url)
  };
}

export async function scrapeDiary(username) {
  const log = createLogger(`diary:${username}`);
  const entries = [];
  const failures = [];
  const visited = new Set();
  const maxPages = Number(process.env.LETTERBOXD_MAX_DIARY_PAGES || 0);
  let nextUrl = absoluteUrl(`/${username}/diary/`);
  let referer;

  log.info(`starting diary scrape${maxPages ? ` (max ${maxPages} pages)` : ""}`);
  const done = log.timer(`diary scrape for ${username}`);

  while (nextUrl && !visited.has(nextUrl)) {
    visited.add(nextUrl);
    const pageNum = visited.size;
    log.info(`fetching page ${pageNum}${maxPages ? `/${maxPages}` : ""} — ${nextUrl}`);

    try {
      const { html, url } = await fetchLetterboxd(nextUrl, referer);
      referer = url;
      const parsed = parseDiaryPage(html, username, url);
      entries.push(...parsed.entries);

      log.info(`page ${pageNum}: found ${parsed.entries.length} entries (running total: ${entries.length})`);

      if (maxPages && visited.size >= maxPages) {
        log.info(`reached max page limit (${maxPages}) — stopping`);
        nextUrl = "";
      } else {
        nextUrl = parsed.nextUrl;
        if (!nextUrl) {
          log.info("no next page — diary complete");
        }
      }
    } catch (error) {
      logScrapeFailure(`diary:${username}`, error);
      failures.push({
        username,
        url: nextUrl,
        message: error?.message || String(error)
      });
      break;
    }
  }

  done();
  log.info(`finished: ${entries.length} entries across ${visited.size} page(s), ${failures.length} failure(s)`);
  return { entries, failures };
}
