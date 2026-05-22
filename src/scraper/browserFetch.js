import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { createLogger } from "../logger.js";

const log = createLogger("browser");

const CHROME_PATHS = [
  process.env.CHROME_EXECUTABLE_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_PATHS) {
    if (existsSync(p)) return p;
  }
  return null;
}

let _browser = null;
let _context = null;

async function getBrowserContext() {
  if (_browser?.isConnected() && _context) return _context;

  const launchOptions = {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  };

  const executablePath = findChrome();
  if (executablePath) {
    launchOptions.executablePath = executablePath;
    log.info(`launching Chromium at ${executablePath}`);
  } else {
    log.warn("no Chrome/Chromium binary found — browser fallback will fail if needed");
  }

  log.info("starting browser...");
  _browser = await chromium.launch(launchOptions);
  _context = await _browser.newContext({
    userAgent:
      process.env.LETTERBOXD_USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  });
  log.info("browser ready");

  return _context;
}

export async function fetchWithBrowser(url, referer) {
  const done = log.timer(`browser fetch ${url}`);
  log.info(`navigating to ${url}`);
  const context = await getBrowserContext();
  const page = await context.newPage();

  try {
    if (referer) {
      await page.setExtraHTTPHeaders({ Referer: referer });
    }

    // 'networkidle' never fires on CF challenge pages (they keep polling).
    // Use 'domcontentloaded' then poll until the challenge JS finishes and redirects.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    const resolved = await page
      .waitForFunction(
        () =>
          !/just a moment|cf-browser-verification|challenge-platform/i.test(
            document.title + (document.body?.textContent ?? "")
          ),
        { timeout: 15_000, polling: 500 }
      )
      .then(() => true)
      .catch(() => false);

    if (!resolved) {
      log.warn(`CF challenge did not clear within 15s for ${url}`);
    } else {
      log.info(`CF challenge cleared for ${url}`);
    }

    const html = await page.content();
    done();
    return html;
  } finally {
    await page.close();
  }
}

export async function closeBrowser() {
  if (_browser) {
    log.info("closing browser");
    await _browser.close().catch(() => {});
    _browser = null;
    _context = null;
    log.info("browser closed");
  }
}
