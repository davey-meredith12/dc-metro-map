import json
import os
import sys

import requests

from fastapi import FastAPI
from fastapi.responses import FileResponse

from dotenv import load_dotenv

load_dotenv()
app = FastAPI()

STATION_PREDICTION_URL = "https://api.wmata.com/StationPrediction.svc/json/GetPrediction/"
STATIONS_URL = "https://api.wmata.com/Rail.svc/json/jStations"
INCIDENTS_URL = "https://api.wmata.com/Incidents.svc/json/Incidents"
ELEVATOR_INCIDENTS_URL = "https://api.wmata.com/Incidents.svc/json/ElevatorIncidents?StationCode="

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

@app.get("/")
def home():
    return FileResponse("index.html")