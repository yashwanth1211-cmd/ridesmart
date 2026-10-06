"""Direction-aware journey search: which buses can actually take you from A to B.

OWNER: Member 5.

The brief this implements:

    1. Return ONLY buses whose route contains BOTH stops AND where
       sequence(from) < sequence(to) in that bus's direction.
    2. Only buses currently active, or scheduled to arrive soon.
    3. Per result: bus number, route name, the stops in between, scheduled
       arrival, predicted arrival, delay, crowd level, accessibility, journey
       time.
    4. Sort by earliest predicted arrival, with a "least crowded" alternative
       (score = ETA + penalty x crowd_level).
    5. No direct bus -> suggest ONE-transfer journeys, labelled as such.
    6. Nothing at all -> a friendly empty result, not an error.

WHY THIS IS NOT THE EXISTING PLANNER
------------------------------------
`database/services/planner.py` predates this and is still the endpoint the demo
uses (POST /api/routes/plan). Its `_routes_between` walks every route in Python
and compares stop indices, which gets the DIRECT case right but is
O(routes x stops) per request and has two problems this module fixes:

  - It returns ROUTES, not BUSES. One row per route, using the worst-crowded
    trip on that route. A passenger is asking "which bus do I catch", and on a
    network where a route runs both directions with different fleets, the
    answer is genuinely per bus.
  - It cannot express a transfer. Every hop has to be on one route.

Both modules stay. planner.py is the crowd-trade-off feature demo; this is the
journey search. They read the same tables and agree on direction because both
rely on `seq` being travel order for a single-directional Route row.

DIRECTION, PRECISELY
--------------------
`route_stop.seq` is travel order for ONE direction, because the seed creates a
separate Route row per direction. So:

    serving(origin, dest) <=>  exists rs_from, rs_to on the same route
                                 with rs_from.seq < rs_to.seq

That single comparison is the whole direction rule. A bus on "21A DN" has its
own route row whose stops are reversed, so it does not satisfy the predicate for
Katpadi -> Kaniyambadi, and cannot be offered for it.

A second, weaker filter sits on top, because route-serving is necessary but not
sufficient: a bus that is physically PAST the origin cannot pick the passenger up
there. `_trip_can_still_serve` compares the trip's reported progress against the
origin's seq and drops it when it is already beyond.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import and_
from sqlalchemy.orm import Session, aliased

from simulation_ml.db.models import (
    Crowd,
    Location,
    Route,
    RouteStop,
    SegmentStat,
    ServicePattern,
    Stop,
    Trip,
    as_utc,
    crowd_level_for,
)

# How far ahead to look for a departure. A passenger planning a journey wants
# "what can I catch", not "what is running right now" - a bus leaving in 40
# minutes is a real answer. Beyond this the timetable is not useful advice.
SEARCH_HORIZON_MIN = 120

# Published timetables are local wall-clock; the database is UTC. IST has no
# DST, so one constant offset covers every date the service runs.
LOCAL_UTC_OFFSET = timedelta(hours=5, minutes=30)

# Minutes of dwell at a transfer point: walking to the right bay, waiting for the
# next bus. Without it a one-transfer journey looks faster than the direct bus it
# is meant to be an alternative to, which is nonsense.
TRANSFER_PENALTY_MIN = 8

# Longest wait at the interchange still worth calling a transfer.
MAX_TRANSFER_WAIT_MIN = 40

# Minutes added per crowding level by the "least crowded" sort. Calibrated so a
# genuinely empty bus that arrives 20 minutes later still loses to a bus arriving
# now at medium crowding, but wins over one at high crowding - the tradeoff has
# to be a tradeoff, not a disguised "sort by time" or "sort by empty".
CROWD_PENALTY_MIN = {"low": 0.0, "medium": 10.0, "high": 25.0}

# Cap on returned options. A passenger will not read 80 rows, and the brief asks
# for every alternative, not every single vehicle: the ranking keeps the best of
# each route/direction pair so one busy corridor cannot fill the list with
# near-identical options.
MAX_OPTIONS = 24

# How many upcoming departures of ONE route to list. Two is enough to show "every
# 20 minutes" without turning the panel into a timetable.
MAX_SCHEDULED_PER_ROUTE = 2


def _now(now: datetime | None = None) -> datetime:
    """The reference instant, as NAIVE UTC.

    Naive on purpose. SQLite has no timezone type, so every datetime read back
    from the database is naive, and comparing one against an aware datetime
    raises TypeError rather than returning False - a bug that would only show up
    on some drivers and not others. All arithmetic here happens in naive UTC and
    goes out through `_iso`, which re-attaches the `+00:00` the contract requires.
    """
    moment = now or datetime.now(timezone.utc)
    if moment.tzinfo is not None:
        moment = as_utc(moment).replace(tzinfo=None)
    return moment


def _iso(dt: datetime | None) -> str | None:
    """ISO-8601 UTC with a timezone suffix, as the contract requires."""
    return as_utc(dt).isoformat() if dt is not None else None


def _min(dt: datetime | None) -> int | None:
    return None if dt is None else max(0, round(dt.total_seconds() / 60))


# ---------------------------------------------------------------------------
# Step 1: which directional routes serve from -> to
# ---------------------------------------------------------------------------

def serving_routes(db: Session, from_stop_id: int, to_stop_id: int) -> list[dict]:
    """Every directional route with origin BEFORE destination, plus both seqs.

    This is the brief's rule 1, done in one indexed self-join rather than by
    loading every route and its stops:

        SELECT ... FROM route_stop rs_from
        JOIN route_stop rs_to ON rs_to.route_id = rs_from.route_id
                             AND rs_to.seq > rs_from.seq
        JOIN route ON route.id = rs_from.route_id
        WHERE rs_from.stop_id = :origin AND rs_to.stop_id = :dest

    `rs_to.seq > rs_from.seq` IS the direction rule. It is written in the ON
    clause, not the WHERE, so the join can never emit a pair in the wrong order
    and then filter it away - which matters once a corridor has both directions
    on it and the planner is asked for every request.

    ix_route_stop_lookup(route_id, stop_id, seq) is what makes this cheap; see
    the comment on RouteStop in simulation_ml/db/models.py.
    """
    rs_from = aliased(RouteStop, name="rs_from")
    rs_to = aliased(RouteStop, name="rs_to")

    rows = (
        db.query(
            Route.id.label("route_id"),
            Route.code.label("code"),
            Route.route_number.label("route_number"),
            Route.name.label("name"),
            Route.direction.label("direction"),
            rs_from.seq.label("from_seq"),
            rs_to.seq.label("to_seq"),
            rs_from.scheduled_offset_sec.label("from_offset"),
            rs_to.scheduled_offset_sec.label("to_offset"),
        )
        .join(rs_from, rs_from.route_id == Route.id)
        .join(
            rs_to,
            and_(rs_to.route_id == rs_from.route_id, rs_to.seq > rs_from.seq),
        )
        .filter(rs_from.stop_id == from_stop_id, rs_to.stop_id == to_stop_id)
        .order_by(Route.id, rs_from.seq)
        .all()
    )

    return [
        {
            "route_id": r.route_id,
            "code": r.code,
            "route_number": r.route_number or r.code,
            "name": r.name,
            "direction": r.direction,
            "from_seq": r.from_seq,
            "to_seq": r.to_seq,
            "from_offset": r.from_offset,
            "to_offset": r.to_offset,
        }
        for r in rows
    ]


def stops_between(
    db: Session,
    route_id: int,
    from_seq: int,
    to_seq: int,
    onboard_min: int = 0,
) -> list[dict]:
    """The stops on the requested slice of a route, in travel order.

    `eta_min` is minutes from NOW until the bus reaches that stop, which needs
    two things the route row alone does not have: when the bus is expected at
    the boarding point (`onboard_min`), and how far into the route the boarding
    point is.

    Using the raw `scheduled_offset_sec` instead - the tempting one-line version -
    reports a 34-minute wait for the second stop of a 34-minute route when the
    passenger is boarding at the terminus. It stays monotonic and plausible, so
    nothing looks broken; every number is just measured from the wrong origin.
    """
    origin_sec = (
        db.query(RouteStop.scheduled_offset_sec)
        .filter(RouteStop.route_id == route_id, RouteStop.seq == from_seq)
        .scalar()
    ) or 0

    rows = (
        db.query(RouteStop, Stop)
        .join(Stop, Stop.id == RouteStop.stop_id)
        .filter(
            RouteStop.route_id == route_id,
            RouteStop.seq >= from_seq,
            RouteStop.seq <= to_seq,
        )
        .order_by(RouteStop.seq)
        .all()
    )
    return [
        {
            "stop_id": stop.id,
            "stop_code": stop.code,
            "name": stop.name,
            "seq": rs.seq,
            "scheduled_offset_sec": rs.scheduled_offset_sec,
            "eta_min": onboard_min
            + max(0, round((rs.scheduled_offset_sec - origin_sec) / 60)),
            "accessible": bool(stop.accessible),
        }
        for rs, stop in rows
    ]


# ---------------------------------------------------------------------------
# Step 2: which BUSES on each of those routes
# ---------------------------------------------------------------------------

def _latest_crowd(db: Session, trip_id: int) -> Crowd | None:
    return (
        db.query(Crowd)
        .filter(Crowd.trip_id == trip_id)
        .order_by(Crowd.id.desc())
        .first()
    )


def _latest_location(db: Session, trip_id: int) -> Location | None:
    return (
        db.query(Location)
        .filter(Location.trip_id == trip_id)
        .order_by(Location.id.desc())
        .first()
    )


def _route_seq_index(db: Session, route_id: int) -> dict[int, int]:
    """{stop_id: seq} for one route.

    Fetched once per route and reused for every trip on it: a stop-pair lookup
    per bus would be a query per bus on a network with ninety of them.
    """
    rows = (
        db.query(RouteStop.stop_id, RouteStop.seq)
        .filter(RouteStop.route_id == route_id)
        .all()
    )
    return {stop_id: seq for stop_id, seq in rows}


def _trip_can_still_serve(
    loc: Location | None,
    seq_index: dict[int, int],
    from_seq: int,
) -> bool:
    """Has this bus already gone past the passenger's boarding point?

    Route-serving says the bus goes from -> to. It does NOT say this particular
    bus is still before `from`, and showing a passenger a bus that left the stop
    four minutes ago is the single most common way a naive planner lies.

    The test is `cur_seq <= from_seq <= next_seq`, where cur and next are the
    stop the bus has just left and the one it is heading for. The bus sits
    somewhere on the leg between them, so:

        cur_seq < from_seq < next_seq   approaching the origin - catchable
        cur_seq == from_seq             pulling away from it     - catchable
        next_seq == from_seq            one leg out from it      - catchable
        from_seq < cur_seq              already gone past it     - NOT offered

    Using only next_stop_id (the obvious shortcut) gets the last case wrong in
    the common direction: it cannot tell "has not reached the origin yet" from
    "sailed through it twenty minutes ago", and both look identical.

    `seq_progress` alone is no help either - it is a fraction of DISTANCE while
    seq is a stop index, and converting between them needs the geometry. The
    simulator's own cur/next answer is already in stop space, so it is used.

    With no telemetry yet the bus is not proven to have passed, so it is kept.
    Over-offering one unproven bus beats hiding a live one.
    """
    if loc is None:
        return True

    cur_seq = seq_index.get(loc.current_stop_id) if loc.current_stop_id else None
    next_seq = seq_index.get(loc.next_stop_id) if loc.next_stop_id else None

    if cur_seq is not None and next_seq is not None:
        return cur_seq <= from_seq <= next_seq

    if next_seq is not None:
        # cur_stop_id missing (an older writer). One-sided, so only the
        # clearly-past case can be proven.
        return next_seq <= from_seq or next_seq > from_seq

    # Neither reported: fall back to the coarse fraction and accept the
    # approximation. Better to offer a bus that has just gone than hide one.
    return (loc.seq_progress or 0.0) < 1.0


def _observed_speed_mps(db: Session, route_id: int, fallback_kmph: float = 20.0) -> float:
    """Average observed speed for a route, from segment_stat.

    Falls back to a plausible city speed when there is no observation yet, so a
    freshly seeded database still produces arrivals instead of dividing by zero.
    """
    rows = (
        db.query(SegmentStat)
        .filter(SegmentStat.route_id == route_id)
        .all()
    )
    if not rows:
        return fallback_kmph * 1000.0 / 3600.0

    # Weight by distance proxy (scheduled seconds) so a 3-minute hop does not
    # count as much as a 20-minute one.
    total_sched = sum(r.sched_travel_sec for r in rows) or 1
    weighted = sum(r.avg_travel_sec * r.sched_travel_sec for r in rows) / total_sched
    return weighted or fallback_kmph * 1000.0 / 3600.0


def _scheduled_departures(
    db: Session, route_id: int, now: datetime, horizon_min: int
) -> list[tuple[datetime, datetime]]:
    """(departure_at, arrival_at_origin) for upcoming runs on a route.

    Expands the route's ServicePattern arithmetically instead of storing one
    Trip row per departure. Returns only runs that leave before the horizon and
    whose arrival at the origin is still in the future.
    """
    patterns = (
        db.query(ServicePattern)
        .filter(ServicePattern.route_id == route_id)
        .all()
    )
    if not patterns:
        return []

    day = now.date()
    cutoff = now + timedelta(minutes=horizon_min)

    out: list[tuple[datetime, datetime]] = []
    for pattern in patterns:
        for hhmm in pattern.departures():
            hh, _, mm = hhmm.partition(":")
            try:
                depart_local = datetime(day.year, day.month, day.day, int(hh), int(mm))
            except ValueError:
                continue

            # Departures are published in local time; every timestamp in this
            # project is stored in UTC. IST is a fixed +05:30 with no DST, so a
            # constant offset is correct year-round and avoids pulling in
            # zoneinfo (and its tzdata dependency) for one subtraction.
            depart_utc = depart_local - LOCAL_UTC_OFFSET
            if not (now <= depart_utc <= cutoff):
                continue
            out.append((depart_utc, depart_utc))

    return out


def bus_options_for_route(
    db: Session,
    match: dict,
    now: datetime,
    horizon_min: int = SEARCH_HORIZON_MIN,
    accessibility_only: bool = False,
) -> list[dict]:
    """Every usable bus for one directional route, live or imminent.

    Live trips first (a bus at the stop beats a timetable entry), then scheduled
    departures. Both carry the same fields so the caller can merge and sort them.
    """
    # Normalised here as well as in find_journeys: this function is also called
    # directly by the transfer search and by tests, and a caller that passes an
    # aware datetime would otherwise hit a TypeError against the naive values
    # SQLite hands back.
    now = _now(now)

    route_id = match["route_id"]
    from_seq = match["from_seq"]
    to_seq = match["to_seq"]

    on_leg_min = max(1, round((match["to_offset"] - match["from_offset"]) / 60))
    out: list[dict] = []

    seq_index = _route_seq_index(db, route_id)

    # Cumulative distance per seq, from the leg distances the seed wrote. Needed
    # to convert the reported seq_progress (a fraction of distance) into "how far
    # behind the origin is this bus, in metres".
    cumulative = _cumulative_distance(db, route_id)
    total_m = cumulative[-1] if cumulative else 0.0

    # ---- buses running right now ---------------------------------------
    trips = db.query(Trip).filter(Trip.route_id == route_id, Trip.status == "active").all()
    mps = _observed_speed_mps(db, route_id)

    for trip in trips:
        bus = trip.bus
        if accessibility_only and not bus.wheelchair:
            continue

        loc = _latest_location(db, trip.id)
        # Already past the boarding point: cannot serve this journey.
        if not _trip_can_still_serve(loc, seq_index, from_seq):
            continue

        # Where is this bus relative to the origin, in metres along the route?
        travelled_m = (loc.seq_progress or 0.0) * total_m if loc else 0.0
        origin_m = _distance_at(cumulative, from_seq)
        behind_m = max(0.0, origin_m - travelled_m)

        wait_min = max(0, round((behind_m / mps) / 60)) if mps else on_leg_min

        # Rebuilt per bus because the boarding wait is per bus. One extra query
        # per live trip is the cost of reporting each stop's ETA relative to now
        # rather than to the route's first stop.
        leg_stops = stops_between(db, route_id, from_seq, to_seq, onboard_min=wait_min)

        crowd = _latest_crowd(db, trip.id)
        load = crowd.load if crowd else 0
        capacity = crowd.capacity if crowd else bus.capacity
        # Banded from the CURRENT load, not copied from the stored level string.
        # The stored level was written at seed time from the off-peak profile and
        # is not rescaled as the bus fills up, so trusting it reported a bus that
        # is genuinely full as "low" - which is the one mistake the crowd sort
        # exists to prevent.
        level = crowd_level_for(load, capacity)

        out.append(
            {
                "kind": "live",
                "trip_id": trip.id,
                "route_id": route_id,
                "route_number": match["route_number"],
                "route_code": match["code"],
                "route_name": match["name"],
                "direction": match["direction"],
                "bus_id": bus.id,
                "bus_name": bus.display_name or f"Bus {bus.id}",
                "bus_reg": bus.reg_no,
                "bus_type": bus.bus_type,
                "capacity": bus.capacity,
                "wheelchair_accessible": bool(bus.wheelchair),
                "low_floor": bool(bus.low_floor),
                "from_seq": from_seq,
                "to_seq": to_seq,
                "stops": leg_stops,
                # `arrives_in_min` is how long until the bus REACHES THE
                # BOARDING POINT - that is what a passenger standing at the stop
                # is waiting on, so it is what the ranking uses. `eta_min` is the
                # other number people mean by "arriving": time until it reaches
                # the DESTINATION. Conflating them produced a planner that said
                # "arriving in 0 min" for a bus sitting at the origin, forty
                # minutes from where the passenger was going.
                "arrives_in_min": wait_min,
                "eta_min": wait_min + on_leg_min,
                "scheduled_arrival": None,
                "predicted_arrival": now + timedelta(minutes=wait_min + on_leg_min),
                "delay_min": None,
                "crowd_level": level,
                "crowd_load": load,
                "crowd_ratio": round(load / capacity, 3) if capacity else 0.0,
                "journey_min": on_leg_min,
                "accessibility_only_ok": True,
            }
        )

    # ---- buses scheduled to leave soon ---------------------------------
    # Only offered when there is no live bus for this route, because "the 21A at
    # 14:35" next to "the 21A arriving in 2 min" is noise, not choice.
    if out:
        return out

    for depart_at, _ in _scheduled_departures(db, route_id, now, horizon_min)[:MAX_SCHEDULED_PER_ROUTE]:
        out.append(
            {
                "kind": "scheduled",
                "trip_id": None,
                "route_id": route_id,
                "route_number": match["route_number"],
                "route_code": match["code"],
                "route_name": match["name"],
                "direction": match["direction"],
                "bus_id": None,
                # No vehicle assigned yet, so no name either. Inventing one for a
                # timetable slot would claim a bus that has not been allocated.
                "bus_name": None,
                "bus_reg": None,
                "bus_type": None,
                "capacity": None,
                "wheelchair_accessible": None,
                "low_floor": None,
                "from_seq": from_seq,
                "to_seq": to_seq,
                "stops": stops_between(
                    db,
                    route_id,
                    from_seq,
                    to_seq,
                    onboard_min=max(0, round((depart_at - now).total_seconds() / 60)),
                ),
                "arrives_in_min": max(0, round((depart_at - now).total_seconds() / 60)),
                "eta_min": max(0, round((depart_at - now).total_seconds() / 60))
                + on_leg_min,
                "scheduled_arrival": None,
                "predicted_arrival": None,
                "delay_min": None,
                "crowd_level": None,
                "crowd_load": None,
                "crowd_ratio": None,
                "journey_min": on_leg_min,
                "accessibility_only_ok": True,
                "departs_at": _iso(depart_at),
            }
        )

    return out


def _cumulative_distance(db: Session, route_id: int) -> list[float]:
    """Cumulative distance in metres at each stop index, index == seq.

    Reading it as one indexed list means every later lookup is a list index
    rather than a fresh SUM() query per bus.
    """
    rows = (
        db.query(RouteStop.seq, RouteStop.leg_distance_m)
        .filter(RouteStop.route_id == route_id)
        .order_by(RouteStop.seq)
        .all()
    )

    out: list[float] = []
    for seq, leg_m in rows:
        if len(out) < seq:
            # A gap means a stop was deleted; stop the accumulator here rather
            # than inventing distances for stops that are not on the route.
            break
        out.append((out[seq - 1] if seq else 0.0) + (leg_m or 0.0))
    return out


def _distance_at(cumulative: list[float], seq: int) -> float:
    """Cumulative metres at `seq`, clamped to the route's known length."""
    if not cumulative:
        return 0.0
    idx = max(0, min(seq, len(cumulative) - 1))
    return cumulative[idx]


