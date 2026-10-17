import os
import time
import requests

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from dotenv import load_dotenv

load_dotenv()

_static_cache = {}

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load data that rarely changes (stations, lines, route paths, entrances) from WMATA once at startup and cache it."""
    headers = {"api_key": os.environ["WMATA_API_KEY"]}
    stations_res = requests.get(STATIONS_URL, headers=headers, timeout=10)
    stations_res.raise_for_status()
    _static_cache["stations"] = [clean_station(s) for s in stations_res.json()["Stations"]]
    _static_cache["together"] = {
        s["code"]: s["together"] for s in _static_cache["stations"] if s["together"]
    }
    _static_cache["codes"] = {s["code"] for s in _static_cache["stations"]}

    lines_res = requests.get(LINES_URL, headers=headers, timeout=10)
    lines_res.raise_for_status()
    _static_cache["lines"] = [clean_line(l) for l in lines_res.json()["Lines"]]

    routes_res = requests.get(STANDARD_ROUTES_URL, headers=headers, timeout=10)
    routes_res.raise_for_status()
    coords = {s["code"]: (s["lat"], s["lon"]) for s in _static_cache["stations"]}
    routes = {}
    for route in routes_res.json()["StandardRoutes"]:
        if route["TrackNum"] != 1:
            continue
        code = route["LineCode"]
        routes[code] = [
            {"station_code": c["StationCode"], "lat": coords[c["StationCode"]][0], "lon": coords[c["StationCode"]][1]}
            for c in route["TrackCircuits"]
            if c["StationCode"] and c["StationCode"] in coords
        ]
    _static_cache["routes"] = routes

    entrances_res = requests.get(ENTRANCES_URL, headers=headers, timeout=10)
    entrances_res.raise_for_status()
    entrances_by_station = {}
    for entrance in entrances_res.json()["Entrances"]:
        for key in ("StationCode1", "StationCode2"):
            code = entrance.get(key)
            if code:
                entrances_by_station.setdefault(code, []).append(clean_entrance(entrance))
    _static_cache["entrances"] = entrances_by_station

    yield

# The /api routes only exist to feed this app's own page, so don't publish docs or a schema for them
app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/static", StaticFiles(directory="static"), name="static")

RATE_LIMIT_PER_MINUTE = 120
_rate_window = {"start": 0, "counts": {}}

def over_rate_limit(ip):
    """Count a request from this IP in the current one-minute window and report whether it is over the limit."""
    now = time.time()
    if now - _rate_window["start"] >= 60:
        _rate_window["start"] = now
        _rate_window["counts"] = {}
    counts = _rate_window["counts"]
    counts[ip] = counts.get(ip, 0) + 1
    return counts[ip] > RATE_LIMIT_PER_MINUTE

@app.middleware("http")
async def guard_api(request: Request, call_next):
    """Only serve /api requests made by this app's own page, and rate-limit them per IP so
    the app can't be used as a general WMATA data API or flood WMATA with requests."""
    if request.url.path.startswith("/api/"):
        if request.headers.get("sec-fetch-site") != "same-origin":
            return JSONResponse({"detail": "Forbidden"}, status_code=403)
        if over_rate_limit(request.client.host if request.client else "unknown"):
            return JSONResponse({"detail": "Too many requests"}, status_code=429)
    return await call_next(request)

# API URLS
STATION_PREDICTION_URL = "https://api.wmata.com/StationPrediction.svc/json/GetPrediction/"
STATIONS_URL = "https://api.wmata.com/Rail.svc/json/jStations"
INCIDENTS_URL = "https://api.wmata.com/Incidents.svc/json/Incidents"
ELEVATOR_INCIDENTS_URL = "https://api.wmata.com/Incidents.svc/json/ElevatorIncidents"
LINES_URL = "https://api.wmata.com/Rail.svc/json/jLines"
STANDARD_ROUTES_URL = "https://api.wmata.com/TrainPositions/StandardRoutes?contentType=json"
STATION_TO_STATION_URL = "https://api.wmata.com/Rail.svc/json/jSrcStationToDstStationInfo"
ENTRANCES_URL = "https://api.wmata.com/Rail.svc/json/jStationEntrances"

