const state = {
  movies: [],
  users: [],
  watchedByFilter: [],
  sortKey: "latestWatchedDate",
  sortDirection: "desc"
};

const elements = {
  body: document.querySelector("#moviesBody"),
  status: document.querySelector("#status"),
  lastRefreshed: document.querySelector("#lastRefreshed"),
  refreshButton: document.querySelector("#refreshButton"),
  refreshModal: document.querySelector("#refreshModal"),
  cancelRefreshButton: document.querySelector("#cancelRefreshButton"),
  confirmRefreshButton: document.querySelector("#confirmRefreshButton"),
  refreshAllUsers: document.querySelector("#refreshAllUsers"),
  refreshUserChoices: document.querySelector("#refreshUserChoices"),
  searchInput: document.querySelector("#searchInput"),
  userFilter: document.querySelector("#userFilter"),
  watchedByFilterButton: document.querySelector("#watchedByFilterButton"),
  watchedByFilterMenu: document.querySelector("#watchedByFilterMenu"),
  watchedByFilterChoices: document.querySelector("#watchedByFilterChoices"),
  clearWatchedByFilter: document.querySelector("#clearWatchedByFilter"),
  sortButtons: document.querySelectorAll(".sort-button")
};

function setStatus(message, isError = false, isLoading = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", isError);
  elements.status.classList.toggle("loading", isLoading && !isError);
}

function formatDate(value) {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(`${value}T00:00:00`));
}

function formatTimestamp(value) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function starsForRating(value) {
  if (value == null) return "No rating";
  const rounded = Math.round(value * 4) / 4;
  const full = Math.floor(rounded);
  const frac = rounded - full;
  const fracChar = frac >= 0.625 ? "\u00be" : frac >= 0.375 ? "\u00bd" : frac >= 0.125 ? "\u00bc" : "";
  return `${"\u2605".repeat(full)}${fracChar}`;
}

