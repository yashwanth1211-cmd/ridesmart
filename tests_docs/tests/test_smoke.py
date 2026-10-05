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

    def test_seed_has_real_stops(self, session):
        # 23 real OSM stops, not the 12 hand-written placeholders.
        assert session.query(Stop).count() == 23

    def test_stops_have_real_coordinates(self, session):
        """Every stop must sit inside the Vellore-Katpadi bbox the data came from."""
        for stop in session.query(Stop).all():
            assert 12.87 <= stop.lat <= 13.02, f"{stop.code} latitude out of range"
            assert 79.12 <= stop.lon <= 79.16, f"{stop.code} longitude out of range"

    def test_kingston_is_labelled_as_a_campus_anchor(self, session):
        """Kingston has no OSM bus bay, so it must not claim to be a surveyed stop.

        OSM maps the college but no transit node: the nearest named bus stop is
        4.2 km away at Palloor. Presenting the campus pin as a mapped bus stop
        would be a claim the data cannot support, which is the exact failure
        mode the `kind` column exists to prevent.
        """
        kingston = session.query(Stop).filter_by(code="STOP_KINGSTON_COLLEGE").first()
        assert kingston is not None, "Kingston Engineering College is missing"
        assert kingston.kind == "campus"
        # Real OSM coordinates for the college on Chitoor main road.
        assert kingston.lat == pytest.approx(13.012, abs=0.01)
        assert kingston.lon == pytest.approx(79.134, abs=0.01)

        # Everything else really is a mapped transit node.
        for stop in session.query(Stop).filter(Stop.code != "STOP_KINGSTON_COLLEGE").all():
            assert stop.kind == "transit", f"{stop.code} should be transit"

    def test_principal_hubs_are_on_the_network(self, session):
        """The main interchange points have to be reachable, not just on the map."""
        codes = {s.code for s in session.query(Stop).all()}
        for required in (
            "STOP_VELLORE_OLD_BUS_STAND",
            "STOP_VELLORE_CANTONMENT",
            "STOP_VELLORE_TOWN",
            "STOP_KATPADI_JUNCTION",
            "STOP_TNEB",
        ):
            assert required in codes, f"{required} missing from the network"

    def test_every_route_has_real_road_geometry(self, session):
        """Routes must carry OSRM road geometry, and it must be non-degenerate.

        A route whose polyline is just its two endpoints would put buses back
        on straight lines through buildings, which is the bug this replaced.
        """
        for route in session.query(Route).all():
            pts = sorted(route.shape_points, key=lambda p: (p.leg, p.seq))
            assert len(pts) >= 10, f"{route.code} has only {len(pts)} shape points"
            assert pts[-1].cum_m > 1000, f"{route.code} shape is not >1 km"
            assert pts[0].cum_m == 0.0

    def test_all_trips_are_active(self, session):
        assert session.query(Trip).filter_by(status="active").count() == 3

    def test_every_route_has_ordered_stops(self, session):
        for route in session.query(Route).all():
            seqs = [rs.seq for rs in route.ordered_stops()]
            assert seqs == sorted(seqs), f"{route.code} stop order is wrong"
            assert len(seqs) >= 2

    def test_demo_journey_is_shared_by_two_routes(self, session):
        """The demo depends on this: two options must exist for the demo pair."""
        from simulation_ml.seed.seed import DEMO_JOURNEY

        target = set(DEMO_JOURNEY)
        codes = session.query(Route.code).all()
        assert len(codes) >= 2
        shared = []
        for (code,) in codes:
            route = session.query(Route).filter_by(code=code).first()
            names = {rs.stop.code for rs in route.ordered_stops()}
            if target.issubset(names):
                shared.append(code)
        assert len(shared) >= 2, f"only {shared} connect {sorted(target)}"


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

    def test_v1_is_faster_but_more_crowded_than_v2(self, session):
        """Compare the DEMO JOURNEY, not each route's full end-to-end run.

        With real geography V2 is the longer route overall (16.3 km vs
        V1's 15.2 km), so whole-route duration no longer expresses "fast vs
        slow". What the passenger actually sees is the ETA for their own trip,
        which is the comparison that has to hold.
        """
        from simulation_ml.seed.seed import DEMO_JOURNEY

        origin, destination = DEMO_JOURNEY

        def journey_stats(code):
            route = session.query(Route).filter_by(code=code).first()
            offsets = {rs.stop.code: rs.scheduled_offset_sec for rs in route.ordered_stops()}
            assert origin in offsets and destination in offsets, f"{code} lacks the demo pair"
            secs = offsets[destination] - offsets[origin]
            assert secs > 0, f"{code} does not run {origin} -> {destination} forwards"

            load = (
                session.query(Crowd)
                .join(Trip, Crowd.trip_id == Trip.id)
                .filter(Trip.route_id == route.id)
                .first()
                .load
            )
            return secs, load

        fast_secs, fast_load = journey_stats("V1")
        slow_secs, slow_load = journey_stats("V2")

        assert fast_secs < slow_secs, (
            f"V1 must be the faster option for the demo journey "
            f"({origin}->{destination}): {fast_secs}s vs {slow_secs}s"
        )
        assert fast_load > slow_load, "V1 must be the more crowded option"
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

    def test_route_shape_is_road_geometry_not_a_straight_line(self, client):
        """The polyline must be denser than the stop list it replaces.

        If shape points were just the stop coordinates the map would be back
        to drawing straight lines through the city, so the geometry has to
        carry many more vertices than there are stops.
        """
        for route in client.get("/api/routes").json():
            stops = client.get(f"/api/routes/{route['id']}/stops").json()
            r = client.get(f"/api/routes/{route['id']}/shape")
            assert r.status_code == 200, r.text
            shape = r.json()

            assert shape["code"] == route["code"]
            assert shape["point_count"] == len(shape["points"])
            assert shape["point_count"] > len(stops), (
                f"{route['code']}: {shape['point_count']} shape points for "
                f"{len(stops)} stops means the polyline is just the stops"
            )
            assert shape["total_m"] > 1000
            assert shape["points"][0]["cum_m"] == 0.0
            # cumulative distance must never go backwards
            cums = [p["cum_m"] for p in shape["points"]]
            assert cums == sorted(cums)

    def test_route_shape_404_uses_the_error_contract(self, client):
        r = client.get("/api/routes/9999/shape")
        assert r.status_code == 404
        body = r.json()
        assert body["code"] == "route_not_found"
        assert isinstance(body["detail"], str)


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


