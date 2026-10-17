# DC Metro Dashboard

An interactive DC Metro dashboard built with FastAPI and vanilla JS, powered by the [WMATA API](https://developer.wmata.com).

## Features

- **Live map** — Metro lines rendered as colored polylines on a Leaflet map, with a clickable marker for every station
- **Real-time arrivals** — Next train predictions for any station, auto-refreshed every 30 seconds
- **Station selector** — Dropdown grouped by line, populated dynamically from the API
- **Rail alerts** — Active service disruptions filtered to the lines serving the selected station
- **Elevator & escalator outages** — Current outages at the selected station

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/stations` | All stations with name, code, coordinates, and lines served |
| `GET` | `/api/lines` | All lines with display name, color, and terminal stations |
| `GET` | `/api/path/{line_code}` | Ordered station sequence for a line (used to draw map polylines) |
| `GET` | `/api/trains/{station}` | Live next-train predictions for a station |
| `GET` | `/api/incidents` | Active rail service disruptions system-wide |
| `GET` | `/api/elevators/{station}` | Elevator and escalator outages at a station |

## Running locally

**Prerequisites:** Python 3.10+, a [WMATA developer API key](https://developer.wmata.com)

```bash
# Install dependencies
pip install -r requirements.txt

# Add your API key
echo "WMATA_API_KEY=your_key_here" > .env

# Start the server
python3 -m uvicorn main:app --reload
```

Then open [http://127.0.0.1:8000](http://127.0.0.1:8000).

## Stack

- **Backend:** FastAPI (Python) — proxies and cleans WMATA API responses
- **Frontend:** Vanilla JS, Leaflet for the map
- **Data:** [WMATA API](https://developer.wmata.com) — real-time train predictions, station data, incidents

> **Note:** This is a personal learning project and is not affiliated with or endorsed by
> the Washington Metropolitan Area Transit Authority (WMATA). It uses data from the
> [WMATA API](https://developer.wmata.com) under WMATA's
> [Transit Data Terms of Use](https://developer.wmata.com/license). It is intended to be run
> locally; it is not deployed publicly and does not redistribute WMATA transit data.
> To run it, obtain your own free API key at developer.wmata.com.
