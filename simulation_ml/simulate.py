"""Bus movement simulator.

OWNER: Member 5 (temporarily, while Member 4 is unavailable).

    python -m simulation_ml.simulate                      # speed 5x, tick 2s
    python -m simulation_ml.simulate --speed 20 --interval 1
    python -m simulation_ml.simulate --push                # POST to the API instead of the DB
    python -m simulation_ml.simulate --once                # single tick, for tests
    python -m simulation_ml.simulate --trips 1,2           # only these trip ids

WHAT IT DOES, EVERY TICK
------------------------
1. Advances every active trip along its route_stop sequence.
2. Writes a `location` row: lat, lon, speed, heading, seq_progress, plus the
   current stop, the next stop and how many seconds behind the timetable the
   bus is running.
3. Randomises speed per trip so predicted ETA diverges from the timetable.
4. Occasionally emits a `crowd` row, with occupancy scaled up during the
   08:00-10:00 and 17:00-19:00 peaks (IST) and down off-peak.
5. Refreshes `segment_stat` from observed travel times, so Member 1's ETA
   baseline visibly improves while the demo runs.

There is no real GPS feed, so this is the entire "live tracking" data source
for the demo. Member 1's ETA model trains on the `location` rows it writes.
"""

from __future__ import annotations

import argparse
import bisect
import json
import math
import random
import sys
import time
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from simulation_ml.db.models import (  # noqa: E402
    Crowd,
    Location,
    Route,
    SegmentStat,
    Trip,
    as_utc,
    crowd_level_for,
    get_sessionmaker,
    peak_load_for,
    utcnow,
)

EARTH_RADIUS_KM = 6371.0


@dataclass(frozen=True)
class StopPoint:
    """Plain snapshot of a stop.

    The simulator builds these while the session is still open. Holding ORM
    instances instead would raise DetachedInstanceError on the first tick,
    because the session is closed before the loop starts.
    """

    id: int
    code: str
    name: str
    lat: float
    lon: float
    accessible: bool


# How far a segment's observed time may stray from its timetable before the
# reading is treated as an artefact rather than real traffic. Guards the rolling
# average against a suspended process, a debugger pause or a clock jump.
MAX_SEGMENT_SLOWDOWN = 3.0
MAX_SEGMENT_SPEEDUP = 3.0


# ---------------------------------------------------------------------------
# geometry
# ---------------------------------------------------------------------------

def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Initial bearing from point 1 to point 2, degrees from north."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def interpolate(a, b, t: float):
    """Linear interpolation between two stops.

    Only used as a fallback for routes that have no real road geometry. When a
    route_shape_point polyline exists, RoutePath.point_at_distance() is used
    instead and the bus travels along actual roads.
    """
    return a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t


class RoutePath:
    """A route's real road polyline, walked by distance rather than by stop index.

    The seed stores OSM/OSRM geometry in `route_shape_point` with `cum_m`: the
    running distance from the first vertex of the whole route. That makes the
    lookup a binary search on a precomputed list, so a tick costs O(log n)
    regardless of how detailed the road geometry is.

    Why distance and not stop index: the old code treated progress as a fraction
    of the stop list and interpolated straight between consecutive stops, so a
    bus covered the same ground in the same time regardless of actual road
    length and cut straight through buildings. Real geometry has legs of 2 km
    and 19 km between adjacent stops, so position has to be resolved by
    distance travelled along the shape.
    """

    __slots__ = ("points", "cum_m", "total_m", "leg_of", "stop_cum_m")

    def __init__(self, points: list[tuple[float, float, float, int]]):
        """points: (lat, lon, cum_m, leg) tuples in travel order."""
        self.points = points
        self.cum_m = [p[2] for p in points]
        self.total_m = self.cum_m[-1] if self.cum_m else 0.0
        self.leg_of = [p[3] for p in points]

        # cum_m where each leg ENDS, i.e. where that stop is physically reached.
        # Derived from the leg index rather than stored separately.
        self.stop_cum_m: list[float] = []
        last_leg = self.leg_of[0] if self.leg_of else -1
        for i, p in enumerate(points):
            if p[3] != last_leg:
                # the first vertex of a new leg is the previous stop
                self.stop_cum_m.append(self.cum_m[i])
                last_leg = p[3]
        if points:
            self.stop_cum_m.append(self.cum_m[-1])

    def stop_index_at(self, distance_m: float) -> int:
        """How many stops have been passed by this distance."""
        passed = 0
        for stop_m in self.stop_cum_m:
            if distance_m >= stop_m:
                passed += 1
            else:
                break
        return min(passed, len(self.stop_cum_m) - 1)

    def point_at_distance(self, distance_m: float):
        """(lat, lon, heading_deg) at this distance along the shape."""
        d = max(0.0, min(distance_m, self.total_m))
        pts = self.points
        if len(pts) == 1:
            return pts[0][0], pts[0][1], 0.0

        # bisect_right - 1 gives the segment [i, i+1] containing d
        i = bisect.bisect_right(self.cum_m, d) - 1
        i = max(0, min(i, len(pts) - 2))

        lat1, lon1 = pts[i][0], pts[i][1]
        lat2, lon2 = pts[i + 1][0], pts[i + 1][1]
        span = pts[i + 1][2] - pts[i][2]
        t = 0.0 if span <= 0 else (d - pts[i][2]) / span

        lat = lat1 + (lat2 - lat1) * t
        lon = lon1 + (lon2 - lon1) * t
        return lat, lon, bearing_deg(lat1, lon1, lat2, lon2)