# ===========================================================================
# Route scoping - the live map must draw ONE route, never the whole network
# ===========================================================================

class TestRouteScoping:
    """The bug: selecting a route still drew every route's buses.

    The map consumed a fleet-wide /api/buses/active and only ever applied the
    selection as a paint filter, so highlighting the chosen route never removed
    the others. These tests pin the scope to the data itself - on the endpoint,
    on the WebSocket, and in the legacy endpoint's optional filter - so that
    cannot come back.
    """

    def test_route_live_returns_only_that_route(self, client):
        r = client.get("/api/routes/1/live")
        assert r.status_code == 200, r.text
        body = r.json()

        assert body["route"]["id"] == 1
        assert body["buses"], "route 1 has an active trip in the seed"
        for bus in body["buses"]:
            assert bus["route_id"] == 1, f"route 1 payload leaked bus on {bus['route_code']}"

    def test_route_live_stops_and_shape_agree_with_the_singular_endpoints(self, client):
        """The bundled payload must not drift from the endpoints it replaces."""
        live = client.get("/api/routes/1/live").json()
        stops = client.get("/api/routes/1/stops").json()
        shape = client.get("/api/routes/1/shape").json()

        assert [s["stop"]["code"] for s in live["stops"]] == [s["stop"]["code"] for s in stops]
        assert live["shape"]["point_count"] == shape["point_count"]
        assert live["shape"]["route_id"] == shape["route_id"]

    def test_two_routes_return_disjoint_bus_sets(self, client):
        """If both routes report the same buses, the scope is not applied."""
        first = client.get("/api/routes/1/live").json()["buses"]
        second = client.get("/api/routes/2/live").json()["buses"]

        assert {b["route_id"] for b in first} == {1}
        assert {b["route_id"] for b in second} == {2}
        assert not ({b["bus_id"] for b in first} & {b["bus_id"] for b in second})

    def test_route_with_no_active_trip_is_an_empty_list_not_an_error(self, client, seeded_db):
        """Edge case: a valid route with no service must be a 200 with buses: [].

        The seed runs a trip on every route, so one has to be retired to reach
        this state. An empty list is a real answer; a 404 or a 500 would make
        the map show a broken feed for a route that simply has nothing running.
        """
        from simulation_ml.db import models as m

        Session = m.get_sessionmaker(seeded_db)
        with Session() as s:
            trip = s.query(m.Trip).filter(m.Trip.status == "active").first()
            trip.status = "completed"
            route_id = trip.route_id
            s.commit()

        r = client.get(f"/api/routes/{route_id}/live")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["buses"] == []
        # The route itself still resolves - only its service is gone.
        assert body["route"]["id"] == route_id
        assert body["stops"], "stops are static reference data and must still load"

    def test_route_live_404_uses_the_error_contract(self, client):
        r = client.get("/api/routes/99999/live")
        assert r.status_code == 404
        body = r.json()
        assert body["code"] == "route_not_found"
        assert body["detail"]

    def test_buses_active_is_still_fleet_wide_without_the_filter(self, client):
        """Omitting route_id must not change the existing contract behaviour."""
        fleet = client.get("/api/buses/active").json()
        scoped = client.get("/api/buses/active?route_id=1").json()

        assert len(scoped) < len(fleet), "the filter must actually narrow"
        assert {b["route_id"] for b in scoped} == {1}

    def test_websocket_honours_the_route_scope(self, client):
        with client.websocket_connect("/api/ws/buses?route_id=2") as ws:
            payload = ws.receive_json()

        assert payload, "route 2 has an active trip in the seed"
        assert {b["route_id"] for b in payload} == {2}

    def test_websocket_without_a_scope_stays_fleet_wide(self, client):
        """An unscoped socket must keep working - the fleet panels rely on it."""
        with client.websocket_connect("/api/ws/buses") as ws:
            payload = ws.receive_json()

        assert {b["route_id"] for b in payload} == {1, 2, 3}

    def test_malformed_route_scope_is_ignored_rather_than_fatal(self, client):
        """A junk scope must not drop the socket and leave the client blind."""
        with client.websocket_connect("/api/ws/buses?route_id=abc") as ws:
            payload = ws.receive_json()

        assert isinstance(payload, list)
        assert len(payload) == 3, "a bad scope falls back to the fleet, not to nothing"


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
            json={"from": "STOP_MARS", "to": "STOP_VELLORE_OLD_BUS_STAND"},
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
            json={"from": "STOP_VIT", "to": "STOP_VELLORE_OLD_BUS_STAND"},
        )
        assert r.status_code == 200, r.text
        options = r.json()["options"]
        assert len(options) >= 2, (
            "crowd-aware planning is the whole point - one option is a failure"
        )

    def test_plan_options_match_the_contract(self, client):
        r = client.post(
            "/api/routes/plan",
            json={"from": "STOP_VIT", "to": "STOP_VELLORE_OLD_BUS_STAND"},
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
            json={"from": "STOP_VIT", "to": "STOP_VELLORE_OLD_BUS_STAND"},
        )
        etas = [o["eta_min"] for o in r.json()["options"]]
        assert etas == sorted(etas)

    def test_plan_preserves_the_contrast(self, client):
        """V1 should beat V2 on ETA while being worse on crowding."""
        r = client.post(
            "/api/routes/plan",
            json={"from": "STOP_VIT", "to": "STOP_VELLORE_OLD_BUS_STAND"},
        )
        options = r.json()["options"]
        fast = min(options, key=lambda o: o["eta_min"])
        ratio = fast["crowd_load"] / fast["capacity"]
        assert ratio >= 0.4, "the fastest option should NOT also be the empty one"

    def test_unknown_stop_is_a_clean_400(self, client):
        r = client.post(
            "/api/routes/plan",
            json={"from": "STOP_MARS", "to": "STOP_VELLORE_OLD_BUS_STAND"},
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
                "from": "STOP_VIT",
                "to": "STOP_VELLORE_OLD_BUS_STAND",
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
            json={"from": "STOP_VIT", "to": "STOP_VELLORE_OLD_BUS_STAND"},
        ).json()

        r = client.put(f"/api/trips/{trip_id}/crowd", json={"load": 2, "capacity": 50})
        assert r.status_code == 200, r.text
        assert r.json()["level"] == "low"

        after = client.post(
            "/api/routes/plan",
            json={"from": "STOP_VIT", "to": "STOP_VELLORE_OLD_BUS_STAND"},
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
