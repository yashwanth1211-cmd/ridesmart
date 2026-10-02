# Integration Review — M1 and M2 Work

**Author:** Member 5 · **Date:** after `edd0a8a` / `d2e8087`
**Branch:** `member5-tests_docs` (contains both backends)

Both Members 1 and 2 delivered working code. This is not a criticism of effort —
it is a map of what exists, what runs, and the four decisions needed before the
demo works end to end.

---

## 1. What each member built

### Member 1 — `backend/` (556 lines)

| File | What it does |
|---|---|
| `app/main.py` | FastAPI app, CORS, mounts 6 routers |
| `app/database.py` | SQLAlchemy engine + `get_db()` dependency |
| `app/models.py` | 3 tables: `buses`, `stops`, `routes` |
| `app/seed.py` | Seeds 3 routes, 3 buses, 3 stops |
| `app/routers/buses.py` | `/buses` |
| `app/routers/routes.py` | `/routes` |
| `app/routers/stops.py` | `/stops` |
| `app/routers/planner.py` | `/plan/` — crowd + ETA logic |
| `app/routers/stats.py` | authority stats |
| `app/routers/tracking.py` | live tracking |
| `requirements.txt` | full `pip freeze`, 82 packages |

**Verified working.** After manually importing `app.seed`, M1's API returns real
data from its own database.

### Member 2 — `database/` (447 lines)

| File | What it does |
|---|---|
| `main.py` | FastAPI app, mounts 6 routers |
| `api/routes.py` | `/routes`, `/routes/{id}`, `/routes/{id}/stops` |
| `api/planning.py` | `POST /routes/plan` |
| `api/buses.py` | `/buses/active`, `/buses/{id}/location` |
| `api/trip.py` | `/trips/{id}/eta`, `PUT /trips/{id}/crowd` |
| `api/dashboard.py` | `/authority/dashboard` |
| `api/websocket.py` | `WS /ws/buses` |
| `schemas/*.py` | 5 Pydantic schema modules |
| `core/config.py` | settings |

**Verified working.** M2's 11 endpoints + WebSocket all respond.

---

## 2. Current state of the branch

```
member5-tests_docs
├── simulation_ml/     M4 work (Member 5)   schema, seed, simulator
├── tests_docs/        M5 work (Member 5)   contract, 43 tests
├── backend/           M1 work              real DB-backed API
└── database/          M2 work              API layer
```

Test run: **30 passed, 13 failed**. The 13 failures are the API contract tests.
They were written before M1/M2 delivered and are now doing their job.

---

## 3. The four blockers

### Blocker 1 — Two competing backends, not one

M1 and M2 both built a FastAPI app with overlapping routes. They are **not
merged into a single service** and both cannot run at once.

| | M1 `backend/` | M2 `database/` |
|---|---|---|
| Entry point | `app.main:app` | `database.main:app` |
| `/routes` | yes | yes |
| Bus positions | `/buses` | `/buses/active` |
| Planner | `GET /plan/?from_location=&to_location=` | `POST /routes/plan` |
| Data source | **real SQLite DB** | **hardcoded Python dicts** |
| WebSocket | no | yes |

**Decision needed:** M2's `database/` becomes the single app and absorbs M1's
data layer, or the reverse. My recommendation is M2, because M2's route shapes
are much closer to the contract and M2 owns the WebSocket and the dashboard.

### Blocker 2 — M1's database is never seeded at startup

`backend/app/main.py` calls `create_all()` but **never imports `app.seed`**.
So the tables are created empty and every endpoint returns `[]`:

```
GET /routes   -> []      GET /buses -> []
GET /plan/    -> {"message": "No matching routes found"}
```

Fix is one line in `main.py`, but it must be fixed in whichever backend wins
Blocker 1, otherwise there is no data to demo.

### Blocker 3 — M2's API is hardcoded, so the simulator is invisible

Every M2 endpoint returns a literal Python list. `database/api/planning.py`
returns two fixed options; `websocket.py` sends the same coordinates forever.

Consequence: **running the simulator changes nothing on screen.** The buses
will not move, because the API never reads the `location` table the simulator
writes to. M1's backend does read a real DB, so it is the better foundation.

### Blocker 4 — Two incompatible schemas

| | M1 | M2 | Contract |
|---|---|---|---|
| Coordinates | `latitude` / `longitude` | `latitude` / `longitude` | `lat` / `lon` |
| Crowd | `"LOW"/"MEDIUM"/"HIGH"` | `"medium"` / `"low"` | `"low"/"med"/"high"` |
| ETA field | `eta_minutes` | `eta_min` | `eta_min` |
| Planner input | query params | JSON body | JSON body |
| Planner output | `routes[]` | `candidates[]` | `options[]` |
| Route ids | int (`route_id: 1`) | string (`"21A"`) | int + `code` |

