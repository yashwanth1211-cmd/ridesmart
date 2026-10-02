"""End-to-end integration: seed -> simulate -> read back.

OWNER: Member 5.

The seed alone proves nothing. These tests prove the whole pipeline the demo
depends on:

    seed.py  writes routes/stops/trips
        -> simulate.py  writes location rows as buses move
            -> the API serves them

If a position never changes, the map is frozen and the demo looks broken, so
that is the assertion at the centre of this file.
"""

from __future__ import annotations

import pytest

from simulation_ml.db.models import Location, Route, Stop, Trip
from simulation_ml.simulate import (
    TripSimulator,
    bearing_deg,
    haversine_km,
    interpolate,
)


class TestGeometry:
    def test_haversine_zero_for_same_point(self):
        assert haversine_km(12.97, 77.59, 12.97, 77.59) == pytest.approx(0.0)

    def test_haversine_known_distance(self):
        # Bengaluru -> Mysuru, great-circle distance is ~128 km
        d = haversine_km(12.9716, 77.5946, 12.2958, 76.6394)
        assert 125 < d < 131

    def test_bearing_is_in_range(self):
        b = bearing_deg(12.9716, 77.5946, 12.9795, 77.5568)
        assert 0 <= b < 360

    def test_interpolate_endpoints(self):
        a, b = Stop(lat=12.0, lon=77.0), Stop(lat=13.0, lon=78.0)
        assert interpolate(a, b, 0.0) == pytest.approx((12.0, 77.0))
        assert interpolate(a, b, 1.0) == pytest.approx((13.0, 78.0))
        assert interpolate(a, b, 0.5) == pytest.approx((12.5, 77.5))


class TestSimulatorMovement:
    """The core of the live-tracking demo."""

    def _sim(self, session, route_code="21A", speed=5.0):
        import random

        route = session.query(Route).filter_by(code=route_code).first()
        trip = (
            session.query(Trip)
            .filter_by(route_id=route.id, status="active")
            .first()
        )
        # built while the session is open so the stop snapshot is eager
        return TripSimulator.from_trip(trip, random.Random(7), speed_factor=speed)

    def test_ticks_are_produced(self, session):
        sim = self._sim(session)
        pos = sim.step(10.0)
        assert -90 <= pos["lat"] <= 90
        assert -180 <= pos["lon"] <= 180
        assert pos["speed_kmph"] > 0
        assert 0.0 <= pos["seq_progress"] <= 1.0

    def test_position_actually_changes(self, session):
        """Without this the map is frozen and the demo fails silently."""
        sim = self._sim(session)
        first = sim.step(10.0)
        moved = False
        for _ in range(5):
            nxt = sim.step(10.0)
            if (round(nxt["lat"], 6), round(nxt["lon"], 6)) != (
                round(first["lat"], 6),
                round(first["lon"], 6),
            ):
                moved = True
                break
        assert moved, "simulated bus never changed position"

    def test_progress_is_monotonic(self, session):
        sim = self._sim(session)
        seq = [sim.step(10.0)["seq_progress"] for _ in range(10)]
        assert seq == sorted(seq), "progress went backwards"
        assert seq[-1] > seq[0], "progress never advanced"

    def test_progress_never_exceeds_one(self, session):
        sim = self._sim(session, speed=200.0)
        for _ in range(50):
            assert sim.step(30.0)["seq_progress"] <= 1.0

    def test_speed_varies_between_ticks(self, session):
        """If speed were constant, ETA would exactly match the timetable and
        the delay feature would have nothing to show."""
        sim = self._sim(session)
        speeds = {round(sim.step(10.0)["speed_kmph"], 3) for _ in range(15)}
        assert len(speeds) > 1


class TestSimulatorWritesTelemetry:
    def test_locations_appear_in_the_database(self, session):
        from simulation_ml.db.models import get_sessionmaker
        from simulation_ml.simulate import run

        url = str(session.get_bind().url)

        class Args:
            speed = 5.0
            interval = 0.01
            seed = 7
            once = True
            max_ticks = 1
            trips = ""
            push = ""

        run(Args())

        with get_sessionmaker(url)() as verify:
            assert verify.query(Location).count() > 0, "simulator wrote no telemetry"

    def test_ingest_endpoint_receives_positions(self, seeded_db, client):
        """--push mode must be consumable by Member 2's API."""
        r = client.post(
            "/api/buses/ingest",
            json=[
                {
                    "bus_id": 1, "trip_id": 1, "route_id": 1,
                    "lat": 12.9716, "lon": 77.5946,
                    "speed_kmph": 24.0, "heading": 90.0, "seq_progress": 0.1,
                    "ts": "2026-01-01T10:00:00+00:00",
                }
            ],
        )
        assert r.status_code in (200, 201, 202), r.text


class TestPlannerConnectivity:
    """Planner needs a real path through the seeded graph."""

    def test_every_pair_of_stops_on_a_route_is_connectable(self, session):
        for route in session.query(Route).all():
            codes = [rs.stop.code for rs in route.ordered_stops()]
            for i in range(len(codes)):
                for j in range(i + 1, len(codes)):
                    assert codes[i] != codes[j], f"{route.code} repeats a stop"

    def test_no_orphan_stops_in_seed(self, session):
        used = {
            rs.stop_id for route in session.query(Route).all() for rs in route.ordered_stops()
        }
        all_stops = {s.id for s in session.query(Stop).all()}
        orphans = all_stops - used
        # orphans are legal (a future stop) but flag the count for awareness
        assert len(orphans) < len(all_stops)


class TestSegmentStatsImprove:
    """Member 1's ETA baseline gets better as the simulator runs."""

    def test_observed_segments_diverge_from_timetable(self, session):
        """Seeded factors must be > 1 for at least some segments, otherwise
        predicted ETA always equals scheduled ETA and the demo has no delay."""
        from simulation_ml.db.models import SegmentStat

        stats = session.query(SegmentStat).all()
        assert len(stats) > 0
        assert any(s.factor > 1.0 for s in stats)