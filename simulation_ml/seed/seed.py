"""Seed the database with demo routes, stops, buses and trips.

OWNER: Member 5 (temporarily, while Member 4 is unavailable).

    python -m simulation_ml.seed.seed          # create tables + seed if empty
    python -m simulation_ml.seed.seed --reset  # drop everything first

WHY THIS DATA LOOKS THE WAY IT DOES
-----------------------------------
The demo is "crowd-aware route recommendations": the passenger sees two
options between College and Railway Station and picks between fast-but-packed
and slow-but-empty. That contrast only works if the seed deliberately creates
it, so:

    21A  fast  (11 min scheduled),  load 35/50 = 0.70 -> MED  yellow
    7B   slow  (18 min scheduled),  load 12/50 = 0.24 -> LOW  green

7B is slower AND empty, 21A is faster AND packed. Neither dominates, which is
exactly the trade-off we want on screen.

Coordinates are a real Bengaluru corridor (~12.97N, 77.59E) so the map looks
like a city instead of three dots in the ocean.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Allow both `python -m simulation_ml.seed.seed` and `python seed/seed.py`.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from simulation_ml.db.models import (  # noqa: E402
    Bus,
    Crowd,
    Route,
    RouteStop,
    Schedule,
    SegmentStat,
    Stop,
    Trip,
    crowd_level_for,
    get_sessionmaker,
    reset_database,
    utcnow,
)

# ---------------------------------------------------------------------------
# Stops  (code, name, lat, lon, accessible)
# ---------------------------------------------------------------------------
STOPS = [
    ("STOP_COLLEGE", "City College", 12.9716, 77.5946, True),
    ("STOP_LIBRARY", "Central Library", 12.9759, 77.6067, True),
    ("STOP_MARKET", "KR Market", 12.9616, 77.6450, False),
    ("STOP_PARK", "Cubbon Park", 12.9763, 77.5929, True),
    ("STOP_MAINROAD", "Main Road", 12.9788, 77.5713, True),
    ("STOP_HOSPITAL", "City Hospital", 12.9833, 77.6073, True),
    ("STOP_AIRPORT_RD", "Airport Road", 12.9606, 77.6437, True),
    ("STOP_GOVT", "Government Office", 12.9759, 77.5920, True),
    ("STOP_CENTRAL", "Majestic (Central)", 12.9767, 77.5713, True),
    ("STOP_RAILWAY", "Railway Station", 12.9795, 77.5568, True),
    ("STOP_MALL", "City Mall", 12.9698, 77.5907, True),
    ("STOP_DEPOT", "Bus Depot", 12.9525, 77.5940, False),
]

# ---------------------------------------------------------------------------
# Routes  ->  (code, name, [(stop_code, scheduled_offset_sec)], observed factor)
#
# The observed factor is how much slower reality is than the timetable. 21A
# runs close to schedule with one bad segment; 7B is consistently slow, which
# is what makes its predicted ETA worse than 21A even before crowding is
# considered.
# ---------------------------------------------------------------------------
ROUTES = [
    {
        "code": "21A",
        "name": "College to Railway Station",
        "direction": "up",
        # offset_sec is cumulative seconds from trip start
        "stops": [
            ("STOP_COLLEGE", 0),
            ("STOP_LIBRARY", 210),
            ("STOP_MAINROAD", 420),
            ("STOP_CENTRAL", 540),
            ("STOP_RAILWAY", 660),
        ],
        "factors": [1.0, 1.15, 1.4, 1.1, 1.2],
        "duration_sec": 660,
    },
    {
        "code": "7B",
        "name": "College to Railway Station (via Market)",
        "direction": "up",
        "stops": [
            ("STOP_COLLEGE", 0),
            ("STOP_LIBRARY", 260),
            ("STOP_MARKET", 600),
            ("STOP_PARK", 780),
            ("STOP_CENTRAL", 900),
            ("STOP_RAILWAY", 1080),
        ],
        "factors": [1.0, 1.25, 1.5, 1.3, 1.15, 1.2],
        "duration_sec": 1080,
    },
    {
        "code": "3C",
        "name": "Hospital to Central",
        "direction": "down",
        "stops": [
            ("STOP_HOSPITAL", 0),
            ("STOP_LIBRARY", 300),
            ("STOP_GOVT", 480),
            ("STOP_CENTRAL", 720),
        ],
        "factors": [1.0, 1.2, 1.35, 1.25],
        "duration_sec": 720,
    },
]

# ---------------------------------------------------------------------------
# Buses  ->  (reg_no, capacity, wheelchair, low_floor)
# ---------------------------------------------------------------------------
BUSES = [
    ("KA01AB1234", 50, True, True),    # bus 1 -> 21A trip  (crowded, accessible)
    ("KA01AB5678", 50, False, False),  # bus 2 -> 7B trip   (empty, basic)
    ("KA05CD9012", 60, True, True),    # bus 3 -> 3C trip
    ("KA05CD3456", 50, False, True),   # bus 4 -> spare / out of service demo
]

# ---------------------------------------------------------------------------
# Trips.  seed_load is the headline demo number.
# ---------------------------------------------------------------------------
TRIPS = [
    # (bus_index, route_code, seed_load)
    (0, "21A", 35),  # 35/50 = 0.70 -> MED   the crowded fast option
    (1, "7B", 12),   # 12/50 = 0.24 -> LOW   the empty slow option
    (2, "3C", 52),   # 52/60 = 0.87 -> HIGH  proves the red band renders
]

# Start each trip a little way along so buses are already moving on first run.
INITIAL_PROGRESS = {
    "21A": 0.28,
    "7B": 0.15,
    "3C": 0.40,
}


def seed(reset: bool = False, url: str | None = None) -> None:
    Session = get_sessionmaker(url)
    engine_url = url or None

    if reset:
        print("Dropping and recreating all tables ...")
        reset_database(engine_url)

    # create_all is idempotent
    from simulation_ml.db.models import create_all

    create_all(engine_url)

    with Session() as s:
        if s.query(Route).count() > 0:
            print("Database already seeded - skipping. Use --reset to rebuild.")
            return

        # ---- stops ------------------------------------------------------
        stop_by_code: dict[str, Stop] = {}
        for code, name, lat, lon, accessible in STOPS:
            st = Stop(code=code, name=name, lat=lat, lon=lon, accessible=accessible)
            s.add(st)
            stop_by_code[code] = st
        s.flush()
        print(f"  stops   {len(STOPS)}")

        # ---- buses ------------------------------------------------------
        bus_objs = [
            Bus(reg_no=reg, capacity=cap, wheelchair=wc, low_floor=lf)
            for reg, cap, wc, lf in BUSES
        ]
        for b in bus_objs:
            s.add(b)
        s.flush()
        print(f"  buses   {len(bus_objs)}")

        # ---- routes + route_stop + schedule offsets + segment stats -----
        route_by_code: dict[str, Route] = {}
        total_segments = 0
        for spec in ROUTES:
            rt = Route(code=spec["code"], name=spec["name"], direction=spec["direction"])
            s.add(rt)
            s.flush()
            route_by_code[spec["code"]] = rt

            stops = spec["stops"]
            factors = spec["factors"]

            for seq, (stop_code, offset) in enumerate(stops):
                s.add(
                    RouteStop(
                        route_id=rt.id,
                        stop_id=stop_by_code[stop_code].id,
                        seq=seq,
                        scheduled_offset_sec=offset,
                    )
                )

            # segment stats: observed = scheduled * factor for this hop.
            # factors[i] describes the segment LEAVING stop i.
            for seq in range(len(stops) - 1):
                sched_sec = stops[seq + 1][1] - stops[seq][1]
                total_segments += 1
                s.add(
                    SegmentStat(
                        route_id=rt.id,
                        from_stop_id=stop_by_code[stops[seq][0]].id,
                        to_stop_id=stop_by_code[stops[seq + 1][0]].id,
                        sched_travel_sec=sched_sec,
                        avg_travel_sec=float(sched_sec) * factors[seq],
                        samples=140 + seq * 15,
                        observed_at=utcnow(),
                    )
                )
        s.flush()
        print(f"  routes  {len(ROUTES)}  ({total_segments} segments with observed stats)")

        # ---- trips ------------------------------------------------------
        now = utcnow()
        trip_by_route: dict[str, Trip] = {}
        for bus_idx, route_code, seed_load in TRIPS:
            spec = next(r for r in ROUTES if r["code"] == route_code)
            rt = route_by_code[route_code]
            bus = bus_objs[bus_idx]
            progress = INITIAL_PROGRESS.get(route_code, 0.0)

            tr = Trip(
                bus_id=bus.id,
                route_id=rt.id,
                direction=spec["direction"],
                status="active",
                started_at=now,
                planned_duration_sec=spec["duration_sec"],
            )
            s.add(tr)
            s.flush()
            trip_by_route[route_code] = tr

            # timetable rows for the whole trip
            for stop_code, offset in spec["stops"]:
                s.add(
                    Schedule(
                        trip_id=tr.id,
                        stop_id=stop_by_code[stop_code].id,
                        scheduled_offset_sec=offset,
                        scheduled_arrival=None,
                    )
                )

            # Seed a crowd row at the stop the bus is just leaving. This is the
            # number the API surfaces, so it must match the trip's story.
            route_stop_list = sorted(
                [rs for rs in rt.route_stops], key=lambda r: r.seq
            )
            current_seq = min(int(progress * len(route_stop_list)), len(route_stop_list) - 1)
            here = route_stop_list[current_seq]

            s.add(
                Crowd(
                    trip_id=tr.id,
                    stop_id=here.stop_id,
                    load=seed_load,
                    capacity=bus.capacity,
                    level=crowd_level_for(seed_load, bus.capacity),
                    ts=now,
                )
            )

            # One telemetry tick so /api/buses/active is non-empty immediately,
            # before the simulator is ever started.
            stops_ordered = route_stop_list
            frac = progress * (len(stops_ordered) - 1)
            i = min(int(frac), len(stops_ordered) - 2)
            t = frac - i
            a, b = stops_ordered[i].stop, stops_ordered[i + 1].stop
            from simulation_ml.db.models import Location

            s.add(
                Location(
                    bus_id=bus.id,
                    trip_id=tr.id,
                    lat=a.lat + (b.lat - a.lat) * t,
                    lon=a.lon + (b.lon - a.lon) * t,
                    speed_kmph=24.0,
                    heading=0.0,
                    seq_progress=progress,
                    ts=now,
                )
            )

        s.commit()
        print(f"  trips   {len(TRIPS)} (all active, with timetable + crowd + first tick)")

    print("\nSeed complete.")
    print("\n  Demo story baked in:")
    for route_code, note in [
        ("21A", "fast (11 min), MED  35/50"),
        ("7B", "slow (18 min), LOW  12/50"),
        ("3C", "HIGH 52/60 - red band"),
    ]:
        print(f"    {route_code}  {note}")
    print("\n  Plan STOP_COLLEGE -> STOP_RAILWAY and you get two options.")
    print("  Next: python -m simulation_ml.simulate --speed 5 --interval 2")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Seed the RideSmart demo database")
    ap.add_argument(
        "--reset", action="store_true", help="drop all tables before seeding"
    )
    ap.add_argument("--url", default=None, help="override DATABASE_URL")
    args = ap.parse_args()
    seed(reset=args.reset, url=args.url)