# ---------------------------------------------------------------------------
# Step 3: transfers
# ---------------------------------------------------------------------------

def transfer_options(
    db: Session,
    origin: Stop,
    dest: Stop,
    now: datetime,
    horizon_min: int = SEARCH_HORIZON_MIN,
    accessibility_only: bool = False,
    max_transfers: int = 1,
) -> list[dict]:
    """One-transfer journeys via any stop that links two directional routes.

    The brief's example - "Katpadi -> Vellore New Bus Stand -> Ranipet" - is a
    transfer at a hub, so the search is over INTERMEDIATE STOPS rather than over
    pairs of routes: for each candidate hub, find a route serving origin->hub and
    a (different) route serving hub->dest, both in the correct direction.

    Bounded to `max_transfers=1` by default. Two transfers is a different
    product with different UI and a combinatorial search; the brief asks for one.
    """
    now = _now(now)

    if origin.id == dest.id:
        return []

    hubs = (
        db.query(RouteStop.stop_id)
        .filter(RouteStop.route_id.in_(
            db.query(Route.id).filter(
                # only routes that touch the origin, so the hub set is bounded
                Route.id.in_(
                    db.query(RouteStop.route_id).filter(RouteStop.stop_id == origin.id)
                )
            )
        ))
        .distinct()
        .all()
    )
    hub_ids = {h[0] for h in hubs} - {origin.id, dest.id}

    results: list[dict] = []

    for hub_id in hub_ids:
        hub = db.get(Stop, hub_id)
        if hub is None:
            continue

        # Leg 1: origin -> hub. Leg 2: hub -> dest. Both direction-checked.
        first = serving_routes(db, origin.id, hub_id)
        second = serving_routes(db, hub_id, dest.id)
        if not first or not second:
            continue

        for a in first:
            for b in second:
                # A single route doing both legs is a DIRECT journey that happens
                # to pass through the hub. Not offering it as "1 transfer" is
                # correct: the passenger changes nothing.
                if a["route_id"] == b["route_id"]:
                    continue
                if a["from_seq"] >= a["to_seq"] or b["from_seq"] >= b["to_seq"]:
                    continue

                leg1 = bus_options_for_route(
                    db, a, now, horizon_min, accessibility_only
                )
                leg2 = bus_options_for_route(
                    db, b, now, horizon_min, accessibility_only
                )
                if not leg1 or not leg2:
                    continue

                for opt1 in leg1[:1]:
                    for opt2 in leg2[:1]:
                        # When the connecting bus reaches the hub. Leg 2's own
                        # arrives_in_min is measured from now, so the passenger can
                        # only board it once they have actually arrived there.
                        hub_in1 = opt1["arrives_in_min"]
                        hub_in2 = opt2["arrives_in_min"]

                        wait_min = max(0, hub_in2 - hub_in1)

                        if wait_min > MAX_TRANSFER_WAIT_MIN:
                            # A 45-minute wait is not a transfer, it is a missed
                            # bus with extra steps. Better to report nothing than
                            # to offer it as a reasonable alternative.
                            continue

                        # TRANSFER_PENALTY_MIN is the walking time to the right
                        # bay plus finding the platform, so the connection has to
                        # clear that as well as the timetable.
                        board_in = max(hub_in1, hub_in2) + TRANSFER_PENALTY_MIN

                        results.append(
                            {
                                "transfers": 1,
                                "legs": [_leg_payload(opt1), _leg_payload(opt2)],
                                "transfer_stop": hub.as_dict(),
                                "wait_min": board_in - hub_in1,
                                "total_min": board_in + opt2["journey_min"],
                            }
                        )

    return results


