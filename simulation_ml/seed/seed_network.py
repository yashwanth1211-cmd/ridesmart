"""Write the synthetic Vellore - Katpadi network into the database.

OWNER: Member 5.

Called by ``seed(seed(include_network=True))`` / ``python -m simulation_ml.seed.seed
--network``. See network_data.py for what the data is and why it is synthetic.

Everything here is ADDITIVE. The three OSM/OSRM demo routes seeded by seed.py are
left completely alone, and stops that already exist are reused rather than
duplicated - the network references ``STOP_KATPADI_JUNCTION`` by code instead of
putting a second pin on Katpadi Junction.
"""

from __future__ import annotations

import math
from datetime import timedelta

from sqlalchemy.orm import Session

from simulation_ml.db.models import (
    Bus,
    Crowd,
    Location,
    Route,
    RouteShapePoint,
    RouteStop,
    Schedule,
    SegmentStat,
    ServicePattern,
    Stop,
    Trip,
    crowd_level_for,
    peak_load_for,
    utcnow,
)
from simulation_ml.seed.network_data import (
    NETWORK_STOPS,
    REUSED_STOP_CODES,
    build_directional_routes,
    build_fleet,
    network_summary,
)


def _stop_name(code: str) -> str:
    for c, name, *_ in NETWORK_STOPS:
        if c == code:
            return name
    return code.replace("STOP_", "").replace("_", " ").title()


"""
Base occupancy as a fraction of capacity, per bus on a route.

Fixed fractions rather than a formula over the index, because the property that
matters is the SPREAD across all three crowd bands: the planner's whole point is
choosing between a packed bus and an empty one, and a seed where every bus lands
in the same band makes that choice untestable and untrue.

The bands are deliberately not evenly sized. Real occupancy clusters in the
middle and at the top - most services run half full and a few run flat out - so
'med' and 'high' get more buses than 'low'. Ordered to alternate with position
(`i % len`) so a bus sitting at the head of the route is not always the empty
one, which would make the seed's picture of a corridor implausibly tidy.

    low  < 0.40      med  0.40 .. 0.75      high  >= 0.75
"""
_CROWD_FRACTIONS = (0.22, 0.55, 0.88, 0.34, 0.71)


