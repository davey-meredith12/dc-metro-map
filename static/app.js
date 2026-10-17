const form = document.getElementById("station-form");
const stationInput = document.getElementById("station");
const message = document.getElementById("message");
const tbody = document.getElementById("train-rows");
const incidentList = document.getElementById("incident-list");
const elevatorList = document.getElementById("elevator-list");
const tripForm = document.getElementById("trip-form");
const tripFrom = document.getElementById("trip-from");
const tripTo = document.getElementById("trip-to");
const tripResult = document.getElementById("trip-result");

const LINE_ORDER = ["RD", "BL", "OR", "SV", "GR", "YL"];
const LINE_NAMES = { RD: "Red", BL: "Blue", OR: "Orange", SV: "Silver", GR: "Green", YL: "Yellow" };
const LINE_WEIGHT = 6;

const map = L.map("map").setView([38.9, -77.03], 11);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const entranceLayer = L.layerGroup().addTo(map);

function segmentKey(a, b) {
  return [a.join(), b.join()].sort().join("|");
}

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
        opacity: 0.9,
        lineCap: "butt",
        offset: (i - (segLines.length - 1) / 2) * LINE_WEIGHT,
      }).addTo(map);
    });
  }

  for (const s of allStations) {
    L.circleMarker([s.lat, s.lon], {
      radius: 5,
      color: "#333",
      fillColor: "#fff",
      fillOpacity: 1,
      weight: 2,
    })
      .addTo(map)
      .bindTooltip(s.name)
      .on("click", () => {
        stationInput.value = s.code;
        loadTrains();
      });
  }
}

let allStations = [];

async function loadStations() {
  const response = await fetch("/api/stations");
  const raw = await response.json();
  const byCode = Object.fromEntries(raw.map(s => [s.code, s]));

  // Keep one entry per physical station, with lines from both codes
  allStations = raw
    .filter(s => !s.together || s.code < s.together)
    .map(s => s.together
      ? { ...s, lines: [...s.lines, ...byCode[s.together].lines] }
      : s);

  allStations.sort((a, b) => a.name.localeCompare(b.name));
  stationInput.replaceChildren();
  for (const lineCode of LINE_ORDER) {
    const group = document.createElement("optgroup");
    group.label = LINE_NAMES[lineCode] + " Line";
    for (const s of allStations) {
      if (s.lines[0] !== lineCode) continue;
      const opt = document.createElement("option");
      opt.value = s.code;
      opt.textContent = s.name;
      if (s.code === "A01") opt.selected = true;
      group.appendChild(opt);
    }
    if (group.children.length > 0) stationInput.appendChild(group);
  }
}

function addRow(train) {
  const row = document.createElement("tr");
  let minutesText;
  if (train.minutes === null) {
    minutesText = "—";
  } else if (train.minutes === 0) {
    minutesText = "Now";
  } else {
    minutesText = train.minutes;
  }
  for (const value of [train.line, train.destination, train.station, minutesText]) {
    const cell = document.createElement("td");
    cell.textContent = value;
    row.appendChild(cell);
  }
  tbody.appendChild(row);
}

async function loadIncidents(stationLines) {
  try {
    const [incRes, elevRes] = await Promise.all([
      fetch("/api/incidents"),
      fetch("/api/elevators/" + encodeURIComponent(stationInput.value.trim()))
    ]);
    const incidents = await incRes.json();
    const elevators = await elevRes.json();

    const relevant = incidents.filter(i => i.lines_affected.some(l => stationLines.includes(l)));
    incidentList.replaceChildren();
    if (relevant.length === 0) {
      incidentList.innerHTML = '<span class="none">No alerts.</span>';
    } else {
      for (const i of relevant) {
        const div = document.createElement("div");
        div.className = "incident-item";
        div.textContent = i.description;
        incidentList.appendChild(div);
      }
    }

    elevatorList.replaceChildren();
    if (elevators.length === 0) {
      elevatorList.innerHTML = '<span class="none">No outages.</span>';
    } else {
      for (const e of elevators) {
        const div = document.createElement("div");
        div.className = "incident-item";
        div.textContent = e.location_description + " — " + e.symptom_description;
        const meta = document.createElement("div");
        meta.className = "incident-meta";
        meta.textContent = "Out of service: " + e.date_updated;
        div.appendChild(meta);
        elevatorList.appendChild(div);
      }
    }
  } catch (_) {}
}

