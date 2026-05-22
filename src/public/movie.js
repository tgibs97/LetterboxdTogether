const elements = {
  status: document.querySelector("#status"),
  detail: document.querySelector("#movieDetail"),
  pageTitle: document.querySelector("#pageTitle"),
  refreshBtn: document.querySelector("#refreshBtn")
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setStatus(message, isError = false, isLoading = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", isError);
  elements.status.classList.toggle("loading", isLoading && !isError);
}

function slugFromLocation() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("slug")) return params.get("slug");
  const match = window.location.pathname.match(/\/movie\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function formatDate(value) {
  if (!value) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(new Date(`${value}T00:00:00`));
}

function ratingLine(value) {
  if (value == null) return "No rating";
  const rounded = Math.round(value * 4) / 4;
  const full = Math.floor(rounded);
  const frac = rounded - full;
  const fracChar = frac >= 0.625 ? "\u00be" : frac >= 0.375 ? "\u00bd" : frac >= 0.125 ? "\u00bc" : "";
  return `${"\u2605".repeat(full)}${fracChar}`;
}

function posterMarkup(movie) {
  const src = movie.posterUrl || `/api/posters/${encodeURIComponent(movie.slug)}`;
  return `<img class="poster large" src="${escapeHtml(src)}" alt="Poster for ${escapeHtml(movie.title)}" data-poster>`;
}

function renderMovie(movie) {
  document.title = `${movie.title} - Letterboxd Together`;
  elements.pageTitle.textContent = movie.title;

  const details = movie.details || {};
  const meta = [
    movie.releaseDate,
    details.director ? `Directed by ${details.director}` : "",
    details.runtime,
    details.genres?.length ? details.genres.join(", ") : ""
  ].filter(Boolean);

  elements.detail.innerHTML = `
    <section class="detail-hero">
      ${posterMarkup(movie)}
      <div class="detail-copy">
        <h2>${escapeHtml(movie.title)}</h2>
        <p class="meta">${escapeHtml(meta.join(" | ") || "Basic details unavailable.")}</p>
        ${details.description ? `<p>${escapeHtml(details.description)}</p>` : ""}
        <p><a class="film-link" href="${escapeHtml(movie.letterboxdUrl)}" target="_blank" rel="noreferrer">Open on Letterboxd</a></p>
      </div>
    </section>
    <section class="entries">
      ${movie.entries.map(entryMarkup).join("")}
    </section>
  `;
  elements.detail.hidden = false;
  const poster = elements.detail.querySelector("[data-poster]");
  poster?.addEventListener("error", () => {
    const fallback = document.createElement("span");
    fallback.className = "poster large poster-fallback";
    fallback.textContent = "No poster";
    poster.replaceWith(fallback);
  }, { once: true });
}

function entryMarkup(entry) {
  const review = entry.hasReview && entry.reviewText
    ? `<p class="review-text">${escapeHtml(entry.reviewText)}</p>`
    : `<p class="meta">No written review found.</p>`;
  const reviewLink = entry.reviewUrl
    ? `<a class="film-link" href="${escapeHtml(entry.reviewUrl)}" target="_blank" rel="noreferrer">Review page</a>`
    : "";

  return `
    <article class="entry">
      <h3>
        <span>${escapeHtml(entry.username)}</span>
        <span class="meta">${escapeHtml(formatDate(entry.watchedDate))}</span>
        <span class="rating">${escapeHtml(ratingLine(entry.rating))}</span>
      </h3>
      ${review}
      ${reviewLink}
    </article>
  `;
}

async function loadMovie() {
  const slug = slugFromLocation();
  if (!slug) {
    setStatus("No movie slug was provided.", true);
    return;
  }

  setStatus("Loading movie and checking reviews...", false, true);
  try {
    const response = await fetch(`/api/movies/${encodeURIComponent(slug)}`);
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const data = await response.json();
    renderMovie(data.movie);
    elements.status.hidden = true;
    elements.refreshBtn.hidden = false;
  } catch (error) {
    setStatus(`Could not load movie: ${error.message}`, true);
  }
}

async function refreshMovie() {
  const slug = slugFromLocation();
  elements.refreshBtn.disabled = true;
  elements.refreshBtn.textContent = "Refreshing…";
  elements.status.hidden = false;
  setStatus("Re-scraping reviews and details…", false, true);

  try {
    const response = await fetch(`/api/refresh/${encodeURIComponent(slug)}`, { method: "POST" });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const data = await response.json();
    renderMovie(data.movie);
    elements.status.hidden = true;
  } catch (error) {
    setStatus(`Refresh failed: ${error.message}`, true);
  } finally {
    elements.refreshBtn.disabled = false;
    elements.refreshBtn.textContent = "Refresh";
  }
}

elements.refreshBtn.addEventListener("click", refreshMovie);

loadMovie();