def _place_along_shape(legs: list[dict], fraction: float) -> tuple[float, float, int]:
    """(lat, lon, stops_reached) at `fraction` of the way along a route.

    The same cum_m arithmetic the simulator uses, so a freshly seeded bus is
    sitting on the road it will drive rather than in a field beside it.

    The third value counts how many stop-to-stop hops have been completed, which
    is what `seq` means everywhere else. It is tracked per leg rather than
    inferred from the vertex index, because a leg carries four vertices and only
    one stop boundary.
    """
    points: list[tuple[float, float, float, int]] = []  # (lat, lon, cum_m, leg)
    cum = 0.0
    prev = None
    for leg_idx, leg in enumerate(legs):
        for lat, lon in leg["coords"]:
            if prev is not None:
                cum += _haversine_m(prev[0], prev[1], lat, lon)
            points.append((lat, lon, cum, leg_idx))
            prev = (lat, lon)

    if len(points) < 2:
        lat, lon = legs[0]["coords"][0] if legs else (0.0, 0.0)
        return lat, lon, 0

    total = points[-1][2] or 1.0
    target = max(0.0, min(1.0, fraction)) * total

    for i in range(len(points) - 1):
        if points[i + 1][2] >= target:
            span = points[i + 1][2] - points[i][2]
            t = 0.0 if span <= 0 else (target - points[i][2]) / span
            return (
                points[i][0] + (points[i + 1][0] - points[i][0]) * t,
                points[i][1] + (points[i + 1][1] - points[i][1]) * t,
                points[i][3],
            )

    return points[-1][0], points[-1][1], len(legs) - 1


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def seed_network(session: Session) -> dict:
    """Create the network's stops, routes, timetable, fleet and live trips.

    Returns the summary dict from network_data.network_summary(), plus row
    counts, so the caller can print something honest.
    """
    now = utcnow()

    # ---- stops: reuse anything that already exists, create the rest ------
    existing = {s.code: s for s in session.query(Stop).all()}
    created_stops = 0

    for code, name, lat, lon, accessible in NETWORK_STOPS:
        if code in existing:
            continue
        row = Stop(code=code, name=name, lat=lat, lon=lon, accessible=accessible, kind="transit")
        session.add(row)
        existing[code] = row
        created_stops += 1

    for code in REUSED_STOP_CODES:
        if code not in existing:
            # A stop the new network needs but the OSM file does not define.
            # Failing loudly beats writing a route that references nothing.
            raise ValueError(
                f"{code} is referenced by the synthetic network but is not in "
                f"the database. data/real_routes.json and network_data.py "
                f"REUSED_STOP_CODES have drifted apart."
            )

    session.flush()

    # ---- resolve coordinates for the shape builder ------------------------
    stop_coords = {code: (s.lat, s.lon) for code, s in existing.items()}

    specs = build_directional_routes(stop_coords)
    fleet = build_fleet()

    route_by_key: dict[tuple[str, str], Route] = {}
    total_segments = 0
    shape_points = 0

    for spec in specs:
        route = Route(
            code=spec["code"],
            route_number=spec["route_number"],
            name=spec["name"],
            direction=spec["direction"],
        )
        session.add(route)
        session.flush()
        route_by_key[(spec["route_number"], spec["direction"])] = route

        for seq, st in enumerate(spec["stops"]):
            session.add(
                RouteStop(
                    route_id=route.id,
                    stop_id=existing[st["code"]].id,
                    seq=seq,
                    scheduled_offset_sec=st["offset_sec"],
                    leg_distance_m=st["leg_distance_m"],
                )
            )

        # Observed travel times, so the planner's ETA has a baseline on hour one
        # rather than falling back to the timetable for every leg.
        for seq in range(len(spec["stops"]) - 1):
            sched = spec["stops"][seq + 1]["offset_sec"] - spec["stops"][seq]["offset_sec"]
            total_segments += 1
            session.add(
                SegmentStat(
                    route_id=route.id,
                    from_stop_id=existing[spec["stops"][seq]["code"]].id,
                    to_stop_id=existing[spec["stops"][seq + 1]["code"]].id,
                    sched_travel_sec=sched,
                    avg_travel_sec=float(sched) * spec["factors"][seq],
                    samples=60 + seq * 9,
                    observed_at=now,
                )
            )

        # Approximate geometry, so the map has a line and the simulator has
        # something to walk.
        cum = 0.0
        prev = None
        for leg_idx, leg in enumerate(spec["legs"]):
            for seq, (lat, lon) in enumerate(leg["coords"]):
                if prev is not None:
                    cum += _haversine_m(prev[0], prev[1], lat, lon)
                session.add(
                    RouteShapePoint(
                        route_id=route.id, leg=leg_idx, seq=seq,
                        lat=lat, lon=lon, cum_m=cum,
                    )
                )
                shape_points += 1
                prev = (lat, lon)

        # Through-the-day timetable for this direction.
        session.add(
            ServicePattern(
                route_id=route.id,
                direction=spec["direction"],
                first_departure=spec["first_departure"],
                last_departure=spec["last_departure"],
                headway_min=spec["headway_min"],
            )
        )

    session.flush()

    # ---- fleet -----------------------------------------------------------
    # Continue the fleet numbering rather than restarting it. These 96 buses are
    # added to a database that already holds the demo fleet, so "Bus 4" has to
    # stay unique - a second vehicle with that name would make the map's bus
    # label ambiguous rather than helpful.
    next_number = (session.query(Bus.id).count() or 0) + 1
    bus_objs: dict[tuple[str, str], list[Bus]] = {}
    for entry in fleet:
        row = Bus(
            reg_no=entry["reg_no"],
            display_name=f"Bus {next_number}",
            capacity=entry["capacity"],
            wheelchair=entry["wheelchair"],
            low_floor=entry["low_floor"],
            bus_type=entry["bus_type"],
        )
        next_number += 1
        session.add(row)
        bus_objs.setdefault((entry["route_number"], entry["direction"]), []).append(row)

    session.flush()

    # ---- live trips ------------------------------------------------------
    #
    # One active trip per bus. started_at is pushed backwards by a deterministic
    # fraction of the route's duration so buses are spread along their corridors
    # on first run rather than all sitting at the first stop.
    trips = 0
    for (number, direction), buses in bus_objs.items():
        route = route_by_key.get((number, direction))
        if route is None:
            # The fleet plan asks for a direction the route table does not have.
            # Skipping loudly in the count beats a crash halfway through a seed.
            continue

        spec = next(
            s for s in specs if s["route_number"] == number and s["direction"] == direction
        )
        ordered = spec["stops"]

        for i, bus in enumerate(buses):
            # Spread the buses along the route, not clustered at the front.
            #
            # Two properties matter and they pull against each other:
            #
            #  - coverage. With `n` buses all within the first third of the
            #    route, a journey from a mid-route stop finds every one of them
            #    already past it and returns nothing.
            #  - catchable. A bus must also sit close enough BEHIND a boarding
            #    point that the planner will offer it, or it is invisible.
            #
            # So the spread runs 0.04 .. 0.78 in even steps. The upper end is
            # deliberate: a bus at 0.78 of a six-stop route is past stop 4 and
            # is correctly reported as unreachable for a journey starting at
            # stop 5, which is what a real corridor looks like part-way through
            # the day.
            fraction = 0.04 + (0.74 * i / max(1, len(buses) - 1))
            elapsed = timedelta(seconds=spec["duration_sec"] * fraction)

            trip = Trip(
                bus_id=bus.id,
                route_id=route.id,
                direction=direction,
                status="active",
                started_at=now - elapsed,
                planned_duration_sec=spec["duration_sec"],
            )
            session.add(trip)
            session.flush()
            trips += 1

            for st in ordered:
                session.add(
                    Schedule(
                        trip_id=trip.id,
                        stop_id=existing[st["code"]].id,
                        scheduled_offset_sec=st["offset_sec"],
                        scheduled_arrival=None,
                    )
                )

            # Where the bus should be saying it is. Determined from the shape,
            # then mapped back onto the stop list so the stored current/next stop
            # is consistent with the position rather than merely close to it.
            lat, lon, reached_seq = _place_along_shape(spec["legs"], fraction)
            reached_seq = min(reached_seq, len(ordered) - 1)
            next_seq = min(reached_seq + 1, len(ordered) - 1)

            # Base load varies per bus so the network is not uniformly packed,
            # then the current peak factor is applied on top.
            base_load = int(bus.capacity * _CROWD_FRACTIONS[i % len(_CROWD_FRACTIONS)])
            load = peak_load_for(base_load, bus.capacity, now)

            session.add(
                Crowd(
                    trip_id=trip.id,
                    stop_id=existing[ordered[reached_seq]["code"]].id,
                    load=load,
                    capacity=bus.capacity,
                    level=crowd_level_for(load, bus.capacity),
                    ts=now,
                )
            )

            # Behind the timetable by roughly the seeded slowdown, less wherever
            # the bus has not started moving yet.
            session.add(
                Location(
                    bus_id=bus.id,
                    trip_id=trip.id,
                    lat=lat,
                    lon=lon,
                    speed_kmph=22.0,
                    heading=0.0,
                    seq_progress=fraction,
                    current_stop_id=existing[ordered[reached_seq]["code"]].id,
                    next_stop_id=existing[ordered[next_seq]["code"]].id,
                    delay_sec=float(max(0, int(elapsed.total_seconds() * 0.12))),
                    ts=now,
                )
            )

    session.flush()

    summary = network_summary()
    summary.update(
        {
            "stops_created": created_stops,
            "routes_written": len(specs),
            "segments": total_segments,
            "shape_points": shape_points,
            "active_trips": trips,
        }
    )
    return summary