# DC Metro Dashboard

An interactive DC Metro dashboard built with FastAPI and vanilla JS, powered by the [WMATA API](https://developer.wmata.com).

![DC Metro Dashboard showing the full-screen map and station panel](/screenshots/Example_Screenshot.png)

## Features

- **Full-screen live map** — Metro lines drawn side by side where they share track, with a clickable marker for every station and the selected station highlighted
- **Real-time arrivals** — Next trains split by direction, with car count and arriving/boarding status; refreshes every 30 seconds in place and pauses while the tab is hidden
- **Station search** — Type-ahead search with keyboard support; transfer stations (Metro Center, Gallery Place, L'Enfant Plaza, Fort Totten) are merged into one station covering all their lines
- **Rail alerts** — Active service disruptions filtered to the lines serving the selected station
- **Elevator & escalator outages** — Current outages at the selected station
- **Trip planner** — Travel time and peak, off-peak, and senior fares, starting from the selected station
- **Station entrances** — Physical entrance locations shown on the map when a station is selected
- **Shareable links** — The selected station is kept in the URL (e.g. `/#A01`) and remembered between visits
- **Responsive with dark mode** — Side panel on desktop, bottom panel on phones; follows the system light/dark setting

## Screenshots

**Station entrances** — Entrances for the selected station appear as amber dots; click one for its details.

<img src="screenshots/Entrance_Screenshot.png" alt="Map zoomed in on Metro Center with entrance markers and an elevator entrance popup" width="600">

<table>
  <tr>
    <th>Alerts &amp; outages</th>
    <th>Trip planner</th>
  </tr>
  <tr>
    <td valign="top"><img src="screenshots/Alerts_Screenshot.png" alt="L'Enfant Plaza station card with no rail alerts and six elevator/escalator outages expanded" width="320"></td>
    <td valign="top"><img src="screenshots/TripPlanner_Screenshot.png" alt="Trip planner from New Carrollton to Union Station showing travel time and fares" width="380"></td>
  </tr>
</table>

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/stations` | All stations with name, code, coordinates, lines served, and transfer partner code |
| `GET` | `/api/lines` | All lines with display name, color, and terminal stations |
| `GET` | `/api/path/{line_code}` | Ordered station sequence for a line (used to draw map polylines) |
| `GET` | `/api/trains/{station}` | Live next-train predictions for a station (both levels at transfer stations), with direction group and car count |
| `GET` | `/api/incidents` | Active rail service disruptions system-wide |
| `GET` | `/api/elevators/{station}` | Elevator and escalator outages at a station (both levels at transfer stations) |
| `GET` | `/api/trip/{from_code}/{to_code}` | Travel time and fares between two stations |
| `GET` | `/api/entrances/{station}` | Physical entrance locations for a station |

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
- **Frontend:** Vanilla JS and CSS, no build step; Leaflet for the map, with leaflet-polylineoffset to draw shared track side by side
- **Data:** [WMATA API](https://developer.wmata.com) — real-time train predictions, station data, incidents

> **Note:** This is a personal learning project and is not affiliated with or endorsed by
> the Washington Metropolitan Area Transit Authority (WMATA). It uses data from the
> [WMATA API](https://developer.wmata.com) under WMATA's
> [Transit Data Terms of Use](https://developer.wmata.com/license). It is intended to be run
> locally; it is not deployed publicly and does not redistribute WMATA transit data.
> It is not deployed because its `/api` endpoints pass WMATA Transit Data through largely
> unchanged, and WMATA's terms (§§ 6 and 8) prohibit exposing Transit Data through your own
> API without WMATA's prior written authorization.
> To run it, obtain your own free API key at developer.wmata.com.
