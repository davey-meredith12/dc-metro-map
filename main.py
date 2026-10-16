import json
import os
import sys

import requests

from fastapi import FastAPI
from fastapi.responses import FileResponse

from dotenv import load_dotenv

load_dotenv()
app = FastAPI()

BASE_URL = "https://api.wmata.com/StationPrediction.svc/json/GetPrediction/"

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

@app.get("/api/trains/{station}")
def get_trains(station: str):
    response = requests.get(
        BASE_URL + station.upper(),
        headers={"api_key": os.environ["WMATA_API_KEY"]},
        timeout=10,
    )
    response.raise_for_status()
    return [clean_train(train) for train in response.json()["Trains"]]

@app.get("/")
def home():
    return FileResponse("index.html")