import os
import requests

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from dotenv import load_dotenv

load_dotenv()
app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

# API URLS
STATION_PREDICTION_URL = "https://api.wmata.com/StationPrediction.svc/json/GetPrediction/"
STATIONS_URL = "https://api.wmata.com/Rail.svc/json/jStations"
INCIDENTS_URL = "https://api.wmata.com/Incidents.svc/json/Incidents"
ELEVATOR_INCIDENTS_URL = "https://api.wmata.com/Incidents.svc/json/ElevatorIncidents?StationCode="
LINES_URL = "https://api.wmata.com/Rail.svc/json/jLines"
PATH_URL = "https://api.wmata.com/Rail.svc/json/jPath"

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
        "lines": lines
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

def clean_path(stop):
    return {
        "seq_num": stop["SeqNum"],
        "station_code": stop["StationCode"],
        "station_name": stop["StationName"],
        "lat": stop["Lat"],
        "lon": stop["Lon"],
    }

# ENDPOINTS
@app.get("/api/trains/{station}")
def get_trains(station: str):
    response = requests.get(
        STATION_PREDICTION_URL + station.upper(),
        headers={"api_key": os.environ["WMATA_API_KEY"]},
        timeout=10,
    )
    response.raise_for_status()
    return [clean_train(train) for train in response.json()["Trains"]]

@app.get("/api/stations")
def get_stations():
    response = requests.get(
        STATIONS_URL,
        headers={"api_key": os.environ["WMATA_API_KEY"]},
        timeout=10,
    )
    response.raise_for_status()
    return [clean_station(station) for station in response.json()["Stations"]]

@app.get("/api/incidents")
def get_incidents():
    response = requests.get(
        INCIDENTS_URL,
        headers={"api_key": os.environ["WMATA_API_KEY"]},
        timeout=10,
    )
    response.raise_for_status()
    return [clean_incident(incident) for incident in response.json()["Incidents"]]

@app.get("/api/elevators/{station}")
def get_elevator_incidents(station: str):
    response = requests.get(
        ELEVATOR_INCIDENTS_URL + station.upper(),
        headers={"api_key": os.environ["WMATA_API_KEY"]},
        timeout=10,
    )
    response.raise_for_status()
    return [clean_elevator_incident(elevator_incident) for elevator_incident in response.json()["ElevatorIncidents"]]

@app.get("/api/lines")
def get_lines():
    response = requests.get(
        LINES_URL,
        headers={"api_key": os.environ["WMATA_API_KEY"]},
        timeout=10,
    )
    response.raise_for_status()
    return [clean_line(line) for line in response.json()["Lines"]]

@app.get("/api/path/{line_code}")
def get_path(line_code: str):
    all_lines = get_lines()
    line = next(l for l in all_lines if l["code"] == line_code.upper())
    response = requests.get(
        PATH_URL + "?FromStationCode=" + line["start_station"] + "&ToStationCode=" + line["end_station"],
        headers={"api_key": os.environ["WMATA_API_KEY"]},
        timeout=10,
    )
    response.raise_for_status()
    return [clean_path(path) for path in response.json()["Path"]]

@app.get("/")
def home():
    return FileResponse("index.html")