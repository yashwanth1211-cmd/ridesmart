# RideSmart API Reference

**Owner:** Member 5 · **Implementation:** Member 2
**Source of truth:** [`../api_contract.yaml`](../api_contract.yaml)

Base URL: `http://localhost:8000` · Interactive docs: `/docs` (Swagger) · `/redoc`

---

## Conventions

| Rule | Value |
|---|---|
| Base path | `/api` |
| Timestamps | ISO-8601 UTC **with** timezone suffix |
| Durations | integers, in **minutes** |
| Errors | `{"detail": "human readable", "code": "machine_readable"}` |
| Crowd banding | `low` < 0.4 · `med` 0.4–0.75 · `high` ≥ 0.75 (ratio = load / capacity) |
| Planner ordering | options sorted by `eta_min` ascending |

### The two gotchas that will bite you

**1. SQLite drops timezone info.** Reading a `TIMESTAMP` back from SQLite returns a
naive datetime. Comparing it to `utcnow()` raises `TypeError`. Always wrap the DB
value:

```python
from simulation_ml.db.models import as_utc

observed = (as_utc(row.ts) - utcnow()).total_seconds()
```

**2. Crowding has one definition.** Never hardcode the thresholds. Call:

```python
from simulation_ml.db.models import crowd_level_for

level = crowd_level_for(load, capacity)   # -> "low" | "med" | "high"
```

The simulator, the seed data and the API all go through this function, so the
crowd badge on screen can never disagree with the API response.

---

## Endpoints

### `GET /api/health`

```bash
curl http://localhost:8000/api/health
```

```json
{ "status": "ok", "database": "ok", "time": "2026-01-01T10:00:00+00:00" }
```

---

### `GET /api/routes`

```bash
curl http://localhost:8000/api/routes
```

```json
[
  { "id": 1, "code": "V1", "name": "VIT - Bagayam",
    "direction": "up", "stop_count": 9 },
  { "id": 2, "code": "V2", "name": "VIT - Otteri",
    "direction": "up", "stop_count": 10 },
  { "id": 3, "code": "M1", "name": "VIT - Christian Medical College",
    "direction": "up", "stop_count": 11 }
]
```

---

### `GET /api/routes/{route_id}/stops`

Stops in travel order.

```bash
curl http://localhost:8000/api/routes/1/stops
```

```json
[
  { "seq": 0, "scheduled_offset_sec": 0,
    "stop": { "id": 1, "code": "STOP_VIT", "name": "VIT",
              "lat": 12.968142, "lon": 79.156252, "accessible": true } },
  { "seq": 1, "scheduled_offset_sec": 495,
    "stop": { "id": 2, "code": "STOP_KATPADI_JUNCTION",
              "name": "Katpadi Junction- Chittor Bus Stand",
              "lat": 12.966256, "lon": 79.137494, "accessible": true } }
]
```

---

### `GET /api/routes/{route_id}/shape`

The route's **real road polyline**, in travel order. Every point is a vertex on
an actual Vellore–Katpadi road, and `cum_m` is the distance from the start of the
route.

Use this to draw the route. Do **not** join the stop coordinates into a line:
adjacent stops can be kilometres apart with a lake, a park or a railway line
between them, so a line through the stops is not a drivable path. The map draws
this polyline and the simulator walks it, so what you see is where the bus is.

```bash
curl http://localhost:8000/api/routes/1/shape
```

```json
{
  "route_id": 1,
  "code": "V1",
  "total_m": 15157.7,
  "point_count": 92,
  "points": [
    { "seq": 0, "lat": 12.968078, "lon": 79.156234, "cum_m": 0.0 },
    { "seq": 1, "lat": 12.967481, "lon": 79.158602, "cum_m": 41.7 }
  ]
}
```

---

### `GET /api/stops`

Every stop, for the planner's from/to pickers.

---

### `GET /api/buses/active`

Latest position per active trip. Poll every 2s as a WebSocket fallback.

```bash
curl http://localhost:8000/api/buses/active
```

```json
[
  {
    "bus_id": 1,
    "bus_reg": "TN09AB1234",
    "trip_id": 1,
    "route_id": 1,
    "route_code": "V1",
    "lat": 12.9675,
    "lon": 79.1586,
    "heading": 271.4,
    "speed_kmph": 20.2,
    "next_stop_name": "Katpadi Junction- Chittor Bus Stand",
    "crowd_level": "med",
    "crowd_load": 35,
    "capacity": 50,
    "wheelchair_accessible": true,
    "low_floor": true,
    "ts": "2026-01-01T10:04:59+00:00"
  }
]
```

