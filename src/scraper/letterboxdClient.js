import { fetchWithBrowser } from "./browserFetch.js";

const BASE_URL = "https://letterboxd.com";
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

let lastRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function absoluteUrl(pathOrUrl) {
  return new URL(pathOrUrl, BASE_URL).toString();
}

export async function politeDelay() {
  const requestDelayMs = Number(process.env.LETTERBOXD_REQUEST_DELAY_MS || 1600);
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < requestDelayMs) {
    await sleep(requestDelayMs - elapsed);
  }
  lastRequestAt = Date.now();
}

function requestHeaders(referer) {
  const ua = process.env.LETTERBOXD_USER_AGENT || DEFAULT_USER_AGENT;
  const headers = {
    "User-Agent": ua,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Referer: referer || BASE_URL,
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": referer ? "same-origin" : "none",
    "Sec-Fetch-User": "?1",
    "Sec-Ch-Ua": '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    Connection: "keep-alive"
  };

  if (process.env.LETTERBOXD_COOKIE) {
    headers.Cookie = process.env.LETTERBOXD_COOKIE;
  }

  return headers;
}

export async function fetchLetterboxd(pathOrUrl, referer) {
  const url = absoluteUrl(pathOrUrl);
  let response;
  let html = "";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await politeDelay();

    response = await fetch(url, {
      headers: requestHeaders(referer)
    });
    html = await response.text();

    if (response.ok || !RETRY_STATUSES.has(response.status) || attempt === 1) {
      break;
    }

    await sleep(3000);
  }

  if (!response.ok) {
    const isChallenge = /Just a moment|cf-browser-verification|challenge-platform/i.test(html);

    if (isChallenge) {
      console.warn(`[cf-challenge] Falling back to browser fetch for ${url}`);
      try {
        const browserHtml = await fetchWithBrowser(url, referer);
        return { url, html: browserHtml };
      } catch (browserError) {
        console.error(`[cf-challenge] Browser fetch also failed: ${browserError.message}`);
      }
    }

    const reason = isChallenge ? "Cloudflare challenge/anti-bot page" : `HTTP ${response.status}`;
    const error = new Error(`Letterboxd request failed with ${response.status} (${reason})`);
    error.status = response.status;
    error.url = url;
    error.isChallenge = isChallenge;
    throw error;
  }

  return {
    url,
    html
  };
}

export function logScrapeFailure(context, error) {
  const message = error?.message || String(error);
  const url = error?.url ? ` url=${error.url}` : "";
  console.error(`[scrape:${context}] ${message}${url}`);
}