# ---------------------------------------------------------------------------
# simulation core
# ---------------------------------------------------------------------------

class TripSimulator:
    """Holds the mutable state of one in-progress trip.

    Constructed from ORM objects inside an open session, then fully detached:
    after __init__ it touches no lazy-loaded relationship. That lets the tick
    loop open a fresh session per tick without exploding.
    """

    def __init__(self, trip_id: int, route_id: int, route_code: str,
                 bus_id: int, capacity: int,
                 stops: list[StopPoint], rng: random.Random,
                 speed_factor: float, path: RoutePath | None = None,
                 sched_offsets: list[int] | None = None):
        if len(stops) < 2:
            raise ValueError(f"route {route_code} needs at least 2 stops")

        self.trip_id = trip_id
        self.route_id = route_id
        self.route_code = route_code
        self.bus_id = bus_id
        self.capacity = capacity
        self.stops = stops
        self.rng = rng
        self.speed_factor = speed_factor
        self.path = path

        # Timetable offset per stop, in the same order as self.stops. Used to
        # work out how far behind schedule this bus is, which nothing in the
        # telemetry said before: seq_progress says how FAR along the route the
        # bus is, and these offsets say how long that should have taken.
        self.sched_offsets = list(sched_offsets or [])

        self.progress = 0.0
        self.last_stop_seq = 0
        self.last_tick_ts = utcnow()
        self.elapsed_sec = 0.0
        self.boarded = rng.randint(4, 14)

        # Segment timing state. segment_key is the stop pair currently being
        # driven; finished_segment carries a completed run to the main loop.
        self.segment_key: tuple[int, int] | None = None
        self.segment_elapsed = 0.0
        self.finished_segment: tuple[int, int, float] | None = None

        # per-stop crowd profile, clamped so no stop exceeds capacity.
        self.crowd_profile = self._new_crowd_profile()

    def _new_crowd_profile(self) -> list[int]:
        """Off-peak occupancy per stop, as an absolute passenger count.

        Stored OFF-PEAK and scaled to the hour of day at emit time, so the same
        bus is empty at 15:00 and packed at 09:00 instead of being permanently
        whatever it happened to be when the process started.
        """
        # 20-65% of capacity off-peak. The wide end is a bus that is busy most of
        # the day; the narrow end is an early-morning empty one.
        base = int(self.capacity * self.rng.uniform(0.20, 0.65))
        return [
            max(0, min(self.capacity, base + self.rng.randint(-6, 6)))
            for _ in self.stops
        ]

    @classmethod
    def from_trip(cls, trip, rng: random.Random, speed_factor: float) -> "TripSimulator":
        """Build from a live ORM Trip. Must be called with an open session."""
        route = trip.route
        bus = trip.bus
        ordered_rs = sorted(route.route_stops, key=lambda r: r.seq)
        stops = [
            StopPoint(
                id=rs.stop.id,
                code=rs.stop.code,
                name=rs.stop.name,
                lat=rs.stop.lat,
                lon=rs.stop.lon,
                accessible=bool(rs.stop.accessible),
            )
            for rs in ordered_rs
        ]

        # Real road geometry, when the seed provided it. Detached into plain
        # tuples for the same reason the stops are.
        path = None
        shape = sorted(route.shape_points, key=lambda p: (p.leg, p.seq))
        if len(shape) >= 2:
            path = RoutePath([(p.lat, p.lon, p.cum_m, p.leg) for p in shape])

        return cls(
            trip_id=trip.id,
            route_id=route.id,
            route_code=route.code,
            bus_id=bus.id,
            capacity=bus.capacity,
            stops=stops,
            rng=rng,
            speed_factor=speed_factor,
            path=path,
            sched_offsets=[rs.scheduled_offset_sec for rs in ordered_rs],
        )

    # -- helpers ----------------------------------------------------------
    def current_pair(self):
        """(from_stop, to_stop, fraction_between) for the current position."""
        span = len(self.stops) - 1
        frac = self.progress * span
        i = min(int(frac), span - 1)
        return self.stops[i], self.stops[i + 1], frac - i
    def current_speed(self) -> float:
        """Jittered speed so ETA never matches the timetable exactly."""
        base = 26.0
        return max(4.0, base + self.rng.gauss(0, 6.0))

    def scheduled_elapsed_sec(self) -> float:
        """Timetable seconds for the distance covered so far.

        progress is a fraction of DISTANCE, not of the stop list, so the
        timetable has to be read at the same scale. With real geometry that is
        the shape's stop_cum_m; without it, evenly spaced stop indices are the
        best available approximation and are labelled as such.
        """
        offsets = self.sched_offsets
        if len(offsets) < 2:
            return 0.0

        if self.path is not None and self.path.stop_cum_m:
            targets = self.path.stop_cum_m
            point = self.progress * self.path.total_m
        else:
            span = len(self.stops) - 1
            targets = [float(i) for i in range(len(self.stops))]
            point = self.progress * span

        if len(targets) != len(offsets):
            return 0.0

        for i in range(len(targets) - 1):
            if point <= targets[i + 1] or i == len(targets) - 2:
                span = targets[i + 1] - targets[i]
                t = 0.0 if span <= 0 else (point - targets[i]) / span
                return offsets[i] + (offsets[i + 1] - offsets[i]) * t

        return float(offsets[-1])

    def delay_sec(self) -> float:
        """Seconds behind the timetable. Negative means running early.

        elapsed_sec is SIMULATED time, so this is a delay on the simulated
        clock. That is the clock the whole demo runs on: the ETAs the planner
        shows are computed from the same accumulated timings, so a bus that
        drifts here drifts there too.
        """
        return self.elapsed_sec - self.scheduled_elapsed_sec()

    # -- main step --------------------------------------------------------
    def step(self, dt_sec: float) -> dict:
        """Advance the trip by dt_sec of SIMULATED time, return a telemetry dict.

        With real road geometry the bus advances by DISTANCE along the shape, so
        a 19 km leg correctly takes far longer than a 2 km one. Without a path
        it falls back to the old per-stop interpolation.

        A bus that reaches the terminus wraps back to the first stop instead of
        freezing at 100%. Without this the map goes static a few minutes into
        the demo, which is exactly when someone is watching.
        """
        self.elapsed_sec += dt_sec
        speed = self.current_speed()

        if self.path is not None:
            lat, lon, heading, from_stop, to_stop, self.progress = self._step_along_path(
                dt_sec, speed
            )
        else:
            from_stop, to_stop, t = self.current_pair()
            seg_km = max(
                haversine_km(from_stop.lat, from_stop.lon, to_stop.lat, to_stop.lon),
                0.05,
            )
            seg_sec = (seg_km / max(speed, 1.0)) * 3600.0
            if seg_sec > 0:
                self.progress += (dt_sec / seg_sec) / (len(self.stops) - 1)

            if self.progress >= 1.0:
                self._wrap()
                from_stop, to_stop, t = self.current_pair()

            lat, lon = interpolate(from_stop, to_stop, t)
            heading = bearing_deg(from_stop.lat, from_stop.lon, to_stop.lat, to_stop.lon)

        self.track_segment(from_stop.id, to_stop.id, dt_sec)

        return {
            "bus_id": self.bus_id,
            "trip_id": self.trip_id,
            "route_id": self.route_id,
            "route_code": self.route_code,
            "lat": lat,
            "lon": lon,
            "speed_kmph": speed,
            "heading": heading,
            "seq_progress": round(self.progress, 4),
            # Written straight into the location row. The journey planner needs
            # "is the origin still ahead of this bus" to be answerable without
            # re-walking the shape on every request, and a reader that has to
            # recompute it from seq_progress and a stop list can disagree with
            # the simulator the moment either side rounds differently.
            "current_stop_id": from_stop.id,
            "next_stop_id": to_stop.id,
            "current_stop_name": from_stop.name,
            "next_stop_name": to_stop.name,
            "delay_sec": round(self.delay_sec(), 1),
            "ts": utcnow(),
            "_from_stop_id": from_stop.id,
            "_next_stop_id": to_stop.id,
            "_next_stop_name": to_stop.name,
        }

    def _wrap(self) -> None:
        """Turn the bus around at the terminus instead of freezing at 100%."""
        # The leg being driven is over, so bank its timing before resetting.
        self._finish_segment()
        self.progress = 0.0
        self.last_stop_seq = 0
        self.boarded = self.rng.randint(4, max(4, int(self.capacity * 0.4)))
        self.crowd_profile = self._new_crowd_profile()

    def _step_along_path(self, dt_sec: float, speed: float):
        """Advance along the real polyline. Returns position + adjacent stops."""
        total = self.path.total_m
        travelled = self.progress * total
        travelled += (speed * 1000.0 / 3600.0) * dt_sec

        if travelled >= total:
            travelled -= total
            self._wrap()
            travelled = 0.0

        self.progress = travelled / total if total else 0.0

        lat, lon, heading = self.path.point_at_distance(travelled)

        # Which stops is the bus between? stop_index_at gives the number of
        # stops already passed, so the next one is that index.
        idx = self.path.stop_index_at(travelled)
        last = len(self.stops) - 1
        from_stop = self.stops[min(idx, last)]
        to_stop = self.stops[min(idx + 1, last)]
        if from_stop is to_stop:
            to_stop = self.stops[max(0, last)] if idx >= last else self.stops[idx + 1]
        return lat, lon, heading, from_stop, to_stop, self.progress

    def maybe_emit_crowd(self, tick_pos: dict) -> dict | None:
        """Build a crowd reading whenever the bus passes a new stop.

        Returns a plain dict rather than an ORM object so it can be written in
        the same session that is already open for this tick.

        Which stop has been reached comes from the real geometry when present.
        Mapping progress onto stops by even fraction is wrong for real routes:
        on V2 the fifth stop sits 10.2 km along a 16.3 km route, so the bus is
        62% of the way there but only 5/9 of the way through the stop list.
        """
        if self.path is not None:
            reached_seq = self.path.stop_index_at(self.progress * self.path.total_m)
        else:
            reached_seq = int(tick_pos["seq_progress"] * (len(self.stops) - 1))
        if reached_seq <= self.last_stop_seq:
            return None
        self.last_stop_seq = reached_seq
        idx = min(reached_seq, len(self.stops) - 1)

        # passengers get off first, then new ones board
        alighting = min(self.boarded, self.rng.randint(2, 12))
        self.boarded = max(0, self.boarded - alighting)
        self.boarded = min(self.capacity, self.boarded + self.rng.randint(1, 9))

        # The stored profile is this bus's OFF-PEAK occupancy. Scaling it to the
        # current hour is what makes 08:00-10:00 and 17:00-19:00 visibly busier,
        # rather than the whole network sitting at one flat load all day.
        # peak_load_for clamps too, so a bus that was already near capacity stays
        # at capacity at peak instead of reporting 130% full.
        load = peak_load_for(self.crowd_profile[idx], self.capacity, tick_pos["ts"])
        load = max(0, min(self.capacity, load + self.rng.randint(-4, 4)))

        return {
            "trip_id": self.trip_id,
            "stop_id": self.stops[idx].id,
            "load": load,
            "capacity": self.capacity,
            "level": crowd_level_for(load, self.capacity),
            "ts": tick_pos["ts"],
        }

    def track_segment(self, from_stop_id: int, to_stop_id: int, dt_sec: float) -> None:
        """Accumulate simulated time onto the segment currently being driven.

        avg_travel_sec is supposed to mean "how long this stop pair takes", so
        it can only be measured once the bus has actually arrived at the far
        end. Time is banked here while the pair stays the same and handed over
        in finished_segment when the bus moves on.

        The previous implementation folded the time since the last tick into
        the average on every tick. That recorded a 10-second tick against a
        210-second segment, and on the first tick after a restart last_tick_ts
        came from the database, so however long the simulator had been stopped
        was averaged in as a single impossible run. One restart was enough to
        push a segment to 3445s and inflate every ETA built on it.
        """
        key = (from_stop_id, to_stop_id)
        if self.segment_key is None:
            self.segment_key = key
            self.segment_elapsed = dt_sec
        elif key == self.segment_key:
            self.segment_elapsed += dt_sec
        else:
            self._finish_segment()
            self.segment_key = key
            self.segment_elapsed = dt_sec

    def _finish_segment(self) -> None:
        """Hand the completed segment's timing to the main loop for writing."""
        if self.segment_key is not None and self.segment_elapsed > 0:
            self.finished_segment = (
                self.segment_key[0],
                self.segment_key[1],
                self.segment_elapsed,
            )
        self.segment_key = None
        self.segment_elapsed = 0.0

    def refresh_segment_stat(self, session, from_stop_id: int, to_stop_id: int,
                             observed_sec: float) -> None:
        """Fold the latest observed segment time into the rolling average.

        This is what lets Member 1's ETA predictions get better over the demo
        without anyone retraining a model by hand.

        Implausible samples are dropped rather than averaged in. The average is
        permanent once written, so one bad reading - a suspended laptop, a
        debugger pause, a clock jump - would otherwise bend ETAs for the rest
        of the demo.
        """
        if observed_sec <= 0:
            return
        stat = (
            session.query(SegmentStat)
            .filter_by(route_id=self.route_id, from_stop_id=from_stop_id,
                       to_stop_id=to_stop_id)
            .first()
        )
        if stat is None:
            return

        # The seeded average is the timetable time, which gives a sane band to
        # judge an observation against. Reject anything wildly off it.
        scheduled = stat.avg_travel_sec if stat.samples > 0 else None
        if scheduled and scheduled > 0:
            if observed_sec > scheduled * MAX_SEGMENT_SLOWDOWN:
                return
            if observed_sec < scheduled / MAX_SEGMENT_SPEEDUP:
                return

        n = max(stat.samples, 1)
        stat.avg_travel_sec = (stat.avg_travel_sec * n + observed_sec) / (n + 1)
        stat.samples = n + 1
        stat.observed_at = utcnow()


