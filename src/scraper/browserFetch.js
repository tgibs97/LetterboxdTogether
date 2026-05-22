import { chromium } from "playwright-core";
import { existsSync } from "node:fs";

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
  }

  _browser = await chromium.launch(launchOptions);
  _context = await _browser.newContext({
    userAgent:
      process.env.LETTERBOXD_USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  });

  return _context;
}

export async function fetchWithBrowser(url, referer) {
  const context = await getBrowserContext();
  const page = await context.newPage();

  try {
    if (referer) {
      await page.setExtraHTTPHeaders({ Referer: referer });
    }

    // 'networkidle' never fires on CF challenge pages (they keep polling).
    // Use 'domcontentloaded' then poll until the challenge JS finishes and redirects.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    await page
      .waitForFunction(
        () =>
          !/just a moment|cf-browser-verification|challenge-platform/i.test(
            document.title + (document.body?.textContent ?? "")
          ),
        { timeout: 15_000, polling: 500 }
      )
      .catch(() => {});

    return await page.content();
  } finally {
    await page.close();
  }
}

export async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
    _context = null;
  }
}
