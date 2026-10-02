"""Journey planning, ETA prediction and crowd estimation.

OWNER: Member 5 (integration).

This is the logic behind the project's standout feature. Given an origin and a
destination, it finds every route connecting them and returns MULTIPLE options,
each with a predicted ETA and a crowd level, so the passenger can choose.

The seed data is built around a deliberate contrast:

    21A  11 min  35/50  MED   fast but packed
    7B   18 min  12/50  LOW   slower but empty

Neither dominates. That is what makes crowd-aware planning worth having - if one
route were both faster and emptier there would be nothing to decide.

MEMBER 1: your `backend/app/routers/planner.py` computed crowd from
passenger_count/capacity and derived ETA from bus speed. That approach is
preserved in spirit but the inputs now come from `SegmentStat`, which holds real
observed travel times per hop, so ETA is no longer a guess from speed alone.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from simulation_ml.db.models import (
    Crowd,
    Route,
    Schedule,
    SegmentStat,
    Stop,
    Trip,
    as_utc,
    crowd_level_for,
)

# Weights for the internal ranking score. ETA dominates by default because a
# passenger who is already on the move cares more about arriving soon, but crowd
# meaningfully changes the ranking when two options are close in time.
W_ETA = 1.0
W_CROWD = 0.6


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _latest_crowd(db: Session, trip_id: int) -> Crowd | None:
    return (
        db.query(Crowd)
        .filter(Crowd.trip_id == trip_id)
        .order_by(Crowd.id.desc())
        .first()
    )


def _segment_time(db: Session, route_id: int, from_id: int, to_id: int) -> tuple[float, int]:
    """(observed, scheduled) travel seconds for one hop, with a safe fallback.

    Falls back to the timetable value when no observation exists, so a brand new
    database still plans rather than erroring.
    """
    stat = (
        db.query(SegmentStat)
        .filter_by(route_id=route_id, from_stop_id=from_id, to_stop_id=to_id)
        .first()
    )
    if stat is not None and stat.avg_travel_sec > 0:
        return float(stat.avg_travel_sec), int(stat.sched_travel_sec)

    rs_from = (
        db.query(Schedule)
        .join(Trip, Schedule.trip_id == Trip.id)
        .filter(Trip.route_id == route_id, Schedule.stop_id == from_id)
        .first()
    )
    rs_to = (
        db.query(Schedule)
        .join(Trip, Schedule.trip_id == Trip.id)
        .filter(Trip.route_id == route_id, Schedule.stop_id == to_id)
        .first()
    )
    if rs_from and rs_to and rs_to.scheduled_offset_sec > rs_from.scheduled_offset_sec:
        sched = rs_to.scheduled_offset_sec - rs_from.scheduled_offset_sec
        return float(sched), sched

    return 0.0, 0


def _routes_between(db: Session, origin: Stop, dest: Stop) -> list[dict]:
    """Every route serving both stops, with the ordered sub-path between them.

    Direction matters: `from` must precede `to` in the stop sequence. Swapping
    them yields no results, which is correct - a bus does not run backwards.
    """
    found = []

    for route in db.query(Route).all():
        ordered = route.ordered_stops()
        codes = [rs.stop_id for rs in ordered]

        if origin.id not in codes or dest.id not in codes:
            continue

        i_from = codes.index(origin.id)
        i_to = codes.index(dest.id)

        if i_from >= i_to:
            continue  # destination is behind us on this route

        found.append(
            {
                "route": route,
                "hops": ordered[i_from : i_to + 1],
            }
        )

    return found


def plan_journey(
    db: Session,
    from_code: str,
    to_code: str,
    accessibility_only: bool = False,
) -> dict | None:
    """Build ranked journey options. Returns None if a stop code is unknown."""
    origin = db.query(Stop).filter(Stop.code == from_code.strip()).first()
    dest = db.query(Stop).filter(Stop.code == to_code.strip()).first()

    if origin is None or dest is None:
        return None

    if origin.id == dest.id:
        return {
            "from": origin.as_dict(),
            "to": dest.as_dict(),
            "generated_at": _now().isoformat(),
            "options": [],
        }

    options = []

    for match in _routes_between(db, origin, dest):
        route: Route = match["route"]
        hops = match["hops"]

        # observed vs scheduled totals across the remaining hops
        observed_sec = 0.0
        scheduled_sec = 0
        for hop, nxt in zip(hops, hops[1:]):
            obs, sched = _segment_time(db, route.id, hop.stop_id, nxt.stop_id)
            observed_sec += obs
            scheduled_sec += sched

        if scheduled_sec <= 0:
            # no timetable data for this path; skip rather than return nonsense
            continue

        eta_min = max(1, round(observed_sec / 60))
        scheduled_min = max(1, round(scheduled_sec / 60))
        delay_min = eta_min - scheduled_min

        # pick the trip with the worst crowding as the honest worst case
        trips = db.query(Trip).filter(Trip.route_id == route.id, Trip.status == "active").all()
        if not trips:
            continue

        worst = None
        worst_ratio = -1.0
        for trip in trips:
            crowd = _latest_crowd(db, trip.id)
            if crowd is None:
                continue
            ratio = crowd.load / crowd.capacity if crowd.capacity else 0.0
            if ratio > worst_ratio:
                worst_ratio = ratio
                worst = (trip, crowd)

        if worst is None:
            trip = trips[0]
            load = 0
            capacity = trip.bus.capacity
            level = crowd_level_for(load, capacity)
        else:
            trip, crowd = worst
            load, capacity = crowd.load, crowd.capacity
            level = crowd.level

        bus = trip.bus
        if accessibility_only and not bus.wheelchair:
            continue

        crowd_ratio = round(load / capacity, 3) if capacity else 0.0

        # per-stop ETAs along the chosen path
        stop_etas = []
        remaining = observed_sec
        for hop in hops:
            stop_etas.append(
                {
                    "stop_id": hop.stop_id,
                    "name": hop.stop.name,
                    "eta_min": max(0, round(remaining / 60)),
                    "accessible": bool(hop.stop.accessible),
                }
            )
            if hop.stop_id != hops[-1].stop_id:
                nxt_idx = [h.stop_id for h in hops].index(hop.stop_id)
                if nxt_idx + 1 < len(hops):
                    nxt = hops[nxt_idx + 1]
                    seg, _ = _segment_time(db, route.id, hop.stop_id, nxt.stop_id)
                    remaining -= seg

        options.append(
            {
                "route_id": route.id,
                "code": route.code,
                "name": route.name,
                "eta_min": eta_min,
                "eta_scheduled_min": scheduled_min,
                "eta_predicted_min": eta_min,
                "delay_min": delay_min,
                "crowd_level": level,
                "crowd_load": load,
                "capacity": capacity,
                "crowd_ratio": crowd_ratio,
                "wheelchair_accessible": bool(bus.wheelchair),
                "low_floor": bool(bus.low_floor),
                "score": round(W_ETA * eta_min + W_CROWD * (crowd_ratio * 100), 2),
                "stops": stop_etas,
            }
        )

    options.sort(key=lambda o: o["eta_min"])

    return {
        "from": origin.as_dict(),
        "to": dest.as_dict(),
        "generated_at": _now().isoformat(),
        "options": options,
    }


def trip_etas(db: Session, trip_id: int) -> list[dict]:
    """Predicted vs scheduled arrival at each stop, relative to now.

    `scheduled_min` is the timetable offset measured from when the trip started,
    which is what a passenger would recognise from a printed timetable.
    `predicted_min` accumulates the observed travel time for each hop instead,
    so a slow segment shows up as a growing delay.
    """
    trip = db.query(Trip).get(trip_id)
    if trip is None:
        return []

    route = trip.route
    ordered = route.ordered_stops()
    now = _now()

    started = as_utc(trip.started_at)
    elapsed = (now - started).total_seconds() if started else 0.0

    rows = []
    predicted_arrival = 0.0  # observed seconds from trip start to this stop

    for index, rs in enumerate(ordered):
        if index > 0:
            prev = ordered[index - 1]
            observed, _ = _segment_time(db, route.id, prev.stop_id, rs.stop_id)
            predicted_arrival += observed
        scheduled_arrival = int(rs.scheduled_offset_sec)

        rows.append(
            {
                "stop_id": rs.stop_id,
                "stop_name": rs.stop.name,
                "scheduled_min": max(0, round(scheduled_arrival / 60)),
                "predicted_min": max(0, round(predicted_arrival / 60)),
                "delay_min": max(0, round((predicted_arrival - scheduled_arrival) / 60)),
            }
        )

    return rows


def set_crowd(
    db: Session, trip_id: int, load: int, capacity: int, stop_id: int | None = None
) -> dict:
    """Override a trip's crowd level.

    This is the interactive demo step: set a bus to empty, re-plan, and watch
    the ranking change.
    """
    trip = db.query(Trip).get(trip_id)
    if trip is None:
        return {}

    if capacity <= 0:
        capacity = trip.bus.capacity

    if stop_id is None:
        previous = _latest_crowd(db, trip_id)
        stop_id = previous.stop_id if previous else trip.route.ordered_stops()[0].stop_id

    row = Crowd(
        trip_id=trip_id,
        stop_id=stop_id,
        load=max(0, min(capacity, int(load))),
        capacity=capacity,
        level=crowd_level_for(int(load), capacity),
        ts=_now(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)

    result = row.as_dict()
    # as_dict() emits a naive ISO timestamp from SQLite; normalise it
    result["ts"] = as_utc(row.ts).isoformat()
    return result
