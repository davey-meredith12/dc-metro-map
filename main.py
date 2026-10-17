import os
import time
import requests

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from dotenv import load_dotenv

load_dotenv()

_static_cache = {}

@asynccontextmanager
async def lifespan(app: FastAPI):
    headers = {"api_key": os.environ["WMATA_API_KEY"]}
    stations_res = requests.get(STATIONS_URL, headers=headers, timeout=10)
    stations_res.raise_for_status()
    _static_cache["stations"] = [clean_station(s) for s in stations_res.json()["Stations"]]
    _static_cache["together"] = {
        s["code"]: s["together"] for s in _static_cache["stations"] if s["together"]
    }

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

app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory="static"), name="static")

# API URLS
STATION_PREDICTION_URL = "https://api.wmata.com/StationPrediction.svc/json/GetPrediction/"
STATIONS_URL = "https://api.wmata.com/Rail.svc/json/jStations"
INCIDENTS_URL = "https://api.wmata.com/Incidents.svc/json/Incidents"
ELEVATOR_INCIDENTS_URL = "https://api.wmata.com/Incidents.svc/json/ElevatorIncidents?StationCode="
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
    if raw == "ARR" or raw == "BRD":
        return 0
    try:
        return int(raw)
    except ValueError:
        return None

def clean_train(train):
    return {
        "line": train["Line"],
        "destination": train["DestinationName"],
        "station": train["LocationName"],
        "minutes": clean_minutes(train["Min"])
    }

def clean_station(station):
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
    lines_affected = [l for l in incident["LinesAffected"].split("; ") if l]
    
    return{
        "description": incident["Description"],
        "lines_affected": lines_affected,
        "date_updated": incident["DateUpdated"]
    }

def clean_elevator_incident(elevator_incident):
    return{
        "location_description": elevator_incident["LocationDescription"],
        "symptom_description": elevator_incident["SymptomDescription"],
        "date_updated": elevator_incident["DateOutOfServ"]
    }

def clean_line(line):
    return{
        "code": line["LineCode"],
        "display_name": line["DisplayName"],
        "start_station": line["StartStationCode"],
        "end_station": line["EndStationCode"],
        "color": LINE_COLORS[line["LineCode"]]
    }

def clean_entrance(entrance):
    return {
        "name": entrance["Name"],
        "lat": entrance["Lat"],
        "lon": entrance["Lon"],
        "description": entrance["Description"],
    }

def station_codes(station):
    # Transfer stations have one code per set of platforms; include the partner
    code = station.upper()
    partner = _static_cache["together"].get(code)
    return [code, partner] if partner else [code]

# ENDPOINTS
@app.get("/api/trains/{station}")
def get_trains(station: str):
    response = requests.get(
        STATION_PREDICTION_URL + ",".join(station_codes(station)),
        headers={"api_key": os.environ["WMATA_API_KEY"]},
        timeout=10,
    )
    response.raise_for_status()
    return [clean_train(train) for train in response.json()["Trains"]]

@app.get("/api/stations")
def get_stations():
    return _static_cache["stations"]

_incidents_cache = {"data": None, "expires": 0}

@app.get("/api/incidents")
def get_incidents():
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

_elevator_cache = {}

@app.get("/api/elevators/{station}")
def get_elevator_incidents(station: str):
    code = station.upper()
    entry = _elevator_cache.get(code)
    if entry and time.time() < entry["expires"]:
        return entry["data"]
    data = []
    for c in station_codes(code):
        response = requests.get(
            ELEVATOR_INCIDENTS_URL + c,
            headers={"api_key": os.environ["WMATA_API_KEY"]},
            timeout=10,
        )
        response.raise_for_status()
        data += [clean_elevator_incident(elevator_incident) for elevator_incident in response.json()["ElevatorIncidents"]]
    _elevator_cache[code] = {"data": data, "expires": time.time() + 120}
    return data

@app.get("/api/lines")
def get_lines():
    return _static_cache["lines"]

@app.get("/api/path/{line_code}")
def get_path(line_code: str):
    return _static_cache["routes"].get(line_code.upper(), [])

@app.get("/api/trip/{from_code}/{to_code}")
def get_trip(from_code: str, to_code: str):
    response = requests.get(
        STATION_TO_STATION_URL,
        params={"FromStationCode": from_code.upper(), "ToStationCode": to_code.upper()},
        headers={"api_key": os.environ["WMATA_API_KEY"]},
        timeout=10,
    )
    response.raise_for_status()
    info = response.json()["StationToStationInfos"][0]
    return {
        "rail_time": info["RailTime"],
        "peak_fare": info["RailFare"]["PeakTime"],
        "off_peak_fare": info["RailFare"]["OffPeakTime"],
        "senior_fare": info["RailFare"]["SeniorDisabled"],
    }

@app.get("/api/entrances/{station}")
def get_entrances(station: str):
    return _static_cache["entrances"].get(station.upper(), [])

@app.get("/")
def home():
    return FileResponse("index.html")