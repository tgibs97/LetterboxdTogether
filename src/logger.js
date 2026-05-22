/**
 * Lightweight logger — no external dependencies.
 *
 * Levels (lowest → highest): debug < info < warn < error
 * Set LOG_LEVEL env var to control the minimum level printed (default: "info").
 *
 * Every line is prefixed with a UTC timestamp and a [tag] so you can grep by
 * component even when multiple scrapes are running concurrently.
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function minLevel() {
  const raw = (process.env.LOG_LEVEL || "info").toLowerCase();
  return LEVELS[raw] ?? LEVELS.info;
}

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}

function write(level, tag, parts) {
  if (LEVELS[level] < minLevel()) return;
  const prefix = `${ts()} [${level.toUpperCase().padEnd(5)}] [${tag}]`;
  const line = parts.map((p) => (typeof p === "object" ? JSON.stringify(p) : String(p))).join(" ");
  const out = `${prefix} ${line}`;
  if (level === "error") {
    console.error(out);
  } else if (level === "warn") {
    console.warn(out);
  } else {
    console.log(out);
  }
}

/**
 * Create a tagged logger.
 * Usage:
 *   const log = createLogger("server");
 *   log.info("listening on", port);
 *   log.debug("cache hit", slug);
 */
export function createLogger(tag) {
  return {
    debug: (...args) => write("debug", tag, args),
    info:  (...args) => write("info",  tag, args),
    warn:  (...args) => write("warn",  tag, args),
    error: (...args) => write("error", tag, args),
    /** Returns a function that logs at info level and appends elapsed time. */
    timer(label) {
      const start = Date.now();
      return () => write("info", tag, [`${label} — done in ${Date.now() - start}ms`]);
    }
  };
}