function posterCell(movie) {
  const src = movie.posterUrl || `/api/posters/${encodeURIComponent(movie.slug)}`;
  return `<img class="poster" src="${escapeHtml(src)}" alt="Poster for ${escapeHtml(movie.title)}" loading="lazy" data-poster>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function filteredMovies() {
  const query = elements.searchInput.value.trim().toLowerCase();
  const user = elements.userFilter.value;
  const watchedByUsers = state.watchedByFilter;

  return state.movies
    .filter((movie) => !query || movie.title.toLowerCase().includes(query))
    .filter((movie) => !user || movie.watchedBy.includes(user))
    .filter((movie) => watchedByUsers.every((selectedUser) => movie.watchedBy.includes(selectedUser)))
    .sort((a, b) => {
      const direction = state.sortDirection === "asc" ? 1 : -1;
      const aValue = a[state.sortKey];
      const bValue = b[state.sortKey];

      if (state.sortKey === "averageRating") {
        return (((aValue ?? -1) - (bValue ?? -1)) || a.title.localeCompare(b.title)) * direction;
      }

      return String(aValue || "").localeCompare(String(bValue || "")) * direction;
    });
}

function renderUsers() {
  elements.userFilter.innerHTML = '<option value="">Everyone</option>';
  for (const user of state.users) {
    const option = document.createElement("option");
    option.value = user;
    option.textContent = user;
    elements.userFilter.append(option);
  }
  renderRefreshChoices();
  renderWatchedByFilterChoices();
}

function renderRefreshChoices() {
  elements.refreshUserChoices.innerHTML = "";

  for (const user of state.users) {
    const label = document.createElement("label");
    label.className = "check-row";
    label.innerHTML = `
      <input type="checkbox" value="${escapeHtml(user)}" data-refresh-user checked>
      <span>${escapeHtml(user)}</span>
    `;
    elements.refreshUserChoices.append(label);
  }

  updateRefreshPicker();
}

function updateRefreshPicker() {
  const userChecks = [...elements.refreshUserChoices.querySelectorAll("[data-refresh-user]")];
  const refreshAll = elements.refreshAllUsers.checked;

  for (const checkbox of userChecks) {
    checkbox.disabled = refreshAll;
    if (refreshAll) checkbox.checked = true;
  }

  elements.confirmRefreshButton.disabled = !refreshAll && !userChecks.some((checkbox) => checkbox.checked);
}

function selectedRefreshUsers() {
  if (elements.refreshAllUsers.checked) return [...state.users];
  return [...elements.refreshUserChoices.querySelectorAll("[data-refresh-user]:checked")]
    .map((checkbox) => checkbox.value);
}

function renderWatchedByFilterChoices() {
  const validUsers = new Set(state.users);
  state.watchedByFilter = state.watchedByFilter.filter((user) => validUsers.has(user));
  elements.watchedByFilterChoices.innerHTML = "";

  for (const user of state.users) {
    const label = document.createElement("label");
    label.className = "check-row";
    label.innerHTML = `
      <input type="checkbox" value="${escapeHtml(user)}" data-watched-by-filter ${state.watchedByFilter.includes(user) ? "checked" : ""}>
      <span>${escapeHtml(user)}</span>
    `;
    elements.watchedByFilterChoices.append(label);
  }

  updateWatchedByFilterButton();
}

function selectedWatchedByUsers() {
  return [...elements.watchedByFilterChoices.querySelectorAll("[data-watched-by-filter]:checked")]
    .map((checkbox) => checkbox.value);
}

function updateWatchedByFilter() {
  state.watchedByFilter = selectedWatchedByUsers();
  updateWatchedByFilterButton();
  renderMovies();
}

function updateWatchedByFilterButton() {
  const count = state.watchedByFilter.length;
  elements.watchedByFilterButton.textContent = count ? `Watched By (${count})` : "Watched By";
  elements.watchedByFilterButton.classList.toggle("active", count > 0);
}

function toggleWatchedByFilterMenu() {
  const nextOpen = elements.watchedByFilterMenu.hidden;
  elements.watchedByFilterMenu.hidden = !nextOpen;
  elements.watchedByFilterButton.setAttribute("aria-expanded", String(nextOpen));
}

function closeWatchedByFilterMenu() {
  elements.watchedByFilterMenu.hidden = true;
  elements.watchedByFilterButton.setAttribute("aria-expanded", "false");
}

function clearWatchedByFilter() {
  state.watchedByFilter = [];
  for (const checkbox of elements.watchedByFilterChoices.querySelectorAll("[data-watched-by-filter]")) {
    checkbox.checked = false;
  }
  updateWatchedByFilterButton();
  renderMovies();
}

function renderMovies() {
  const movies = filteredMovies();
  elements.body.innerHTML = "";

  if (!movies.length) {
    setStatus(state.movies.length ? "No movies match the current filters." : "No cached movies yet. Run a refresh.");
    return;
  }

  setStatus(`${movies.length} movie${movies.length === 1 ? "" : "s"} shown.`);

  for (const movie of movies) {
    const row = document.createElement("tr");
    row.tabIndex = 0;
    row.dataset.href = `/movie/${encodeURIComponent(movie.slug)}`;
    row.innerHTML = `
      <td>${formatDate(movie.latestWatchedDate)}</td>
      <td>${posterCell(movie)}</td>
      <td><a class="film-link" href="/movie/${encodeURIComponent(movie.slug)}">${escapeHtml(movie.title)}</a></td>
      <td>${escapeHtml(movie.releaseDate || "Unknown")}</td>
      <td><span class="pill-list">${movie.watchedBy.map((user) => `<span class="pill">${escapeHtml(user)}</span>`).join("")}</span></td>
      <td><span class="rating">${escapeHtml(starsForRating(movie.averageRating))}</span></td>
    `;
    row.addEventListener("click", (event) => {
      if (event.target.closest("a")) return;
      window.location.href = row.dataset.href;
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter") window.location.href = row.dataset.href;
    });
    elements.body.append(row);
  }

  for (const image of elements.body.querySelectorAll("[data-poster]")) {
    image.addEventListener("error", () => {
      const fallback = document.createElement("span");
      fallback.className = "poster poster-fallback";
      fallback.setAttribute("aria-label", "No poster");
      fallback.textContent = "No poster";
      image.replaceWith(fallback);
    }, { once: true });
  }
}

async function loadMovies() {
  setStatus("Loading movies...", false, true);
  try {
    const response = await fetch("/api/movies");
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const data = await response.json();
    state.movies = data.movies || [];
    state.users = data.users || [];
    elements.lastRefreshed.textContent = formatTimestamp(data.lastRefreshed);
    renderUsers();
    renderMovies();
    updateSortIndicators();
    if (data.failures?.length) {
      setStatus(`${state.movies.length} movies loaded. ${data.failures.length} scrape failure(s) recorded.`, true);
    }
  } catch (error) {
    setStatus(`Could not load movies: ${error.message}`, true);
  }
}

async function refreshMovies() {
  const users = selectedRefreshUsers();
  if (!users.length) {
    setStatus("Choose at least one user to refresh.", true);
    return;
  }

  closeRefreshModal();
  elements.refreshButton.disabled = true;
  elements.confirmRefreshButton.disabled = true;
  setStatus(`Refreshing ${users.join(", ")} from Letterboxd. This may take a while for full diary history...`, false, true);
  try {
    const response = await fetch("/api/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ users })
    });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const data = await response.json();
    state.movies = data.movies || [];
    state.users = data.users || [];
    elements.lastRefreshed.textContent = formatTimestamp(data.lastRefreshed);
    renderUsers();
    renderMovies();
    if (data.failures?.length) {
      setStatus(`${state.movies.length} movies refreshed. ${data.failures.length} scrape failure(s) recorded.`, true);
    }
  } catch (error) {
    setStatus(`Refresh failed: ${error.message}`, true);
  } finally {
    elements.refreshButton.disabled = false;
    elements.confirmRefreshButton.disabled = false;
  }
}

function openRefreshModal() {
  if (!elements.refreshModal.showModal) {
    if (window.confirm("Refresh Letterboxd data? This can take a while and should not be run frequently because it is resource intensive.")) {
      refreshMovies();
    }
    return;
  }

  updateRefreshPicker();
  elements.refreshModal.showModal();
}

function closeRefreshModal() {
  if (elements.refreshModal.open) {
    elements.refreshModal.close();
  }
}

function updateSortIndicators() {
  for (const button of elements.sortButtons) {
    if (button.dataset.sort === state.sortKey) {
      button.dataset.dir = state.sortDirection;
    } else {
      delete button.dataset.dir;
    }
  }
}

elements.searchInput.addEventListener("input", renderMovies);
elements.userFilter.addEventListener("change", renderMovies);
elements.watchedByFilterButton.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleWatchedByFilterMenu();
});
elements.watchedByFilterChoices.addEventListener("change", updateWatchedByFilter);
elements.clearWatchedByFilter.addEventListener("click", clearWatchedByFilter);
document.addEventListener("click", (event) => {
  if (!event.target.closest(".column-filter")) closeWatchedByFilterMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeWatchedByFilterMenu();
});
elements.refreshButton.addEventListener("click", openRefreshModal);
elements.cancelRefreshButton.addEventListener("click", closeRefreshModal);
elements.confirmRefreshButton.addEventListener("click", refreshMovies);
elements.refreshAllUsers.addEventListener("change", updateRefreshPicker);
elements.refreshUserChoices.addEventListener("change", updateRefreshPicker);
elements.refreshModal.addEventListener("click", (event) => {
  if (event.target === elements.refreshModal) closeRefreshModal();
});
for (const button of elements.sortButtons) {
  button.addEventListener("click", () => {
    const nextKey = button.dataset.sort;
    if (state.sortKey === nextKey) {
      state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
    } else {
      state.sortKey = nextKey;
      state.sortDirection = nextKey === "title" ? "asc" : "desc";
    }
    renderMovies();
    updateSortIndicators();
  });
}

loadMovies();
