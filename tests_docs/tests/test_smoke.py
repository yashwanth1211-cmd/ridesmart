"""Smoke tests - the contract in tests_docs/api_contract.yaml, asserted.

OWNER: Member 5.

These are the tests that protect the demo. If the planner returns one option,
or drops the crowd fields, the demo is dead -- so that is exactly what we assert.

API tests skip automatically until Member 2's app exists. See conftest.py.

    cd tests_docs && pytest -v
"""

from __future__ import annotations

import pytest

from simulation_ml.db.models import Crowd, Route, Stop, Trip, crowd_level_for

CROWD_LEVELS = {"low", "med", "high"}


# ===========================================================================
# Data layer - these always run, no API required
# ===========================================================================

class TestSeedData:
    def test_seed_has_three_routes(self, session):
        assert session.query(Route).count() == 3

    def test_seed_has_twelve_stops(self, session):
        assert session.query(Stop).count() == 12

    def test_all_trips_are_active(self, session):
        assert session.query(Trip).filter_by(status="active").count() == 3

    def test_every_route_has_ordered_stops(self, session):
        for route in session.query(Route).all():
            seqs = [rs.seq for rs in route.ordered_stops()]
            assert seqs == sorted(seqs), f"{route.code} stop order is wrong"
            assert len(seqs) >= 2

    def test_college_and_railway_share_two_routes(self, session):
        """The demo depends on this: two options must exist for A -> D."""
        target = {"STOP_COLLEGE", "STOP_RAILWAY"}
        codes = session.query(Route.code).all()
        assert len(codes) >= 2
        shared = []
        for (code,) in codes:
            route = session.query(Route).filter_by(code=code).first()
            names = {rs.stop.code for rs in route.ordered_stops()}
            if target.issubset(names):
                shared.append(code)
        assert len(shared) >= 2, f"only {shared} connect College to Railway"


class TestCrowdBanding:
    @pytest.mark.parametrize(
        "load,capacity,expected",
        [
            (0, 50, "low"), (12, 50, "low"), (19, 50, "low"),
            (20, 50, "med"), (35, 50, "med"), (37, 50, "med"),
            (38, 50, "high"), (42, 50, "high"), (50, 50, "high"),
        ],
    )
    def test_thresholds_match_the_contract(self, load, capacity, expected):
        assert crowd_level_for(load, capacity) == expected

    def test_every_band_is_represented_in_seed(self, session):
        """low / med / high must all appear, or the UI legend looks broken."""
        levels = {c.level for c in session.query(Crowd).all()}
        assert levels == CROWD_LEVELS, f"seed only covers {levels}"

    def test_seed_rows_are_internally_consistent(self, session):
        for c in session.query(Crowd).all():
            assert c.level == crowd_level_for(c.load, c.capacity)
            assert 0 <= c.load <= c.capacity


class TestDemoContrast:
    """The whole product is "faster but packed vs slower but empty"."""

    def test_21a_is_faster_but_more_crowded_than_7b(self, session):
        def route_stats(code):
            route = session.query(Route).filter_by(code=code).first()
            duration = max(rs.scheduled_offset_sec for rs in route.ordered_stops())
            load = (
                session.query(Crowd)
                .join(Trip, Crowd.trip_id == Trip.id)
                .filter(Trip.route_id == route.id)
                .first()
                .load
            )
            return duration, load

        fast_dur, fast_load = route_stats("21A")
        slow_dur, slow_load = route_stats("7B")

        assert fast_dur < slow_dur, "21A must be the faster option"
        assert fast_load > slow_load, "21A must be the more crowded option"
        assert crowd_level_for(fast_load, 50) == "med"
        assert crowd_level_for(slow_load, 50) == "low"


# ===========================================================================
# API contract - skipped until Member 2's app exists
# ===========================================================================

class TestHealth:
    def test_health_ok(self, client):
        r = client.get("/api/health")
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "ok"


class TestRoutes:
    def test_routes_returns_seed_data(self, client):
        r = client.get("/api/routes")
        assert r.status_code == 200, r.text
        body = r.json()
        assert len(body) == 3
        for route in body:
            assert {"id", "code", "name"} <= route.keys()

    def test_route_stops_are_ordered(self, client):
        routes = client.get("/api/routes").json()
        r = client.get(f"/api/routes/{routes[0]['id']}/stops")
        assert r.status_code == 200, r.text
        body = r.json()
        assert len(body) >= 2
        assert [s["seq"] for s in body] == sorted(s["seq"] for s in body)


class TestTracking:
    def test_active_buses_have_positions(self, client):
        r = client.get("/api/buses/active")
        assert r.status_code == 200, r.text
        body = r.json()
        assert len(body) >= 1, "seed should leave at least one bus on the map"
        for bus in body:
            assert {"bus_id", "lat", "lon", "ts"} <= bus.keys()
            assert -90 <= bus["lat"] <= 90
            assert -180 <= bus["lon"] <= 180

    def test_websocket_stream_uses_the_contract_path(self, client):
        """The WS must live at /api/ws/buses, not a bare /ws/buses.

        Member 3 hardcodes this URL, so a silent prefix drift here would leave
        the live map empty in the demo with no test complaining.
        """
        with client.websocket_connect("/api/ws/buses") as ws:
            payload = ws.receive_json()

        assert isinstance(payload, list), "contract says it mirrors BusPosition[]"
        assert len(payload) >= 1
        assert {"bus_id", "lat", "lon", "ts"} <= payload[0].keys()