# ---------------------------------------------------------------------------
# push mode (no DB writes - hand positions to Member 2's API instead)
# ---------------------------------------------------------------------------

def push_positions(url: str, positions: list[dict]) -> bool:
    body = json.dumps(
        [
            {k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in p.items()
             if not k.startswith("_")}
            for p in positions
        ]
    ).encode()
    req = Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urlopen(req, timeout=3) as resp:
            return 200 <= resp.status < 300
    except (URLError, OSError) as exc:
        print(f"  [push] {url} failed: {exc}", file=sys.stderr)
        return False


# ---------------------------------------------------------------------------
# main loop
# ---------------------------------------------------------------------------

def run(args) -> None:
    rng = random.Random(args.seed)
    Session = get_sessionmaker()
    sims: dict[int, TripSimulator] = {}

    # Build the simulators while a session is open, then close it.
    with Session() as session:
        query = session.query(Trip).filter(Trip.status == "active")
        if args.trips:
            wanted = {int(x) for x in args.trips.split(",")}
            query = query.filter(Trip.id.in_(wanted))

        trips = query.all()
        if not trips:
            print(
                "No active trips. Run: python -m simulation_ml.seed.seed --reset",
                file=sys.stderr,
            )
            return

        for tr in trips:
            sim = TripSimulator.from_trip(tr, rng, speed_factor=args.speed)

            # Resume from wherever this trip already is, so restarting the
            # simulator continues the journey instead of snapping back to the
            # depot. Without this, buses never appear to move between runs.
            last = (
                session.query(Location)
                .filter_by(trip_id=tr.id)
                .order_by(Location.id.desc())
                .first()
            )
            if last is not None:
                sim.progress = float(last.seq_progress)
                # progress is a fraction of DISTANCE, so the stop it sits at
                # has to come from the geometry. Scaling it by the stop count
                # assumed evenly spaced stops, which real routes are not - on
                # V1 the legs run from 0.63 km to 3.30 km - and it left
                # last_stop_seq too high, so every remaining stop on that run
                # was silently skipped for crowd reporting.
                if sim.path is not None:
                    sim.last_stop_seq = sim.path.stop_index_at(
                        sim.progress * sim.path.total_m
                    )
                else:
                    sim.last_stop_seq = int(sim.progress * (len(sim.stops) - 1))
                sim.last_tick_ts = as_utc(last.ts)

            sims[tr.id] = sim

    print(f"Simulating {len(sims)} active trip(s)  speed=x{args.speed}  tick={args.interval}s")
    print("Press Ctrl+C to stop.\n")

    ticks = 0
    try:
        while True:
            # dt is real seconds since the last tick, scaled to simulated time
            dt = args.interval * args.speed
            positions = []

            with Session() as session:
                for sim in sims.values():
                    pos = sim.step(dt)

                    # A segment's timing is only meaningful once the bus has
                    # completed it, so write it when step() reports one rather
                    # than timing the gap between ticks.
                    if sim.finished_segment is not None:
                        f_id, t_id, secs = sim.finished_segment
                        sim.finished_segment = None
                        sim.refresh_segment_stat(session, f_id, t_id, secs)
                    sim.last_tick_ts = pos["ts"]

                    crowd = sim.maybe_emit_crowd(pos)
                    if crowd is not None:
                        session.add(Crowd(**crowd))

                    if not args.push:
                        session.add(
                            Location(
                                bus_id=pos["bus_id"],
                                trip_id=pos["trip_id"],
                                lat=pos["lat"],
                                lon=pos["lon"],
                                speed_kmph=pos["speed_kmph"],
                                heading=pos["heading"],
                                seq_progress=pos["seq_progress"],
                                current_stop_id=pos["current_stop_id"],
                                next_stop_id=pos["next_stop_id"],
                                delay_sec=pos["delay_sec"],
                                ts=pos["ts"],
                            )
                        )

                    positions.append(pos)

                session.commit()

            if args.push:
                push_positions(args.push, positions)

            for p in positions:
                print(
                    f"  bus {p['bus_id']} route {p['route_code']:>4} "
                    f"({p['lat']:.4f}, {p['lon']:.4f})  "
                    f"{p['speed_kmph']:>5.1f} km/h  "
                    f"{p['seq_progress'] * 100:>5.1f}% along"
                )

            ticks += 1
            if args.once or (args.max_ticks and ticks >= args.max_ticks):
                print(f"\nDone: {ticks} tick(s).")
                return
            time.sleep(args.interval)

    except KeyboardInterrupt:
        print(f"\nStopped after {ticks} tick(s).")


def main() -> None:
    ap = argparse.ArgumentParser(description="RideSmart bus movement simulator")
    ap.add_argument("--speed", type=float, default=5.0,
                    help="time multiplier, 1=real time, 20=20x faster (default 5)")
    ap.add_argument("--interval", type=float, default=2.0,
                    help="seconds between ticks (default 2)")
    ap.add_argument("--seed", type=int, default=7, help="RNG seed for reproducibility")
    ap.add_argument("--once", action="store_true", help="run a single tick and exit")
    ap.add_argument("--max-ticks", type=int, default=0, help="stop after N ticks (0=forever)")
    ap.add_argument("--trips", default="", help="comma-separated trip ids to simulate")
    ap.add_argument("--push", default="",
                    help="POST positions to this URL instead of writing to the DB, "
                         "e.g. http://localhost:8000/api/buses/ingest")
    run(ap.parse_args())


if __name__ == "__main__":
    main()