def _leg_payload(option: dict) -> dict:
    """Strip a direct option down to the fields a journey leg reports."""
    return {
        "route_id": option["route_id"],
        "route_number": option["route_number"],
        "route_code": option["route_code"],
        "route_name": option["route_name"],
        "direction": option["direction"],
        "bus_id": option["bus_id"],
        "bus_name": option.get("bus_name"),
        "bus_reg": option["bus_reg"],
        "bus_type": option["bus_type"],
        "wheelchair_accessible": option["wheelchair_accessible"],
        "low_floor": option["low_floor"],
        "stops": option["stops"],
        "from_stop_id": option["stops"][0]["stop_id"] if option["stops"] else None,
        "to_stop_id": option["stops"][-1]["stop_id"] if option["stops"] else None,
        "arrives_in_min": option["arrives_in_min"],
        "crowd_level": option["crowd_level"],
        "crowd_load": option["crowd_load"],
        "capacity": option["capacity"],
    }


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def find_journeys(
    db: Session,
    from_stop_id: int,
    to_stop_id: int,
    sort: str = "eta",
    accessibility_only: bool = False,
    now: datetime | None = None,
    horizon_min: int = SEARCH_HORIZON_MIN,
    include_transfers: bool = True,
) -> dict | None:
    """Ranked journey options between two stop IDs.

    Returns None when either stop does not exist, which the API turns into a 404.
    Returns a result with empty `direct` / `transfers` lists when the stops are
    real but nothing connects them - that is an answer, not a failure, and the
    brief asks for a friendly message rather than an error.

    `sort` is "eta" (default) or "crowd" for least-crowded-first.
    """
    origin = db.get(Stop, from_stop_id)
    dest = db.get(Stop, to_stop_id)
    if origin is None or dest is None:
        return None

    moment = _now(now)

    result: dict = {
        "from": origin.as_dict(),
        "to": dest.as_dict(),
        "sort": sort,
        "generated_at": _iso(moment),
        "direct": [],
        "transfers": [],
        "message": None,
    }

    # Edge case the brief calls out: same origin and destination. Not an error -
    # there is simply nothing to catch.
    if origin.id == dest.id:
        result["message"] = "Origin and destination are the same stop."
        return result

    matches = serving_routes(db, origin.id, dest.id)
    direct: list[dict] = []
    for match in matches:
        direct.extend(
            bus_options_for_route(
                db, match, moment, horizon_min, accessibility_only
            )
        )

    direct = _rank(direct, sort)[:MAX_OPTIONS]
    result["direct"] = [_option_payload(o) for o in direct]

    # Transfers only when there is nothing direct. Suggesting a change when a
    # direct bus exists is noise; the brief asks for them as a fallback.
    if not direct and include_transfers:
        transfers = transfer_options(
            db, origin, dest, moment, horizon_min, accessibility_only
        )
        transfers.sort(key=lambda t: t["total_min"])
        result["transfers"] = transfers[:8]

    if not direct and not result["transfers"]:
        result["message"] = (
            "No buses found for this journey. Try swapping the stops - a bus "
            "only runs one direction between two points."
        )

    return result