Also: M1's seeded routes are **VIT University → Katpadi Railway Station**, while
the seed I wrote for M4 is **City College → Railway Station**. The demo story
depends on the College/Railway pair having two options, so the data must be
reconciled.

---

## 4. What works today

Worth saying plainly, because it is more than nothing:

- M1's SQLAlchemy layer, models and seed data are **sound and runnable**
- M1's planner computes crowd and ETA from real fields
- M2's app structure, schemas and **WebSocket** are clean
- M2's dashboard and trip endpoints are wired correctly
- Both apps boot and serve requests
- My data layer, simulator and 30 tests all pass

Nobody wasted their time. The problem is two half-systems instead of one.

---

## 5. Recommended path — in priority order

### P0 — Pick the surviving app (5 min discussion, 20 min work)

M2's `database/` absorbs M1's data layer. M1's `backend/` is retired.

- M2 keeps its 11 endpoints, WebSocket, schemas and dashboard
- M2 adopts M1's `get_db()` dependency and real table queries
- M2's routers start returning DB rows instead of literals

### P0 — Seed on startup (2 lines)

In the surviving `main.py`, after `create_all()`:

```python
from simulation_ml.db import models
models.Base.metadata.create_all(bind=engine)
from simulation_ml.seed.seed import seed
seed()
```

This gives every endpoint real data immediately, and keeps one schema.

### P0 — Rename the M1 tables, delete the duplicates

Delete M1's `buses` / `stops` / `routes` tables. Use the `simulation_ml/db`
models instead — they already carry `crowd`, `segment_stat` and `Location`,
which M1's schema has no equivalent for. M1's ETA work should read
`SegmentStat.factor`, which is exactly what that table was built for.

### P1 — Align field names to the contract (30 min)

Highest-value renames, in the surviving app:

- `latitude`/`longitude` → `lat`/`lon`
- crowd `"medium"` → `"med"`, and use `crowd_level_for()` from the models
- `candidates[]` → `options[]`
- add `/api` prefix, or update the contract to drop it
  (**pick one and tell Member 3 immediately — they are coding against this**)

### P1 — Wire the simulator in (20 min)

`simulate.py` already supports `--push`:

```bash
python -m simulation_ml.simulate --push http://localhost:8000/api/buses/ingest
```

Add that `POST /api/buses/ingest` endpoint, and the buses on screen will
actually move. This is the single highest-impact change for the demo.

### P2 — Fix `requirements.txt`

M1's file is a full `pip freeze` (82 packages, including `cvlib`, `comtypes`
and Google ML libraries). Installing it takes many minutes and pulls unrelated
dependencies. Replace with a short explicit list — M2's approach in
`tests_docs/requirements.txt` is the right size.

---

## 6. Test status as the contract sees it

| Test | Status | Reason |
|---|---|---|
| 13 API contract tests | **failing** | two apps, hardcoded data, wrong field names, no `/api` prefix |
| 30 data-layer tests | **passing** | schema, seed, simulator, crowd banding, demo contrast |

`test_plan_returns_at_least_two_options` is the one that matters most: it
asserts the demo's central feature. It fails today because no single endpoint
returns real ranked options.

---

## 7. Who does what now

| Member | Action | Est. |
|---|---|---|
| **M1** | Port your DB queries from `backend/` into M2's routers; drop your `models.py` in favour of `simulation_ml/db/models.py`; read ETA from `SegmentStat` | 45 min |
| **M2** | Seed on startup; swap hardcoded dicts for DB queries; add `POST /api/buses/ingest`; align field names | 45 min |
| **M2 + M5** | Agree the `/api` prefix question **now** — Member 3 is blocked on it | 5 min |
| **M3** | Confirm which app and which field names to code against | — |
| **M5** | Re-run the suite, keep tests green, update docs | 20 min |

After P0 and P1, the contract tests should go green and the demo will work
end to end.

---

## 8. Honest risk assessment

The code volume is not the problem — 1,003 lines landed in one push. The
problem is that **nobody merged before writing**, so the two apps are
independent. That is recoverable in roughly 90 minutes of focused work, and the
underlying pieces (M1's data layer, M2's app shell, my simulator and tests) are
all good. The demo is still saveable, but P0 cannot be skipped.