LINE_COLORS = {
    "RD": "#E6194B",
    "BL": "#4363D8",
    "OR": "#F58231",
    "SV": "#A9A9A9",
    "GR": "#3CB44B",
    "YL": "#FFE119",
}

# HELPERS
def clean_minutes(raw):
    """Convert WMATA's minutes field to an int: ARR/BRD become 0, anything non-numeric becomes None."""
    if raw == "ARR" or raw == "BRD":
        return 0
    try:
        return int(raw)
    except ValueError:
        return None

def clean_train(train):
    """Reshape a WMATA train prediction into the fields the frontend uses."""
    return {
        "line": train["Line"],
        "destination": train["DestinationName"],
        "station": train["LocationName"],
        "minutes": clean_minutes(train["Min"]),
        "boarding": train["Min"] == "BRD",
        "group": train["LocationCode"] + "-" + train["Group"],
        "cars": int(train["Car"]) if train["Car"] and train["Car"].isdigit() else None
    }

def clean_station(station):
    """Reshape a WMATA station, collecting its line codes into a list and keeping its transfer partner code."""
    lines = []
    if station["LineCode1"]:
        lines.append(station["LineCode1"])
    if station["LineCode2"]:
        lines.append(station["LineCode2"])
    if station["LineCode3"]:
        lines.append(station["LineCode3"])
    if station["LineCode4"]:
        lines.append(station["LineCode4"])
    
    return{
        "code": station["Code"],
        "name": station["Name"],
        "lat": station["Lat"],
        "lon": station["Lon"],
        "lines": lines,
        "together": station["StationTogether1"] or None
    }

def clean_incident(incident):
    """Reshape a WMATA rail incident, splitting its affected lines into a list."""
    lines_affected = [l for l in incident["LinesAffected"].split("; ") if l]
    
    return{
        "description": incident["Description"],
        "lines_affected": lines_affected,
        "date_updated": incident["DateUpdated"]
    }

def clean_elevator_incident(elevator_incident):
    """Reshape a WMATA elevator/escalator outage."""
    return{
        "location_description": elevator_incident["LocationDescription"],
        "symptom_description": elevator_incident["SymptomDescription"],
        "date_updated": elevator_incident["DateOutOfServ"]
    }

def clean_line(line):
    """Reshape a WMATA line and attach its map color."""
    return{
        "code": line["LineCode"],
        "display_name": line["DisplayName"],
        "start_station": line["StartStationCode"],
        "end_station": line["EndStationCode"],
        "color": LINE_COLORS[line["LineCode"]]
    }

def clean_entrance(entrance):
    """Reshape a WMATA station entrance."""
    return {
        "name": entrance["Name"],
        "lat": entrance["Lat"],
        "lon": entrance["Lon"],
        "description": entrance["Description"],
    }

def valid_code(station):
    """Return the upper-cased station code, or raise a 404 if it isn't a known station,
    so unknown codes are never forwarded to WMATA."""
    code = station.upper()
    if code not in _static_cache["codes"]:
        raise HTTPException(status_code=404, detail="Unknown station")
    return code

def station_codes(station):
    """Return a station code plus its transfer partner, if any. Transfer stations
    have one code per set of platforms (e.g. Metro Center is A01 and C01)."""
    code = station.upper()
    partner = _static_cache["together"].get(code)
    return [code, partner] if partner else [code]

# ENDPOINTS
_trains_cache = {"data": {}, "expires": 0}

