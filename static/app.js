const LINE_ORDER = ["RD", "BL", "OR", "SV", "GR", "YL"];
const LINE_NAMES = { RD: "Red", BL: "Blue", OR: "Orange", SV: "Silver", GR: "Green", YL: "Yellow" };
const LINE_WEIGHT = 6;
const DEFAULT_STATION = "A01";
const REFRESH_MS = 30000;
const TRAINS_PER_DIRECTION = 4;

const state = {
  stations: [],       // one entry per physical station (transfer pairs merged)
  byCode: new Map(),  // any station code, including a transfer partner, -> merged station
  selected: null,
  lastUpdated: null,
  requestId: 0,
  tripFrom: null,
  tripTo: null,
  tripFromTouched: false,
};

const els = {
  stationName: document.getElementById("station-name"),
  stationLines: document.getElementById("station-lines"),
  updated: document.getElementById("updated"),
  refresh: document.getElementById("refresh"),
  arrivals: document.getElementById("arrivals"),
  alerts: document.getElementById("alerts"),
  outages: document.getElementById("outages"),
  tripResult: document.getElementById("trip-result"),
  tripSwap: document.getElementById("trip-swap"),
};

// ---------- Helpers ----------

// Create a DOM element with an optional class and text content.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Round colored badge showing a line's code (e.g. RD), used in the station card and arrivals.
function lineBadge(code) {
  const badge = el("span", "line-badge", code);
  badge.dataset.line = code;
  badge.style.setProperty("--line", `var(--${code})`);
  badge.title = (LINE_NAMES[code] || code) + " Line";
  return badge;
}

// Row of small colored dots for a station's lines, used in search results.
function lineDots(lines) {
  const wrap = el("span", "line-badges");
  for (const code of lines) {
    const dot = el("span", "line-dot");
    dot.style.setProperty("--line", `var(--${code})`);
    wrap.appendChild(dot);
  }
  return wrap;
}

// Sort line codes into the standard Red, Blue, Orange, Silver, Green, Yellow order.
function sortLines(lines) {
  return [...lines].sort((a, b) => LINE_ORDER.indexOf(a) - LINE_ORDER.indexOf(b));
}

// Lowercase and strip punctuation/spaces so search matches "lenfant" to "L'Enfant".
function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ---------- Map ----------

const map = L.map("map", { zoomControl: false }).setView([38.9, -77.03], 11);
L.control.zoom({ position: "topright" }).addTo(map);

// Standard OSM tiles; style.css mutes them (and inverts them in dark mode)
// so the line colors stand out
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const lineLayer = L.layerGroup().addTo(map);
const stationLayer = L.layerGroup().addTo(map);
const entranceLayer = L.layerGroup().addTo(map);
let highlight = null;

// Direction-independent key for the track segment between two coordinates.
function segmentKey(a, b) {
  return [a.join(), b.join()].sort().join("|");
}

