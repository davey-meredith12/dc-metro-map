const form = document.getElementById("station-form");
const stationInput = document.getElementById("station");
const message = document.getElementById("message");
const tbody = document.getElementById("train-rows");
const incidentList = document.getElementById("incident-list");
const elevatorList = document.getElementById("elevator-list");

const LINE_ORDER = ["RD", "BL", "OR", "SV", "GR", "YL"];
const LINE_NAMES = { RD: "Red", BL: "Blue", OR: "Orange", SV: "Silver", GR: "Green", YL: "Yellow" };

let allStations = [];

async function loadStations() {
  const response = await fetch("/api/stations");
  allStations = await response.json();
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

loadStations().then(() => {
  loadTrains();
  setInterval(loadTrains, 30000);
});