async function loadTrains() {
  const code = stationInput.value.trim();
  loadEntrances(code);
  message.className = "muted";
  message.textContent = "Loading...";
  tbody.replaceChildren();

  try {
    const response = await fetch("/api/trains/" + encodeURIComponent(code));
    if (!response.ok) {
      throw new Error("Server returned " + response.status);
    }
    const trains = await response.json();

    if (trains.length === 0) {
      message.textContent = "No predictions right now.";
      return;
    }

    message.textContent = "";
    for (const train of trains) {
      addRow(train);
    }

    const station = allStations.find(s => s.code === stationInput.value.trim());
    loadIncidents(station ? station.lines : []);
  } catch (error) {
    message.className = "error";
    message.textContent = "Could not load trains: " + error.message;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  loadTrains();
});

stationInput.addEventListener("change", () => loadTrains());

function buildTripDropdowns() {
  const sorted = [...allStations].sort((a, b) => a.name.localeCompare(b.name));
  for (const select of [tripFrom, tripTo]) {
    select.replaceChildren();
    for (const lineCode of LINE_ORDER) {
      const group = document.createElement("optgroup");
      group.label = LINE_NAMES[lineCode] + " Line";
      for (const s of sorted) {
        if (s.lines[0] !== lineCode) continue;
        const opt = document.createElement("option");
        opt.value = s.code;
        opt.textContent = s.name;
        group.appendChild(opt);
      }
      if (group.children.length > 0) select.appendChild(group);
    }
  }
  tripTo.value = "B35";
}

async function loadTrip() {
  const from = tripFrom.value;
  const to = tripTo.value;
  if (!from || !to || from === to) return;
  tripResult.innerHTML = '<span class="muted">Loading…</span>';
  try {
    const response = await fetch(`/api/trip/${encodeURIComponent(from)}/${encodeURIComponent(to)}`);
    if (!response.ok) throw new Error("Server returned " + response.status);
    const trip = await response.json();
    tripResult.innerHTML = `
      <div class="trip-result">
        <div class="trip-stat"><div class="label">Travel time</div><div class="value">${trip.rail_time} min</div></div>
        <div class="trip-stat"><div class="label">Peak fare</div><div class="value">$${trip.peak_fare.toFixed(2)}</div></div>
        <div class="trip-stat"><div class="label">Off-peak fare</div><div class="value">$${trip.off_peak_fare.toFixed(2)}</div></div>
        <div class="trip-stat"><div class="label">Senior fare</div><div class="value">$${trip.senior_fare.toFixed(2)}</div></div>
      </div>`;
  } catch (error) {
    tripResult.innerHTML = `<span class="error">Could not load trip: ${error.message}</span>`;
  }
}

async function loadEntrances(stationCode) {
  entranceLayer.clearLayers();
  if (!stationCode) return;
  try {
    const response = await fetch("/api/entrances/" + encodeURIComponent(stationCode));
    if (!response.ok) return;
    const entrances = await response.json();
    for (const entrance of entrances) {
      L.circleMarker([entrance.lat, entrance.lon], {
        radius: 6,
        color: "#fff",
        fillColor: "#e6a817",
        fillOpacity: 0.9,
        weight: 2,
      })
        .addTo(entranceLayer)
        .bindPopup(`<strong>${entrance.name}</strong><br>${entrance.description}`);
    }
  } catch (_) {}
}


tripForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loadTrip();
});

loadStations().then(() => {
  loadMap();
  buildTripDropdowns();
  loadTrains();
  setInterval(loadTrains, 30000);
});
