# Letterboxd Together

Small local MVP that aggregates Letterboxd diary data for a hardcoded group.

## Run

```powershell
npm.cmd install
npm.cmd start
```

Open `http://127.0.0.1:3000`.

## Optional TMDB Posters

Poster lookup works best with a TMDB API credential. Create a local `.env` file in the project root:

```text
TMDB_API_KEY=your_tmdb_api_key
```

Then start the server:

```powershell
npm.cmd start
```

You can also use `TMDB_BEARER_TOKEN=your_tmdb_read_access_token` instead. `.env` is ignored by Git.

Without a TMDB credential, the app falls back to poster metadata found on Letterboxd film pages.

## Letterboxd 403s

Letterboxd may return Cloudflare 403 pages for paginated or archive diary URLs. The app keeps partial data when that happens. You can try increasing the delay:

```text
LETTERBOXD_REQUEST_DELAY_MS=3000
```

If your browser can open the blocked Letterboxd URL, you can also copy your Letterboxd request cookie into `.env`:

```text
LETTERBOXD_COOKIE=your_full_cookie_header
```

Keep `.env` private.

By default, use all discoverable diary pages:

```text
LETTERBOXD_MAX_DIARY_PAGES=0
```

To avoid blocked page-2 requests entirely, limit diary scraping to the first page:

```text
LETTERBOXD_MAX_DIARY_PAGES=1
```