// Draw every line (side by side where lines share track) and a clickable marker for each station.
async function loadMap() {
  const linesRes = await fetch("/api/lines");
  const lines = await linesRes.json();

  const paths = await Promise.all(
    lines.map(line => fetch("/api/path/" + line.code).then(r => r.json()))
  );

  // Group every station-to-station segment by the lines that run on it.
  // Keys use coordinates so transfer stations (two codes, one spot) match.
  // Offsets are relative to drawing direction, so each line is first turned
  // to travel the same way as lines it shares track with; otherwise the
  // side-by-side order would mirror from one segment to the next.
  const segments = new Map();
  const ordered = lines
    .map((line, i) => ({ line, coords: paths[i].map(s => [s.lat, s.lon]) }))
    .sort((x, y) => LINE_ORDER.indexOf(x.line.code) - LINE_ORDER.indexOf(y.line.code));

  for (let { line, coords } of ordered) {
    let agree = 0;
    for (let j = 0; j < coords.length - 1; j++) {
      const seg = segments.get(segmentKey(coords[j], coords[j + 1]));
      if (seg) agree += seg.coords[0].join() === coords[j].join() ? 1 : -1;
    }
    if (agree < 0) coords = [...coords].reverse();

    for (let j = 0; j < coords.length - 1; j++) {
      const key = segmentKey(coords[j], coords[j + 1]);
      if (!segments.has(key)) segments.set(key, { coords: [coords[j], coords[j + 1]], lines: [] });
      segments.get(key).lines.push(line);
    }
  }

  // Draw shared segments side by side, centered on the track
  for (const { coords, lines: segLines } of segments.values()) {
    segLines.forEach((line, i) => {
      L.polyline(coords, {
        color: line.color,
        weight: LINE_WEIGHT,
        opacity: 0.95,
        lineCap: "butt",
        interactive: false,
        offset: (i - (segLines.length - 1) / 2) * LINE_WEIGHT,
      }).addTo(lineLayer);
    });
  }

  for (const s of state.stations) {
    L.circleMarker([s.lat, s.lon], {
      radius: s.together ? 6.5 : 4.5,
      color: "#1b1d22",
      fillColor: "#fff",
      fillOpacity: 1,
      weight: 2,
    })
      .addTo(stationLayer)
      .bindTooltip(s.name, { direction: "top", offset: [0, -6], className: "station-tooltip" })
      .on("click", () => selectStation(s.code));
  }

  if (state.selected) highlightStation(state.selected, false);
}

// Ring the selected station on the map and move the map to it.
function highlightStation(station, animate) {
  if (highlight) highlight.remove();
  highlight = L.circleMarker([station.lat, station.lon], {
    radius: 10,
    color: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
    fillColor: "#fff",
    fillOpacity: 1,
    weight: 4,
    interactive: false,
  }).addTo(map);

  const target = [station.lat, station.lon];
  if (animate) map.flyTo(target, Math.max(map.getZoom(), 15), { duration: 0.8 });
  else map.setView(target, 14);
}

// Show the selected station's entrances on the map as amber dots with popups.
async function loadEntrances(stationCode) {
  entranceLayer.clearLayers();
  if (!stationCode) return;
  try {
    const response = await fetch("/api/entrances/" + encodeURIComponent(stationCode));
    if (!response.ok) return;
    const entrances = await response.json();
    for (const entrance of entrances) {
      L.circleMarker([entrance.lat, entrance.lon], {
        radius: 5,
        color: "#fff",
        fillColor: "#e6a817",
        fillOpacity: 1,
        weight: 2,
      })
        .addTo(entranceLayer)
        .bindPopup(`<strong>${entrance.name}</strong><br>${entrance.description}`);
    }
  } catch (_) {}
}

// ---------- Stations ----------

// Fetch stations, merge transfer pairs into one station each, and index them by every code.
async function loadStations() {
  const response = await fetch("/api/stations");
  const raw = await response.json();
  const rawByCode = Object.fromEntries(raw.map(s => [s.code, s]));

  // Keep one entry per physical station, with lines from both codes
  state.stations = raw
    .filter(s => !s.together || s.code < s.together)
    .map(s => s.together
      ? { ...s, lines: sortLines([...s.lines, ...rawByCode[s.together].lines]) }
      : { ...s, lines: sortLines(s.lines) });
  state.stations.sort((a, b) => a.name.localeCompare(b.name));

  for (const s of state.stations) {
    state.byCode.set(s.code, s);
    if (s.together) state.byCode.set(s.together, s);
  }
}

// ---------- Search combobox ----------