@app.get("/api/trains/{station}")
def get_trains(station: str):
    """Next-train predictions for a station, covering both levels at transfer stations. Predictions for
    every station come from one WMATA call cached for 15 seconds, so load on WMATA doesn't grow with users."""
    code = valid_code(station)
    if time.time() >= _trains_cache["expires"]:
        response = requests.get(
            STATION_PREDICTION_URL + "All",
            headers={"api_key": os.environ["WMATA_API_KEY"]},
            timeout=10,
        )
        response.raise_for_status()
        by_station = {}
        for train in response.json()["Trains"]:
            by_station.setdefault(train["LocationCode"], []).append(clean_train(train))
        _trains_cache["data"] = by_station
        _trains_cache["expires"] = time.time() + 15
    return [train for c in station_codes(code) for train in _trains_cache["data"].get(c, [])]

@app.get("/api/stations")
def get_stations():
    """All stations with name, code, coordinates, lines served, and transfer partner code."""
    return _static_cache["stations"]

_incidents_cache = {"data": None, "expires": 0}

@app.get("/api/incidents")
def get_incidents():
    """Active rail incidents system-wide, cached for 2 minutes."""
    if time.time() < _incidents_cache["expires"]:
        return _incidents_cache["data"]
    response = requests.get(
        INCIDENTS_URL,
        headers={"api_key": os.environ["WMATA_API_KEY"]},
        timeout=10,
    )
    response.raise_for_status()
    _incidents_cache["data"] = [clean_incident(incident) for incident in response.json()["Incidents"]]
    _incidents_cache["expires"] = time.time() + 120
    return _incidents_cache["data"]

_elevator_cache = {"data": {}, "expires": 0}

@app.get("/api/elevators/{station}")
def get_elevator_incidents(station: str):
    """Elevator and escalator outages at a station (both levels at transfer stations). Outages for every
    station come from one WMATA call cached for 2 minutes."""
    code = valid_code(station)
    if time.time() >= _elevator_cache["expires"]:
        response = requests.get(
            ELEVATOR_INCIDENTS_URL,
            headers={"api_key": os.environ["WMATA_API_KEY"]},
            timeout=10,
        )
        response.raise_for_status()
        by_station = {}
        for elevator_incident in response.json()["ElevatorIncidents"]:
            by_station.setdefault(elevator_incident["StationCode"], []).append(clean_elevator_incident(elevator_incident))
        _elevator_cache["data"] = by_station
        _elevator_cache["expires"] = time.time() + 120
    return [i for c in station_codes(code) for i in _elevator_cache["data"].get(c, [])]

@app.get("/api/lines")
def get_lines():
    """All lines with display name, color, and terminal stations."""
    return _static_cache["lines"]

@app.get("/api/path/{line_code}")
def get_path(line_code: str):
    """Ordered stations along a line, used to draw it on the map."""
    return _static_cache["routes"].get(line_code.upper(), [])

_trip_cache = {}

@app.get("/api/trip/{from_code}/{to_code}")
def get_trip(from_code: str, to_code: str):
    """Travel time and peak, off-peak, and senior fares between two stations, cached for 6 hours
    since they rarely change."""
    key = (valid_code(from_code), valid_code(to_code))
    entry = _trip_cache.get(key)
    if entry and time.time() < entry["expires"]:
        return entry["data"]
    response = requests.get(
        STATION_TO_STATION_URL,
        params={"FromStationCode": key[0], "ToStationCode": key[1]},
        headers={"api_key": os.environ["WMATA_API_KEY"]},
        timeout=10,
    )
    response.raise_for_status()
    infos = response.json()["StationToStationInfos"]
    if not infos:
        raise HTTPException(status_code=404, detail="No trip found")
    info = infos[0]
    data = {
        "rail_time": info["RailTime"],
        "peak_fare": info["RailFare"]["PeakTime"],
        "off_peak_fare": info["RailFare"]["OffPeakTime"],
        "senior_fare": info["RailFare"]["SeniorDisabled"],
    }
    _trip_cache[key] = {"data": data, "expires": time.time() + 6 * 3600}
    return data

@app.get("/api/entrances/{station}")
def get_entrances(station: str):
    """Physical entrance locations for a station."""
    return _static_cache["entrances"].get(station.upper(), [])

@app.get("/")
def home():
    """Serve the frontend page."""
    return FileResponse("index.html")