class TestErrorShape:
    """conventions.error_shape: { "detail": ..., "code": ... }.

    The backend originally returned only `detail` and smuggled the code through
    an X-Code header, so the frontend's adapter had to cope with a body that
    violated the contract. Every error path is checked here so that cannot come
    back.
    """

    def _assert_shape(self, r):
        assert r.status_code >= 400, f"expected an error, got {r.status_code}"
        body = r.json()
        assert "detail" in body, f"missing 'detail': {body}"
        assert "code" in body, f"missing 'code': {body}"
        assert isinstance(body["code"], str) and body["code"]
        assert isinstance(body["detail"], str) and body["detail"]

    def test_unknown_stop(self, client):
        r = client.post(
            "/api/routes/plan",
            json={"from": "STOP_MARS", "to": "STOP_RAILWAY"},
        )
        self._assert_shape(r)
        assert r.json()["code"] == "unknown_stop"

    def test_blank_stops(self, client):
        r = client.post("/api/routes/plan", json={"from": "  ", "to": ""})
        self._assert_shape(r)
        assert r.json()["code"] == "missing_stops"

    def test_unknown_route(self, client):
        self._assert_shape(client.get("/api/routes/99999"))
        self._assert_shape(client.get("/api/routes/99999/stops"))

    def test_unknown_trip(self, client):
        self._assert_shape(client.get("/api/trips/99999/eta"))
        self._assert_shape(client.put("/api/trips/99999/crowd", json={"level": "low"}))

    def test_unknown_bus(self, client):
        self._assert_shape(client.get("/api/buses/99999/location"))

    def test_unmatched_path(self, client):
        """A 404 from routing itself must still carry a code."""
        self._assert_shape(client.get("/api/definitely-not-a-route"))

    def test_validation_error(self, client):
        """A malformed body becomes 422 with the contract shape, not FastAPI's
        default bare {"detail": [...]} list."""
        r = client.post("/api/routes/plan", json={"nonsense": True})
        self._assert_shape(r)
        assert r.status_code == 422


class TestPlanner:
    """THE demo-critical tests."""

    def test_plan_returns_at_least_two_options(self, client):
        r = client.post(
            "/api/routes/plan",
            json={"from": "STOP_COLLEGE", "to": "STOP_RAILWAY"},
        )
        assert r.status_code == 200, r.text
        options = r.json()["options"]
        assert len(options) >= 2, (
            "crowd-aware planning is the whole point - one option is a failure"
        )

    def test_plan_options_match_the_contract(self, client):
        r = client.post(
            "/api/routes/plan",
            json={"from": "STOP_COLLEGE", "to": "STOP_RAILWAY"},
        )
        body = r.json()
        required = {
            "route_id", "code", "eta_min", "eta_predicted_min", "delay_min",
            "crowd_level", "crowd_load", "capacity", "stops",
        }
        for opt in body["options"]:
            missing = required - opt.keys()
            assert not missing, f"option missing {missing}"
            assert opt["crowd_level"] in CROWD_LEVELS
            assert opt["eta_min"] >= 0
            assert len(opt["stops"]) >= 2

    def test_plan_options_are_sorted_by_eta(self, client):
        r = client.post(
            "/api/routes/plan",
            json={"from": "STOP_COLLEGE", "to": "STOP_RAILWAY"},
        )
        etas = [o["eta_min"] for o in r.json()["options"]]
        assert etas == sorted(etas)

    def test_plan_preserves_the_contrast(self, client):
        """21A should beat 7B on ETA while being worse on crowding."""
        r = client.post(
            "/api/routes/plan",
            json={"from": "STOP_COLLEGE", "to": "STOP_RAILWAY"},
        )
        options = r.json()["options"]
        fast = min(options, key=lambda o: o["eta_min"])
        ratio = fast["crowd_load"] / fast["capacity"]
        assert ratio >= 0.4, "the fastest option should NOT also be the empty one"

    def test_unknown_stop_is_a_clean_400(self, client):
        r = client.post(
            "/api/routes/plan",
            json={"from": "STOP_MARS", "to": "STOP_RAILWAY"},
        )
        assert r.status_code == 400, r.text
        body = r.json()
        assert "detail" in body
        # contract: error_shape is {detail, code}
        assert body["code"] == "unknown_stop"

    def test_accessibility_filter_drops_inaccessible_options(self, client):
        r = client.post(
            "/api/routes/plan",
            json={
                "from": "STOP_COLLEGE",
                "to": "STOP_RAILWAY",
                "accessibility_only": True,
            },
        )
        assert r.status_code == 200, r.text
        for opt in r.json()["options"]:
            assert opt["wheelchair_accessible"] is True


class TestCrowdOverride:
    def test_crowd_update_changes_planner_output(self, client):
        """The interactive demo step: flip a bus to empty, ranking must shift."""
        trips = client.get("/api/buses/active").json()
        trip_id = trips[0]["trip_id"]

        before = client.post(
            "/api/routes/plan",
            json={"from": "STOP_COLLEGE", "to": "STOP_RAILWAY"},
        ).json()

        r = client.put(f"/api/trips/{trip_id}/crowd", json={"load": 2, "capacity": 50})
        assert r.status_code == 200, r.text
        assert r.json()["level"] == "low"

        after = client.post(
            "/api/routes/plan",
            json={"from": "STOP_COLLEGE", "to": "STOP_RAILWAY"},
        ).json()

        assert before != after, "changing crowd should change the recommendations"


class TestDashboard:
    def test_dashboard_kpis_present(self, client):
        r = client.get("/api/authority/dashboard")
        assert r.status_code == 200, r.text
        body = r.json()
        assert {"total_buses", "active_buses", "delayed_buses"} <= body.keys()
        assert body["total_buses"] >= 4
        assert body["active_buses"] >= 1