// Turn a .combo element into an accessible station search box. Calls onSelect
// with the chosen station; returns set/get for the current station.
function createCombo(root, onSelect) {
  const input = root.querySelector(".combo-input");
  const list = root.querySelector(".combo-list");
  const listId = root.id + "-list";
  list.id = listId;
  input.setAttribute("aria-controls", listId);

  let matches = [];
  let active = -1;
  let current = null;

  // Show the results list.
  function open() {
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  // Hide the results list and clear the keyboard highlight.
  function close() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  }

  // Redraw the results list, marking the keyboard-highlighted option.
  function render() {
    list.replaceChildren();
    if (matches.length === 0) {
      list.appendChild(el("li", "combo-empty", "No stations found"));
      return;
    }
    matches.forEach((s, i) => {
      const li = el("li", "combo-option");
      li.id = `${listId}-${i}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === active));
      li.appendChild(el("span", null, s.name));
      li.appendChild(lineDots(s.lines));
      li.addEventListener("mousedown", e => e.preventDefault());
      li.addEventListener("click", () => choose(s));
      list.appendChild(li);
    });
    if (active >= 0) {
      input.setAttribute("aria-activedescendant", `${listId}-${active}`);
      list.children[active].scrollIntoView({ block: "nearest" });
    }
  }

  // Match stations against the typed text, names that start with it first.
  function filter() {
    const q = normalize(input.value);
    matches = q
      ? state.stations
          .filter(s => normalize(s.name).includes(q))
          .sort((a, b) => normalize(b.name).startsWith(q) - normalize(a.name).startsWith(q))
      : state.stations;
    active = q && matches.length ? 0 : -1;
    render();
    open();
  }

  // Pick a station from the list and notify the caller.
  function choose(station) {
    set(station);
    close();
    input.blur();
    onSelect(station);
  }

  // Set the current station and show its name in the input.
  function set(station) {
    current = station;
    input.value = station ? station.name : "";
  }

  input.addEventListener("focus", () => { input.select(); filter(); });
  input.addEventListener("input", filter);
  input.addEventListener("blur", () => { close(); set(current); });
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.hidden) filter();
      if (!matches.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      active = (active + step + matches.length) % matches.length;
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (matches[active]) choose(matches[active]);
    } else if (e.key === "Escape") {
      close();
      set(current);
      input.blur();
    }
  });

  return { set, get: () => current };
}

const stationCombo = createCombo(document.getElementById("station-search"), s => selectStation(s.code));
const tripFromCombo = createCombo(document.getElementById("trip-from"), s => {
  state.tripFrom = s;
  state.tripFromTouched = true;
  loadTrip();
});
const tripToCombo = createCombo(document.getElementById("trip-to"), s => {
  state.tripTo = s;
  loadTrip();
});

// ---------- Selecting a station ----------

// Make a station the current one: update the URL, panel, map, and trip planner,
// then load its arrivals, alerts, and entrances.
function selectStation(code, { pushHistory = true, animate = true } = {}) {
  const station = state.byCode.get(code);
  if (!station) return;
  const changed = state.selected !== station;
  state.selected = station;

  if (pushHistory && location.hash !== "#" + station.code) {
    history.pushState(null, "", "#" + station.code);
  }
  try { localStorage.setItem("station", station.code); } catch (_) {}

  stationCombo.set(null);
  els.stationName.textContent = station.name;
  els.stationLines.replaceChildren(...station.lines.map(lineBadge));
  document.title = station.name + " · Metro Arrivals";

  if (!state.tripFromTouched) {
    state.tripFrom = station;
    tripFromCombo.set(station);
    loadTrip();
  }

  if (stationLayer.getLayers().length) highlightStation(station, animate);
  loadEntrances(station.code);

  if (changed) {
    state.lastUpdated = null;
    renderSkeleton();
    resetNotices();
  }
  refresh();
}

window.addEventListener("popstate", () => {
  const code = location.hash.slice(1).toUpperCase();
  if (code) selectStation(code, { pushHistory: false });
});

// ---------- Arrivals ----------

// Show placeholder rows while a newly selected station's arrivals load.
function renderSkeleton() {
  const box = el("div", "direction");
  box.appendChild(el("div", "direction-title", "Loading arrivals"));
  for (let i = 0; i < 3; i++) {
    const row = el("div", "train");
    const badge = el("span", "line-badge");
    badge.style.background = "var(--surface-2)";
    row.append(badge, el("div", "skeleton"), el("div", "skeleton"));
    row.lastChild.style.width = "40px";
    box.appendChild(row);
  }
  els.arrivals.replaceChildren(box);
}

// Build the right-hand cell of an arrival row: Boarding, Arriving, or minutes away.
function minutesCell(train) {
  const cell = el("div", "train-min");
  if (train.boarding) {
    cell.classList.add("now");
    cell.textContent = "Boarding";
  } else if (train.minutes === 0) {
    cell.classList.add("now");
    cell.textContent = "Arriving";
  } else if (train.minutes === null) {
    cell.textContent = "—";
  } else {
    cell.textContent = train.minutes;
    cell.appendChild(el("small", null, "min"));
  }
  return cell;
}

// Render arrivals as one box per direction, up to TRAINS_PER_DIRECTION trains each.
function renderArrivals(trains) {
  // Skip non-passenger moves and trains without a line
  trains = trains.filter(t => LINE_NAMES[t.line]);

  if (trains.length === 0) {
    els.arrivals.replaceChildren(el("div", "state-box", "No trains predicted right now."));
    return;
  }

  // One box per platform track (direction), in a stable order
  const groups = new Map();
  for (const t of trains) {
    if (!groups.has(t.group)) groups.set(t.group, []);
    groups.get(t.group).push(t);
  }

  const boxes = [...groups.keys()].sort().map(key => {
    const list = groups.get(key).slice(0, TRAINS_PER_DIRECTION);
    const destinations = [...new Set(groups.get(key).map(t => t.destination))];
    const box = el("div", "direction");
    box.appendChild(el("div", "direction-title", "To " + destinations.join(" / ")));
    for (const t of list) {
      const row = el("div", "train");
      const dest = el("div", "train-dest", t.destination);
      if (t.cars) dest.appendChild(el("span", "train-cars", t.cars + " cars"));
      row.append(lineBadge(t.line), dest, minutesCell(t));
      box.appendChild(row);
    }
    return box;
  });

  els.arrivals.replaceChildren(...boxes);
}

// Show an error in the arrivals area, unless older data is already on screen.
function renderArrivalsError(message) {
  // Keep the last good data on screen if we have it
  if (state.lastUpdated) return;
  els.arrivals.replaceChildren(el("div", "state-box error", "Couldn't load arrivals. " + message));
}

// ---------- Alerts & outages ----------

// Clear the alert and outage rows and show their "Checking…" state.
function resetNotices() {
  for (const box of [els.alerts, els.outages]) {
    box.classList.remove("has-items");
    box.open = false;
    box.querySelector(".notice-body").replaceChildren();
  }
  els.alerts.querySelector(".notice-text").textContent = "Checking rail alerts…";
  els.outages.querySelector(".notice-text").textContent = "Checking elevators & escalators…";
}

// Fill an alert/outage row: a muted message when empty, or an expandable amber summary.
function renderNotice(box, items, emptyText, label) {
  const body = box.querySelector(".notice-body");
  const text = box.querySelector(".notice-text");
  body.replaceChildren();
  box.classList.toggle("has-items", items.length > 0);
  if (items.length === 0) {
    box.open = false;
    text.textContent = emptyText;
    return;
  }
  text.textContent = label(items.length);
  for (const item of items) {
    const div = el("div", "notice-item", item.text);
    if (item.meta) div.appendChild(el("div", "notice-meta", item.meta));
    body.appendChild(div);
  }
}

// Keep "No alerts" rows closed
for (const box of [document.getElementById("alerts"), document.getElementById("outages")]) {
  box.addEventListener("toggle", () => {
    if (box.open && !box.classList.contains("has-items")) box.open = false;
  });
}

// Load rail alerts for the station's lines and its elevator/escalator outages.
async function loadNotices(station) {
  try {
    const [incRes, elevRes] = await Promise.all([
      fetch("/api/incidents"),
      fetch("/api/elevators/" + encodeURIComponent(station.code)),
    ]);
    const incidents = await incRes.json();
    const elevators = await elevRes.json();
    if (state.selected !== station) return;

    const relevant = incidents.filter(i => i.lines_affected.some(l => station.lines.includes(l)));
    renderNotice(
      els.alerts,
      relevant.map(i => ({ text: i.description })),
      "No rail alerts for these lines",
      n => n === 1 ? "1 rail alert" : `${n} rail alerts`,
    );
    renderNotice(
      els.outages,
      elevators.map(e => ({
        text: e.location_description + " — " + e.symptom_description,
        meta: "Out of service since " + new Date(e.date_updated).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      })),
      "All elevators & escalators working",
      n => n === 1 ? "1 elevator/escalator outage" : `${n} elevator/escalator outages`,
    );
  } catch (_) {}
}

// ---------- Refresh loop ----------

// Reload arrivals and notices for the current station, ignoring responses for a
// station that is no longer selected.
async function refresh() {
  const station = state.selected;
  if (!station) return;
  const id = ++state.requestId;
  els.refresh.classList.add("spinning");

  try {
    const response = await fetch("/api/trains/" + encodeURIComponent(station.code));
    if (!response.ok) throw new Error("Server returned " + response.status + ".");
    const trains = await response.json();
    if (id !== state.requestId) return;
    renderArrivals(trains);
    state.lastUpdated = Date.now();
    renderUpdated();
  } catch (error) {
    if (id === state.requestId) renderArrivalsError(error.message);
  } finally {
    if (id === state.requestId) els.refresh.classList.remove("spinning");
  }

  loadNotices(station);
}

// Update the "Updated Xs ago" text in the station card.
function renderUpdated() {
  if (!state.lastUpdated) {
    els.updated.textContent = "";
    return;
  }
  const seconds = Math.round((Date.now() - state.lastUpdated) / 1000);
  els.updated.textContent = seconds < 5 ? "Just now" : seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
}

els.refresh.addEventListener("click", refresh);
setInterval(renderUpdated, 1000);

setInterval(() => {
  if (!document.hidden) refresh();
}, REFRESH_MS);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.lastUpdated && Date.now() - state.lastUpdated > REFRESH_MS) refresh();
});

// ---------- Trip planner ----------

// Show travel time and fares for the trip planner's From and To stations.
async function loadTrip() {
  const { tripFrom: from, tripTo: to } = state;
  if (!from || !to) {
    els.tripResult.replaceChildren(el("p", "trip-hint", "Pick a destination to see travel time and fares."));
    return;
  }
  if (from === to) {
    els.tripResult.replaceChildren(el("p", "trip-hint", "Choose two different stations."));
    return;
  }

  els.tripResult.replaceChildren(el("p", "trip-hint", "Loading…"));
  try {
    const response = await fetch(`/api/trip/${encodeURIComponent(from.code)}/${encodeURIComponent(to.code)}`);
    if (!response.ok) throw new Error("Server returned " + response.status);
    const trip = await response.json();
    if (state.tripFrom !== from || state.tripTo !== to) return;

    const stats = el("div", "trip-stats");
    for (const [label, value] of [
      ["Travel time", trip.rail_time + " min"],
      ["Peak fare", "$" + trip.peak_fare.toFixed(2)],
      ["Off-peak fare", "$" + trip.off_peak_fare.toFixed(2)],
      ["Senior / disabled", "$" + trip.senior_fare.toFixed(2)],
    ]) {
      const tile = el("div", "trip-stat");
      tile.append(el("div", "label", label), el("div", "value", value));
      stats.appendChild(tile);
    }
    els.tripResult.replaceChildren(stats);
  } catch (error) {
    els.tripResult.replaceChildren(el("p", "trip-hint", "Couldn't load trip: " + error.message));
  }
}

els.tripSwap.addEventListener("click", () => {
  [state.tripFrom, state.tripTo] = [state.tripTo, state.tripFrom];
  state.tripFromTouched = true;
  tripFromCombo.set(state.tripFrom);
  tripToCombo.set(state.tripTo);
  loadTrip();
});

// ---------- Startup ----------

// Pick the startup station: URL hash, then the last station visited, then Metro Center.
function initialStation() {
  const fromHash = location.hash.slice(1).toUpperCase();
  if (state.byCode.has(fromHash)) return fromHash;
  try {
    const saved = localStorage.getItem("station");
    if (state.byCode.has(saved)) return saved;
  } catch (_) {}
  return DEFAULT_STATION;
}

loadStations().then(async () => {
  const code = state.byCode.get(initialStation()).code;
  history.replaceState(null, "", "#" + code);
  selectStation(code, { pushHistory: false, animate: false });
  await loadMap();
});