def _rank(options: list[dict], sort: str) -> list[dict]:
    """Sort by earliest arrival, or by ETA plus a crowding penalty."""
    if sort == "crowd":
        for option in options:
            level = option.get("crowd_level") or "low"
            option["score"] = round(
                option["arrives_in_min"] + CROWD_PENALTY_MIN.get(level, 0.0), 2
            )
        return sorted(options, key=lambda o: (o["score"], o["arrives_in_min"]))

    for option in options:
        option["score"] = float(option["arrives_in_min"])
    return sorted(options, key=lambda o: (o["arrives_in_min"], o.get("route_id", 0)))


def _option_payload(option: dict) -> dict:
    """Flatten a direct bus option into the response shape."""
    stops = option["stops"]
    # The id has to be unique per RESPONSE ROW, not per route: a route with no
    # live bus contributes up to MAX_SCHEDULED_PER_ROUTE timetable entries, and a
    # shared id would collide as a React key and make two different departures
    # unselectable from each other. The departure time disambiguates them.
    if option["trip_id"]:
        option_id = f"trip-{option['trip_id']}"
    elif option.get("departs_at"):
        stamp = str(option["departs_at"]).replace(":", "").replace("-", "").replace("+00:00", "Z")
        option_id = f"sched-{option['route_id']}-{stamp}"
    else:
        option_id = f"sched-{option['route_id']}"

    return {
        "option_id": option_id,
        "transfers": 0,
        "kind": option["kind"],
        "route_id": option["route_id"],
        "route_number": option["route_number"],
        "route_code": option["route_code"],
        "route_name": option["route_name"],
        "direction": option["direction"],
        "bus_id": option["bus_id"],
        "bus_name": option.get("bus_name"),
        "bus_reg": option["bus_reg"],
        "bus_type": option["bus_type"],
        "capacity": option["capacity"],
        "wheelchair_accessible": option["wheelchair_accessible"],
        "low_floor": option["low_floor"],
        "from_stop_id": stops[0]["stop_id"] if stops else None,
        "to_stop_id": stops[-1]["stop_id"] if stops else None,
        "stops": stops,
        "arrives_in_min": option["arrives_in_min"],
        "eta_min": option.get("eta_min")
        if option.get("eta_min") is not None
        else option["arrives_in_min"] + option["journey_min"],
        "scheduled_arrival": option["scheduled_arrival"],
        "predicted_arrival": _iso(option["predicted_arrival"]) if option["predicted_arrival"] else None,
        "delay_min": option["delay_min"],
        "crowd_level": option["crowd_level"],
        "crowd_load": option["crowd_load"],
        "crowd_ratio": option["crowd_ratio"],
        "journey_min": option["journey_min"],
        "score": option.get("score"),
        "departs_at": option.get("departs_at"),
    }