---

### `GET /api/buses/{bus_id}/location`

Latest position for one bus. `404` if unknown.

---

### `POST /api/routes/plan` — the standout feature

Returns **multiple** candidate routes, each scored on predicted ETA and crowding.
The UI must render every option; showing one defeats the purpose.

**Request**

| Field | Type | Required | Notes |
|---|---|---|---|
| `from` | string | yes | stop code, e.g. `STOP_RAJAJINAGAR` |
| `to` | string | yes | stop code, e.g. `STOP_MAJESTIC` |
| `accessibility_only` | bool | no | default `false`; drops buses without wheelchair access |

```bash
curl -X POST http://localhost:8000/api/routes/plan \
  -H "Content-Type: application/json" \
  -d '{"from": "STOP_RAJAJINAGAR", "to": "STOP_MAJESTIC"}'
```

**Response** — see the full example in the [README](../../README.md#api-reference).

| Field | Type | Notes |
|---|---|---|
| `route_id` | int | |
| `code` | string | `"V1"` |
| `eta_min` | int | predicted, from observed segment times |
| `eta_scheduled_min` | int | per the timetable |
| `eta_predicted_min` | int | alias of `eta_min`, kept for frontend clarity |
| `delay_min` | int | `eta_min - eta_scheduled_min`; negative means early |
| `crowd_level` | enum | `low` \| `med` \| `high` |
| `crowd_load` / `capacity` | int | raw occupancy, for `35 / 50` style display |
| `crowd_ratio` | float | `crowd_load / capacity` |
| `wheelchair_accessible` | bool | |
| `low_floor` | bool | |
| `score` | float | `w_eta * eta_min + w_crowd * (crowd_ratio * 100)`, lower is better |
| `stops[]` | array | `{stop_id, name, eta_min, accessible}` |

**Errors:** `400` with `{"detail": "...", "code": "unknown_stop"}` when a stop
code is not recognised.

**How to build the options.** Find every route containing both stops, take the
sub-path in travel order, sum `SegmentStat.avg_travel_sec` over the remaining
hops for `eta_min`, then rank by `score`. Seed data guarantees at least two
options between College and Railway Station.

---

### `GET /api/trips/{trip_id}/eta`

Per-stop scheduled vs predicted arrival, both relative to now.

```json
[
  { "stop_id": 2, "stop_name": "Central Library",
    "scheduled_min": 4, "predicted_min": 6, "delay_min": 2 }
]
```

---

### `PUT /api/trips/{trip_id}/crowd`

Manual override — driver app input, and the **demo trigger**. Set a bus to empty,
re-plan, and watch the ranking change.

**Request:** `{"load": 12, "capacity": 50}` → **Response:** the stored `CrowdEstimate`.

```bash
curl -X PUT http://localhost:8000/api/trips/1/crowd \
  -H "Content-Type: application/json" \
  -d '{"load": 12, "capacity": 50}'
```

---

### `GET /api/authority/dashboard`

```json
{
  "total_buses": 4,
  "active_buses": 3,
  "delayed_buses": 1,
  "avg_delay_min": 3.4,
  "high_demand_route": "M1",
  "crowded_route": "M1",
  "routes": [
    { "route_id": 1, "code": "V1", "active_trips": 1,
      "avg_delay_min": 4.1, "avg_crowd_ratio": 0.7, "demand_score": 0.82 }
  ]
}
```

---

### `WS /api/ws/buses`

Pushes the same array as `/api/buses/active` roughly every 2 seconds. Clients
must tolerate a heartbeat-only message.

```js
const ws = new WebSocket("ws://localhost:8000/api/ws/buses");
ws.onmessage = (e) => setBuses(JSON.parse(e.data));
```

---

## Error codes

| `code` | HTTP | Meaning |
|---|---|---|
| `unknown_stop` | 400 | Stop code not in the database |
| `no_route` | 400 | No seeded route connects the two stops |
| `not_found` | 404 | Unknown bus / trip / route id |
| `validation_error` | 422 | FastAPI request validation |

---

## Testing against this API

```bash
cd tests_docs
pytest -v                          # API tests skip until the app exists
pytest -v -k plan                  # just the planner
```

Tests run against a throwaway SQLite file, never `ridesmart.db`, so a test run
can never corrupt demo data.