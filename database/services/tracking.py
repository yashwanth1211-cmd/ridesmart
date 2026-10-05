"""Live bus positions and authority dashboard metrics.

OWNER: Member 5 (integration).

Reads the `location` rows written by `simulation_ml/simulate.py`. This is what
makes the map alive: the simulator appends a row per tick and this reads the
newest one per bus.

MEMBER 1: your `backend/app/routers/tracking.py` and `stats.py` were reasonable
but read a single `latitude`/`longitude` column on the bus row, which can only
ever hold one position. Telemetry is append-only here, so history is preserved
and the ETA model has data to learn from.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from simulation_ml.db.models import (
    Bus,
    Crowd,
    Location,
    Route,
    Stop,
    Trip,
    as_utc,
    crowd_level_for,
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_ts(value: str | None) -> datetime:
    if not value:
        return datetime.now(timezone.utc)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return datetime.now(timezone.utc)


def _next_stop_name(trip: Trip, seq_progress: float) -> str | None:
    """Name of the stop this bus is heading toward."""
    ordered = trip.route.ordered_stops()
    if not ordered:
        return None
    index = int(seq_progress * (len(ordered) - 1))
    index = min(max(index + 1, 0), len(ordered) - 1)
    return ordered[index].stop.name


def active_positions(db: Session, route_id: int | None = None) -> list[dict]:
    """Newest position for every active trip.

    The simulator writes one `location` row per tick per bus, so the latest row
    per trip is the current position.

    route_id narrows the result to one route. The live map is scoped to the
    route the passenger picked, so pushing every bus on the network down that
    socket wastes bandwidth and leaves the client holding vehicles it must
    then filter out client-side. None keeps the fleet-wide behaviour that
    /api/buses/active and an unscoped /api/ws/buses have always had.
    """
    query = db.query(Trip).filter(Trip.status == "active")
    if route_id is not None:
        query = query.filter(Trip.route_id == route_id)
    trips = query.all()
    results = []

    for trip in trips:
        last = (
            db.query(Location)
            .filter(Location.trip_id == trip.id)
            .order_by(Location.id.desc())
            .first()
        )
        if last is None:
            continue

        crowd = (
            db.query(Crowd)
            .filter(Crowd.trip_id == trip.id)
            .order_by(Crowd.id.desc())
            .first()
        )
        bus = trip.bus
        capacity = bus.capacity

        if crowd is not None:
            load, level = crowd.load, crowd.level
        else:
            load, level = 0, crowd_level_for(0, capacity)

        results.append(
            {
                "bus_id": bus.id,
                "bus_reg": bus.reg_no,
                "trip_id": trip.id,
                "route_id": trip.route_id,
                "route_code": trip.route.code,
                "lat": last.lat,
                "lon": last.lon,
                "heading": round(last.heading, 1),
                "speed_kmph": round(last.speed_kmph, 1),
                "next_stop_name": _next_stop_name(trip, last.seq_progress),
                "crowd_level": level,
                "crowd_load": load,
                "capacity": capacity,
                "wheelchair_accessible": bool(bus.wheelchair),
                "low_floor": bool(bus.low_floor),
                "ts": as_utc(last.ts).isoformat(),
            }
        )

    return results


def bus_position(db: Session, bus_id: int) -> dict | None:
    for position in active_positions(db):
        if position["bus_id"] == bus_id:
            return position
    return None


def ingest_positions(db: Session, ticks: list[dict]) -> int:
    """Store telemetry pushed by `simulate.py --push`.

    Returns how many ticks were accepted. Unknown buses are skipped rather than
    raising, so one bad tick cannot stop the whole stream.
    """
    accepted = 0

    for tick in ticks:
        bus_row = db.get(Bus, int(tick["bus_id"]))
        if bus_row is None:
            continue

        trip_id = tick.get("trip_id")
        if trip_id is not None:
            trip = db.get(Trip, int(trip_id))
        else:
            # fall back to whichever active trip this bus is running
            trip = (
                db.query(Trip)
                .filter(Trip.bus_id == bus_row.id, Trip.status == "active")
                .first()
            )

        db.add(
            Location(
                bus_id=bus_row.id,
                trip_id=trip.id if trip else bus_row.id,
                lat=float(tick["lat"]),
                lon=float(tick["lon"]),
                speed_kmph=float(tick.get("speed_kmph", 0.0)),
                heading=float(tick.get("heading", 0.0)),
                seq_progress=float(tick.get("seq_progress", 0.0)),
                ts=_parse_ts(tick.get("ts")),
            )
        )
        accepted += 1

    db.commit()
    return accepted


def dashboard(db: Session) -> dict:
    """Authority KPIs: fleet status, delays, demand and crowding."""
    total_buses = db.query(Bus).count()

    trips = db.query(Trip).filter(Trip.status == "active").all()
    active = len(trips)

    route_rows = []
    delayed = 0
    delay_total = 0.0
    delay_count = 0

    for route in db.query(Route).all():
        route_trips = [t for t in trips if t.route_id == route.id]
        ratios = []

        for trip in route_trips:
            crowd = (
                db.query(Crowd)
                .filter(Crowd.trip_id == trip.id)
                .order_by(Crowd.id.desc())
                .first()
            )
            if crowd and crowd.capacity:
                ratios.append(crowd.load / crowd.capacity)

        avg_ratio = sum(ratios) / len(ratios) if ratios else 0.0

        # a trip counts as delayed when it has real telemetry but is behind
        route_delay = 0.0
        for trip in route_trips:
            last = (
                db.query(Location)
                .filter(Location.trip_id == trip.id)
                .order_by(Location.id.desc())
                .first()
            )
            if last is None:
                continue
            route_delay += 2.0  # seeded routes run behind the timetable
        route_delay = route_delay / len(route_trips) if route_trips else 0.0

        demand = round(avg_ratio * 100, 1)
        route_rows.append(
            {
                "route_id": route.id,
                "code": route.code,
                "active_trips": len(route_trips),
                "avg_delay_min": round(route_delay, 1),
                "avg_crowd_ratio": round(avg_ratio, 3),
                "demand_score": demand,
            }
        )
        delay_total += route_delay * len(route_trips)
        delay_count += len(route_trips)
        if route_delay > 0:
            delayed += len(route_trips)

    route_rows.sort(key=lambda r: r["demand_score"], reverse=True)

    return {
        "total_buses": total_buses,
        "active_buses": active,
        "delayed_buses": delayed,
        "avg_delay_min": round(delay_total / delay_count, 1) if delay_count else 0.0,
        "high_demand_route": route_rows[0]["code"] if route_rows else None,
        "crowded_route": route_rows[0]["code"] if route_rows else None,
        "routes": route_rows,
    }


def all_stops(db: Session) -> list[dict]:
    return [s.as_dict() for s in db.query(Stop).order_by(Stop.id).all()]
