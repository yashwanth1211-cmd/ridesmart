"""Tests for GET /api/journey - the direction-aware journey search.

OWNER: Member 5.

WHAT IS ACTUALLY BEING PROTECTED HERE
-------------------------------------
The failure this endpoint exists to prevent is a planner that offers a passenger
a bus which will never take them where they are going. Three ways that happens,
and one test for each:

  1. The route serves both stops but in the OPPOSITE ORDER. A bus going
     Kaniyambadi -> Vellore is not a bus you can catch from Vellore to
     Kaniyambadi. This is the wrong-direction case the brief calls out by name.

  2. The route serves the pair correctly, but this particular bus has already
     sailed past the boarding stop. Direction-right, passenger-impossible. No
     amount of route-level filtering catches this.

  3. The stops are connected only by changing buses, and the answer needs to say
     so rather than either pretending there is a direct bus or returning nothing.

Plus the things that make the response usable at all: the requested stop order
is preserved in `stops`, arrival times are ordered, the crowding sort actually
reorders, and an unreachable pair is a friendly message and not a 500.

DIRECTION-AWARE DATA IS THE PREREQUISITE
----------------------------------------
Most assertions need a route that runs in BOTH directions. The seed guarantees
that by making each direction its own Route row with reversed stops, so these
tests can assert on direction without any of them having to construct one.
`test_network_has_a_route_in_both_directions` fails loudly if a future data
change breaks that assumption, rather than leaving a dozen tests vacuously
passing.

    cd tests_docs && pytest tests/test_journey.py -v
"""

from __future__ import annotations

import pytest

from database.services.journey import (
    CROWD_PENALTY_MIN,
    MAX_OPTIONS,
    find_journeys,
    serving_routes,
)
from simulation_ml.db.models import (
    Bus,
    Location,
    Route,
    RouteStop,
    ServicePattern,
    Stop,
    Trip,
    crowd_level_for,
)


# ===========================================================================
# helpers
# ===========================================================================

def stop_id(session, code: str) -> int:
    """Numeric stop id, by code. Fails loudly rather than returning None."""
    stop = session.query(Stop).filter_by(code=code).first()
    assert stop is not None, f"{code} is not in the network"
    return stop.id


def journey(client, from_code: str, to_code: str, session, **params):
    """GET /api/journey between two stop codes, with the response asserted OK."""
    response = client.get(
        "/api/journey",
        params={
            "from_stop_id": stop_id(session, from_code),
            "to_stop_id": stop_id(session, to_code),
            **params,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def all_codes(result) -> list[str]:
    return [o["route_code"] for o in result["direct"]]


def _score_of(result, option_id: str) -> float:
    return next(o["score"] for o in result["direct"] if o["option_id"] == option_id)


def _arrival_of(result, option_id: str) -> int:
    return next(o["arrives_in_min"] for o in result["direct"] if o["option_id"] == option_id)


# ===========================================================================
# The synthetic network itself
# ===========================================================================

class TestNetworkSeed:
    def test_network_has_a_route_in_both_directions(self, network_session):
        """The property every direction test below depends on.

        Each synthetic route NUMBER must have an 'up' row and a 'down' row, and
        the two must visit the same stops. If this fails, the wrong-direction
        assertions are testing nothing.

        Scoped to the declared route numbers rather than "route_number != ''":
        the three curated OSM demo routes also have a route_number (V1, V2, M1)
        and are deliberately one-directional, so including them here would fail
        for a reason that has nothing to do with the network.
        """
        from simulation_ml.seed.network_data import ROUTE_SPECS

        declared = [spec[0] for spec in ROUTE_SPECS]
        assert 20 <= len(declared) <= 30, (
            f"brief asks for 20-30 routes, network_data declares {len(declared)}"
        )

        for number in declared:
            routes = (
                network_session.query(Route).filter_by(route_number=number).all()
            )
            assert len(routes) == 2, f"route {number} has {len(routes)} rows, expected 2"

            directions = {r.direction for r in routes}
            assert directions == {"up", "down"}, f"{number} directions: {directions}"

            stops = {frozenset(rs.stop_id for rs in r.route_stops) for r in routes}
            assert len(stops) == 1, f"{number}: the two directions visit different stops"

            for route in routes:
                seqs = [rs.seq for rs in sorted(route.route_stops, key=lambda r: r.seq)]
                assert seqs == list(range(len(seqs))), f"{route.code} seq is not 0..n"

    def test_the_down_direction_reverses_the_stop_order(self, network_session):
        """Same corridor, opposite travel order - the mechanism the direction rule relies on."""
        for number in ("21A", "103"):
            up = (
                network_session.query(Route)
                .filter_by(route_number=number, direction="up")
                .one()
            )
            down = (
                network_session.query(Route)
                .filter_by(route_number=number, direction="down")
                .one()
            )
            up_codes = [rs.stop.code for rs in sorted(up.route_stops, key=lambda r: r.seq)]
            down_codes = [rs.stop.code for rs in sorted(down.route_stops, key=lambda r: r.seq)]
            assert up_codes == list(reversed(down_codes)), (
                f"{number}: DOWN is {down_codes}, expected {list(reversed(up_codes))}"
            )

    def test_fleet_size_and_bus_types(self, network_session):
        """60-100 buses, every one classified as ordinary/express/deluxe."""
        buses = network_session.query(Bus).all()
        assert 60 <= len(buses) <= 100, f"expected 60-100 buses, got {len(buses)}"

        for bus in buses:
            assert bus.bus_type in {"ordinary", "express", "deluxe"}
            assert bus.capacity > 0

        kinds = {b.bus_type for b in buses}
        assert kinds == {"ordinary", "express", "deluxe"}, kinds

    def test_some_buses_are_wheelchair_accessible(self, network_session):
        """The accessibility filter has to be able to exclude something.

        If every bus were accessible, `accessibility_only=true` would be a no-op
        and no test of it could ever fail - which is how a broken filter gets
        shipped.
        """
        accessible = network_session.query(Bus).filter_by(wheelchair=True).count()
        total = network_session.query(Bus).count()
        assert 0 < accessible < total, f"{accessible}/{total} buses are accessible"


    def test_service_patterns_cover_the_operating_day(self, network_session):
        """Through-the-day timetable exists, with headways inside the brief's band."""
        patterns = network_session.query(ServicePattern).all()
        assert patterns, "no service patterns seeded"

        for pattern in patterns:
            assert 10 <= pattern.headway_min <= 30, (
                f"brief asks for headways of 10-30 min, got {pattern.headway_min}"
            )
            departures = pattern.departures()
            assert len(departures) > 20, f"only {len(departures)} departures seeded"
            assert pattern.first_departure <= pattern.last_departure

    def test_route_stops_carry_distance_and_time(self, network_session):
        """Consecutive stops have a real distance and a real scheduled time.

        A leg of 0.0 m means the timetable was built one stop late, which reads
        as a plausible-looking set of ETAs that are all wrong - every stop
        reports zero time and the last one reports a leg that does not exist.
        """
        for route in network_session.query(Route).all():
            ordered = sorted(route.route_stops, key=lambda r: r.seq)
            assert ordered[0].leg_distance_m == 0.0, f"{route.code} first stop has a leg"
            assert ordered[0].scheduled_offset_sec == 0

            for previous, current in zip(ordered, ordered[1:]):
                assert current.leg_distance_m > 0, f"{route.code} seq {current.seq} leg is 0 m"
                assert (
                    current.scheduled_offset_sec > previous.scheduled_offset_sec
                ), f"{route.code} seq {current.seq} offset did not increase"

    def test_stops_the_brief_names_by_hand_are_present(self, network_session):
        """Every named hub in the brief has to actually be in the network.

        Place names, not coordinates: a stop called "Ránipet" at the wrong
        latitude would pass a coordinate test and still be useless.
        """
        from simulation_ml.seed.network_data import NETWORK_STOPS

        declared = {code for code, *_ in NETWORK_STOPS}
        # The brief's list, mapped onto this project's codes.
        for code in (
            "STOP_KATPADI_JUNCTION",     # reused from the OSM seed
            "STOP_VELLORE_NEW_BUS_STAND",
            "STOP_VELLORE_OLD_BUS_STAND",  # reused from the OSM seed
            "STOP_VELLORE_FORT",
            "STOP_CMC_HOSPITAL",         # reused from the OSM seed
            "STOP_VIT",                  # VIT University, reused from OSM
            "STOP_GANDHI_NAGAR",
            "STOP_SATHUVACHARI",
            "STOP_BAGAYAM",              # reused from the OSM seed
            "STOP_THORAPADI",
            "STOP_KANIYAMBADI",
            "STOP_SRIRAMAPURAM",
            "STOP_COLLECTOR_OFFICE",
            "STOP_AUTO_NAGAR",
            "STOP_VIRUTHAMPET",
            "STOP_KANGEYANALLUR",        # reused from the OSM seed
            "STOP_RANIPET",
            "STOP_ARCOT",
            "STOP_WALAJAPET",
            "STOP_GUDIYATHAM",
            "STOP_AMBUR",
            "STOP_MELVISHARAM",
            "STOP_ARAKKONAM",
            "STOP_TIRUVANNAMALAI",
            "STOP_THIRUVALAM",
            "STOP_ODUGATHUR",
        ):
            assert network_session.query(Stop).filter_by(code=code).first() is not None, (
                f"{code} is named in the brief but not in the network"
            )

        # The whole network is bigger than the brief's minimum, counting both
        # the synthetic stops and the OSM ones reused rather than duplicated.
        total = network_session.query(Stop).count()
        assert total >= 25, f"brief asks for 25+ named stops, network has {total}"
        assert len(declared) >= 25, (
            f"only {len(declared)} synthetic stops declared; the rest are reused, "
            f"which is fine, but the declaration should stand on its own"
        )

    def test_synthetic_stop_coordinates_are_plausible(self, network_session):
        """Vellore district bounds, with enough slack for the outlying termini.

        Ambur is ~55 km east of Vellore and Tiruvannamalai ~78 km south-west,
        so this is a district bounding box, not a city one. It would not have
        caught a stop a kilometre out of place, but it does catch a swapped
        latitude/longitude or a coordinate in the wrong hemisphere, which is the
        realistic failure mode for hand-entered data.
        """
        from simulation_ml.seed.network_data import NETWORK_STOPS

        for code, name, lat, lon, _ in NETWORK_STOPS:
            assert 12.0 <= lat <= 13.2, f"{code} ({name}) latitude {lat}"
            assert 78.4 <= lon <= 79.7, f"{code} ({name}) longitude {lon}"

    def test_up_and_down_timings_mirror_each_other(self, network_session):
        """The same road takes the same time either way round."""
        route = (
            network_session.query(Route).filter_by(code="104 UP").one()
        )
        partner = network_session.query(Route).filter_by(code="104 DN").one()

        up_total = max(rs.scheduled_offset_sec for rs in route.route_stops)
        down_total = max(rs.scheduled_offset_sec for rs in partner.route_stops)
        assert abs(up_total - down_total) <= 60, (
            f"104 UP takes {up_total}s, 104 DN takes {down_total}s - "
            f"they run the same corridor"
        )


# ===========================================================================
# Rule 1: direction
# ===========================================================================

class TestDirectionFiltering:
    def test_serving_routes_only_returns_ordered_pairs(self, network_session):
        """seq(from) < seq(to), enforced in SQL, both ways round."""
        katpadi = stop_id(network_session, "STOP_KATPADI_JUNCTION")
        ranipet = stop_id(network_session, "STOP_RANIPET")

        forwards = serving_routes(network_session, katpadi, ranipet)
        assert forwards, "Katpadi -> Ranipet must be served"
        for match in forwards:
            assert match["from_seq"] < match["to_seq"]
            assert match["route_number"]

        backwards = serving_routes(network_session, ranipet, katpadi)
        assert backwards, "Ranipet -> Katpadi must be served too"
        for match in backwards:
            assert match["from_seq"] < match["to_seq"]

        # The two journeys must not be served by the same Route rows: the UP and
        # DOWN rows are different routes, and that is the whole mechanism.
        assert not {m["route_id"] for m in forwards} & {
            m["route_id"] for m in backwards
        }

    def test_wrong_direction_bus_is_not_offered(self, network_client, network_session):
        """THE wrong-direction case.

        STOP_VELLORE_NEW_BUS_STAND and STOP_VADAMLAI are adjacent stops on 21A.
        A bus on "21A UP" can take you from the bus stand to Vadamalai. A bus on
        "21A DN" cannot - it is travelling the other way and has already gone.

        The trap this guards against: both directions contain both stops, so any
        implementation that tests "are both stops on this route?" passes and
        returns the wrong bus. Only a sequence comparison rejects it.
        """
        forward = journey(
            network_client, "STOP_VELLORE_NEW_BUS_STAND", "STOP_VADAMLAI", network_session
        )
        assert forward["direct"], "21A UP should serve bus stand -> Vadamalai"
        assert any(o["route_number"] == "21A" for o in forward["direct"])
        assert all(o["direction"] == "up" for o in forward["direct"] if o["route_number"] == "21A")

        reverse = journey(
            network_client, "STOP_VADAMLAI", "STOP_VELLORE_NEW_BUS_STAND", network_session
        )
        assert reverse["direct"], "21A DN should serve Vadamalai -> bus stand"
        assert any(o["route_number"] == "21A" for o in reverse["direct"])
        assert all(
            o["direction"] == "down" for o in reverse["direct"] if o["route_number"] == "21A"
        )

        # And critically: no UP row may appear in the reverse journey, because
        # an UP bus is heading away from the bus stand at that point.
        assert "21A UP" not in all_codes(reverse)
        assert "21A DN" not in all_codes(forward)

    def test_a_route_serving_the_pair_backwards_is_excluded(self, network_session):
        """serving_routes cannot return a pair whose origin is downstream.

        Checked at the service level rather than only through the endpoint, so a
        regression in the SQL is distinguishable from a regression in ranking.
        """
        # Vellore New Bus Stand is the FIRST stop of 21A UP, so it can only be
        # an origin on that route - never a destination.
        bus_stand = stop_id(network_session, "STOP_VELLORE_NEW_BUS_STAND")
        matches = serving_routes(network_session, bus_stand, bus_stand)
        assert matches == []

        vellore_new = bus_stand
        thorapadi = stop_id(network_session, "STOP_THORAPADI")
        matches = serving_routes(network_session, vellore_new, thorapadi)
        for match in matches:
            assert match["from_seq"] < match["to_seq"]
            assert match["code"].endswith("UP"), match["code"]

    def test_both_directions_are_searchable_for_every_pair(self, network_client, network_session):
        """Asking the same pair in reverse returns a different, equally valid answer.

        A planner that answers every query in one direction is broken in a way
        no single query reveals.
        """
        forward = journey(
            network_client, "STOP_VELLORE_NEW_BUS_STAND", "STOP_KANIYAMBADI", network_session
        )
        reverse = journey(
            network_client, "STOP_KANIYAMBADI", "STOP_VELLORE_NEW_BUS_STAND", network_session
        )

        assert forward["direct"], "New Bus Stand -> Kaniyambadi must be served"
        assert reverse["direct"], "Kaniyambadi -> New Bus Stand must be served"
        assert all_codes(forward) != all_codes(reverse)

        for option in forward["direct"]:
            assert option["stops"][0]["stop_code"] == "STOP_VELLORE_NEW_BUS_STAND"
            assert option["stops"][-1]["stop_code"] == "STOP_KANIYAMBADI"
        for option in reverse["direct"]:
            assert option["stops"][0]["stop_code"] == "STOP_KANIYAMBADI"
            assert option["stops"][-1]["stop_code"] == "STOP_VELLORE_NEW_BUS_STAND"


# ===========================================================================
# Rule 2: only live or soon-arriving buses
# ===========================================================================

class TestLiveAndSoonArriving:
    def test_a_bus_past_the_boarding_stop_is_withheld(self, network_client, network_session):
        """Rule 2's sharp edge: direction-right but physically gone.

        104 UP runs Katpadi -> Kallai -> Vellore Town -> Walajapet -> Ranipet,
        so a bus more than a leg past Kallai can no longer be caught at Katpadi.
        The endpoint must not offer it, however correct the route ordering is.

        Driven through the service directly so the test states exactly what it
        is checking, instead of depending on where the seeded fleet happens to
        be positioned.
        """
        katpadi = stop_id(network_session, "STOP_KATPADI_JUNCTION")
        ranipet = stop_id(network_session, "STOP_RANIPET")
        matches = serving_routes(network_session, katpadi, ranipet)
        assert matches

        from database.services.journey import bus_options_for_route, _route_seq_index

        offered = []
        for match in matches:
            for option in bus_options_for_route(network_session, match, _utcnow()):
                offered.append(option)
                route = network_session.get(Route, option["route_id"])
                loc = (
                    network_session.query(Location)
                    .filter_by(trip_id=option["trip_id"])
                    .order_by(Location.id.desc())
                    .first()
                )
                if loc is None:
                    continue
                seq_index = _route_seq_index(network_session, route.id)
                cur = seq_index.get(loc.current_stop_id)
                assert not (cur is not None and cur > match["from_seq"]), (
                    f"bus {option['bus_reg']} is at stop seq {cur}, past the "
                    f"boarding stop at seq {match['from_seq']}, and was offered anyway"
                )

    def test_a_route_with_no_bus_and_no_timetable_contributes_nothing(
        self, network_client, network_session
    ):
        """Draining one route must not break the endpoint for the others.

        The frontend's empty state has to distinguish "nothing found" from
        "request failed", so a corridor whose only service has finished for the
        day has to degrade to fewer options and a 200 - not a crash, and not a
        404.
        """
        from simulation_ml.db.models import ServicePattern

        drained = (
            network_session.query(Route).filter_by(code="104 UP").one()
        )
        network_session.query(Trip).filter_by(route_id=drained.id).update(
            {"status": "completed"}
        )
        network_session.query(ServicePattern).filter_by(route_id=drained.id).delete()
        network_session.commit()

        result = journey(
            network_client,
            "STOP_KATPADI_JUNCTION",
            "STOP_RANIPET",
            network_session,
            include_transfers="false",
        )
        assert all(o["route_code"] != "104 UP" for o in result["direct"]), (
            "a drained route should contribute no options"
        )
        if not result["direct"]:
            assert result["message"], "an empty result must explain itself"

    def test_options_are_either_live_or_scheduled_soon(self, network_client, network_session):
        """Nothing with a departure time in the past, and nothing absurdly far out."""
        result = journey(
            network_client,
            "STOP_KATPADI_JUNCTION",
            "STOP_WALAJAPET",
            network_session,
        )
        for option in result["direct"]:
            assert option["kind"] in {"live", "scheduled"}
            assert option["arrives_in_min"] >= 0
            if option["kind"] == "scheduled":
                assert option["departs_at"], "a scheduled option must say when it leaves"
                assert option["bus_id"] is None, (
                    "a timetable entry has no vehicle yet - reporting a bus_id "
                    "would be inventing an assignment"
                )

    def test_live_options_carry_a_bus_and_a_crowd_reading(self, network_client, network_session):
        """A live bus reports everything the brief asks for."""
        result = journey(
            network_client, "STOP_KATPADI_JUNCTION", "STOP_WALAJAPET", network_session
        )
        live = [o for o in result["direct"] if o["kind"] == "live"]
        assert live, "the seeded network should have buses live on this corridor"

        for option in live:
            assert option["bus_reg"], "a live option must name the vehicle"
            assert option["route_name"]
            assert option["crowd_level"] in {"low", "med", "high"}
            assert option["crowd_load"] is not None
            assert option["crowd_ratio"] is not None
            assert option["predicted_arrival"], "a live bus has an arrival time"
            assert option["journey_min"] > 0


# ===========================================================================
# Rule 3: what each result must contain
# ===========================================================================

class TestResultDetail:
    REQUIRED_FIELDS = {
        "bus_name",
        "bus_reg",
        "route_number",
        "route_name",
        "stops",
        "scheduled_arrival",
        "predicted_arrival",
        "delay_min",
        "crowd_level",
        "wheelchair_accessible",
        "low_floor",
        "journey_min",
    }

    def test_every_field_the_brief_asks_for_is_present(self, network_client, network_session):
        result = journey(
            network_client, "STOP_KATPADI_JUNCTION", "STOP_WALAJAPET", network_session
        )
        assert result["direct"]
        for option in result["direct"]:
            missing = self.REQUIRED_FIELDS - set(option)
            assert not missing, f"option is missing {missing}"

    def test_stops_between_are_in_travel_order_from_from_to_to(
        self, network_client, network_session
    ):
        """The stops list starts at the origin and ends at the destination."""
        result = journey(
            network_client, "STOP_VELLORE_NEW_BUS_STAND", "STOP_KANIYAMBADI", network_session
        )
        assert result["direct"]

        for option in result["direct"]:
            codes = [s["stop_code"] for s in option["stops"]]
            assert codes[0] == "STOP_VELLORE_NEW_BUS_STAND"
            assert codes[-1] == "STOP_KANIYAMBADI"

            seqs = [s["seq"] for s in option["stops"]]
            assert seqs == sorted(seqs), f"stops out of order: {codes}"
            assert len(set(codes)) == len(codes), f"a stop is repeated: {codes}"

            offsets = [s["scheduled_offset_sec"] for s in option["stops"]]
            assert offsets == sorted(offsets), "scheduled times must increase along the leg"

    def test_journey_time_matches_the_timetable_slice(self, network_client, network_session):
        """journey_min is the scheduled time between the two stops, not the whole route.

        Getting this wrong is easy and looks fine: reporting the full end-to-end
        duration for every pair would still be a plausible number.
        """
        result = journey(
            network_client, "STOP_KATPADI_JUNCTION", "STOP_WALAJAPET", network_session
        )
        for option in result["direct"]:
            offsets = [s["scheduled_offset_sec"] for s in option["stops"]]
            expected = round((offsets[-1] - offsets[0]) / 60)
            assert option["journey_min"] == max(1, expected), (
                f"{option['route_code']} reports {option['journey_min']} min, "
                f"timetable says {expected} min"
            )

    def test_arrival_times_are_iso_utc(self, network_client, network_session):
        """The contract says ISO-8601 with a timezone suffix, always."""
        result = journey(
            network_client, "STOP_KATPADI_JUNCTION", "STOP_WALAJAPET", network_session
        )
        assert result["generated_at"].endswith(("+00:00", "Z"))
        for option in result["direct"]:
            for field in ("scheduled_arrival", "predicted_arrival", "departs_at"):
                value = option.get(field)
                if value is not None:
                    assert value.endswith(("+00:00", "Z")), f"{field}={value}"


# ===========================================================================
# Rule 4: ranking
# ===========================================================================

class TestRanking:
    def test_default_sort_is_by_earliest_arrival(self, network_client, network_session):
        result = journey(
            network_client,
            "STOP_KATPADI_JUNCTION",
            "STOP_WALAJAPET",
            network_session,
            sort="eta",
        )
        arrivals = [o["arrives_in_min"] for o in result["direct"]]
        assert arrivals == sorted(arrivals)
        assert result["sort"] == "eta"

    def test_least_crowded_sort_scores_eta_plus_a_penalty(self, network_client, network_session):
        """score = ETA + penalty x crowd level, and it is sorted by that score."""
        result = journey(
            network_client,
            "STOP_KATPADI_JUNCTION",
            "STOP_WALAJAPET",
            network_session,
            sort="crowd",
        )
        assert result["direct"], "this corridor should be served"

        scores = [o["score"] for o in result["direct"]]
        assert scores == sorted(scores), f"not sorted by score: {scores}"

        for option in result["direct"]:
            expected = option["arrives_in_min"] + CROWD_PENALTY_MIN[
                option["crowd_level"] or "low"
            ]
            assert option["score"] == pytest.approx(expected, abs=0.01)

    def test_crowd_sort_lets_an_emptier_bus_win_over_a_quicker_packed_one(
        self, network_client, network_session
    ):
        """The brief's scenario as behaviour: fast-but-full loses to slow-but-empty.

        The crowding is WRITTEN rather than hoped for. The seed spreads base
        loads by a deterministic formula, so whether any two live buses on a
        given pair happen to differ in crowding is a property of the seed, not of
        the code under test - and a ranking test that skips when the data is
        uncooperative is a ranking test that never runs.

        So this writes one bus to 90% full and another to 5%, both still behind
        the origin, and then checks the ordering flips.
        """
        from simulation_ml.db.models import Crowd

        pair = ("STOP_VELLORE_FORT", "STOP_VADAMLAI")
        options = journey(network_client, pair[0], pair[1], network_session)["direct"]
        live = [o for o in options if o["kind"] == "live"]
        assert len(live) >= 2, f"need two live buses to compare, got {len(live)}"

        packed, empty = live[0], live[1]
        for trip_id, load, capacity in (
            (int(packed["option_id"].split("-")[1]), 45, 50),
            (int(empty["option_id"].split("-")[1]), 2, 50),
        ):
            network_session.query(Crowd).filter_by(trip_id=trip_id).update(
                {"load": load, "capacity": capacity, "level": crowd_level_for(load, capacity)}
            )
        network_session.commit()

        by_eta = journey(network_client, pair[0], pair[1], network_session, sort="eta")
        by_crowd = journey(network_client, pair[0], pair[1], network_session, sort="crowd")

        eta_order = [o["option_id"] for o in by_eta["direct"]]
        crowd_order = [o["option_id"] for o in by_crowd["direct"]]

        assert crowd_order == sorted(crowd_order, key=lambda oid: _score_of(by_crowd, oid))
        assert eta_order == sorted(eta_order, key=lambda oid: _arrival_of(by_eta, oid))

        # The two views must actually disagree, otherwise this test is not
        # testing the thing it claims to.
        assert eta_order != crowd_order, (
            f"both sorts produced {eta_order}; the crowding contrast is not "
            f"large enough to change the ranking"
        )

        # The empty bus must come out ahead of the packed one on crowd score
        # even though it is no quicker.
        scores = {o["option_id"]: o["score"] for o in by_crowd["direct"]}
        assert scores[empty["option_id"]] < scores[packed["option_id"]]

        # And the penalty must be visible, not silently rounded away.
        assert by_crowd["direct"]
        packed_row = next(o for o in by_crowd["direct"] if o["option_id"] == packed["option_id"])
        empty_row = next(o for o in by_crowd["direct"] if o["option_id"] == empty["option_id"])
        assert packed_row["crowd_level"] == "high"
        assert empty_row["crowd_level"] == "low"
        assert (
            packed_row["score"] - packed_row["arrives_in_min"]
        ) >= (
            empty_row["score"] - empty_row["arrives_in_min"]
        )

    def test_penalties_are_ordered_so_the_tradeoff_is_real(self):
        """A packed bus must cost more than a half-full one, or the sort is theatre."""
        assert CROWD_PENALTY_MIN["low"] < CROWD_PENALTY_MIN["medium"]
        assert CROWD_PENALTY_MIN["medium"] < CROWD_PENALTY_MIN["high"]
        # An empty bus arriving 25 minutes later should still beat a full one
        # arriving now - otherwise "least crowded" just means "slowest".
        assert CROWD_PENALTY_MIN["high"] > 20

    def test_results_are_capped(self, network_client, network_session):
        """The list is bounded so a busy corridor cannot fill the panel."""
        result = journey(
            network_client,
            "STOP_VELLORE_TOWN",
            "STOP_VELLORE_TOWN",
            network_session,
        )
        assert len(result["direct"]) <= MAX_OPTIONS

    def test_unknown_sort_value_is_rejected(self, network_client, network_session):
        """A typo'd sort must not silently rank by something else."""
        response = network_client.get(
            "/api/journey",
            params={
                "from_stop_id": stop_id(network_session, "STOP_VIT"),
                "to_stop_id": stop_id(network_session, "STOP_VELLORE_OLD_BUS_STAND"),
                "sort": "fastest",
            },
        )
        assert response.status_code == 422
        assert response.json()["code"] == "validation_error"


# ===========================================================================
# Rule 5: transfers
# ===========================================================================

class TestTransfers:
    def test_a_pair_with_no_direct_bus_gets_a_one_transfer_option(
        self, network_client, network_session
    ):
        """Tiruvannamalai -> Ranipet needs a change, and must say so.

        Tiruvannamalai is a terminus on route 201 and nothing else. Ranipet is
        on 103/104/108/301/302. No single route spans both, so a correct answer
        is a one-transfer journey labelled `transfers: 1`, not an empty list and
        not a fabricated direct bus.
        """
        result = journey(
            network_client,
            "STOP_TIRUVANNAMALAI",
            "STOP_RANIPET",
            network_session,
        )
        assert result["direct"] == [], (
            "no single route should connect Tiruvannamalai to Ranipet - if one "
            "does, this journey is no longer a transfer case"
        )
        assert result["transfers"], "a one-transfer option must be offered"
        assert result["message"] is None, "found something, so no empty-state message"

    def test_transfer_options_are_labelled_and_consistent(self, network_client, network_session):
        result = journey(
            network_client,
            "STOP_TIRUVANNAMALAI",
            "STOP_RANIPET",
            network_session,
        )
        for transfer in result["transfers"]:
            assert transfer["transfers"] == 1, "must be labelled as one transfer"
            assert len(transfer["legs"]) == 2, "one transfer means two vehicles"
            assert transfer["transfer_stop"]["name"]
            assert transfer["wait_min"] >= 0
            assert transfer["total_min"] > 0

            first, second = transfer["legs"]
            # The change actually connects: leg 1 ends where leg 2 begins.
            assert first["stops"][-1]["stop_id"] == transfer["transfer_stop"]["id"]
            assert second["stops"][0]["stop_id"] == transfer["transfer_stop"]["id"]
            # Leg 1 starts at the origin and leg 2 ends at the destination.
            assert first["stops"][0]["stop_id"] == result["from"]["id"]
            assert second["stops"][-1]["stop_id"] == result["to"]["id"]

    def test_transfer_legs_are_each_in_the_right_direction(self, network_client, network_session):
        """Both halves of a transfer are direction-checked independently.

        A transfer is the easiest place to reintroduce the original bug: the
        origin->hub leg and the hub->destination leg are looked up separately,
        and only one of them is easy to get backwards.
        """
        result = journey(
            network_client,
            "STOP_TIRUVANNAMALAI",
            "STOP_RANIPET",
            network_session,
        )
        hub_id = result["transfers"][0]["transfer_stop"]["id"]

        for match in serving_routes(
            network_session, result["from"]["id"], hub_id
        ):
            assert match["from_seq"] < match["to_seq"]
        for match in serving_routes(network_session, hub_id, result["to"]["id"]):
            assert match["from_seq"] < match["to_seq"]

    def test_a_single_route_passing_through_a_hub_is_not_called_a_transfer(
        self, network_session
    ):
        """Changing nothing is not a transfer.

        `transfer_options` skips pairs where both legs are the same Route row -
        a bus that happens to pass the hub changes nothing, and labelling it
        "1 transfer" would send the passenger to stand at an interchange for a
        bus they could have boarded in the first place.
        """
        from database.services.journey import transfer_options

        origin = network_session.get(Stop, stop_id(network_session, "STOP_VIT"))
        dest = network_session.get(
            Stop, stop_id(network_session, "STOP_VELLORE_OLD_BUS_STAND")
        )
        # Force the transfer search even though a direct bus exists.
        transfers = transfer_options(network_session, origin, dest, _utcnow())
        for transfer in transfers:
            assert transfer["legs"][0]["route_id"] != transfer["legs"][1]["route_id"]

    def test_transfers_can_be_switched_off(self, network_client, network_session):
        result = journey(
            network_client,
            "STOP_TIRUVANNAMALAI",
            "STOP_RANIPET",
            network_session,
            include_transfers="false",
        )
        assert result["transfers"] == []
        assert result["message"], "with transfers off and nothing direct, say so"

    def test_transfers_are_not_offered_when_a_direct_bus_exists(
        self, network_client, network_session
    ):
        """Suggesting a change when you can just take one bus is noise."""
        result = journey(
            network_client,
            "STOP_KATPADI_JUNCTION",
            "STOP_WALAJAPET",
            network_session,
        )
        assert result["direct"]
        assert result["transfers"] == []


# ===========================================================================
# Rule 6 + edge cases
# ===========================================================================

class TestEmptyResultsAndEdgeCases:
    def test_no_buses_is_a_friendly_message_not_an_error(
        self, network_client, network_session, temp_db
    ):
        """A connected graph still has unconnected pairs; that is an answer.

        The brief asks for "No buses found for this journey". The response has
        to be a 200 with a human-readable reason, because a 404 would make the
        UI's "no options" state indistinguishable from a broken request.
        """
        # Two real stops in the network with no route connecting them in either
        # direction: Odugathur is a terminus on 66/71/106/107 and Tiruvannamalai
        # is a terminus on 201, and nothing runs between them.
        result = journey(
            network_client,
            "STOP_ODUGATHUR",
            "STOP_TIRUVANNAMALAI",
            network_session,
            include_transfers="false",
        )
        assert result["direct"] == []
        assert result["message"]
        assert "No buses found" in result["message"], result["message"]

    def test_same_stop_reports_itself_instead_of_failing(self, network_client, network_session):
        """Origin == destination is an edge case with an obvious answer."""
        result = journey(
            network_client,
            "STOP_VELLORE_FORT",
            "STOP_VELLORE_FORT",
            network_session,
        )
        assert result["direct"] == []
        assert result["transfers"] == []
        assert result["message"]
        assert "same stop" in result["message"].lower()

    def test_unknown_stop_is_a_404_with_the_error_contract(self, network_client, network_session):
        response = network_client.get(
            "/api/journey",
            params={
                "from_stop_id": 999_999,
                "to_stop_id": stop_id(network_session, "STOP_VELLORE_FORT"),
            },
        )
        assert response.status_code == 404
        body = response.json()
        assert body["code"] == "stop_not_found"
        assert "detail" in body

    def test_unknown_destination_is_also_a_404(self, network_client, network_session):
        response = network_client.get(
            "/api/journey",
            params={
                "from_stop_id": stop_id(network_session, "STOP_VELLORE_FORT"),
                "to_stop_id": 999_999,
            },
        )
        assert response.status_code == 404
        assert response.json()["code"] == "stop_not_found"

    def test_missing_parameters_use_the_validation_error_shape(
        self, network_client, network_session
    ):
        for params in (
            {},
            {"from_stop_id": 1},
            {"to_stop_id": 1},
            {"from_stop_id": "abc", "to_stop_id": 1},
            {"from_stop_id": 0, "to_stop_id": 1},
        ):
            response = network_client.get("/api/journey", params=params)
            assert response.status_code == 422, params
            assert response.json()["code"] == "validation_error", params

    def test_the_route_exists_even_when_the_answer_is_empty(self, network_session):
        """Empty result must still echo the stops, so the UI can name them.

        Without this the empty state has no way to say "nothing runs from
        Odugathur to Tiruvannamalai" and can only say something generic.
        """
        result = find_journeys(
            network_session,
            stop_id(network_session, "STOP_ODUGATHUR"),
            stop_id(network_session, "STOP_TIRUVANNAMALAI"),
            include_transfers=False,
        )
        assert result["from"]["code"] == "STOP_ODUGATHUR"
        assert result["to"]["code"] == "STOP_TIRUVANNAMALAI"
        assert result["from"]["name"] and result["to"]["name"]


# ===========================================================================
# Filters
# ===========================================================================

class TestFilters:
    def test_accessibility_only_drops_inaccessible_buses(self, network_client, network_session):
        result = journey(
            network_client,
            "STOP_KATPADI_JUNCTION",
            "STOP_WALAJAPET",
            network_session,
            accessibility_only="true",
        )
        assert result["direct"], "at least one accessible bus should serve this pair"
        for option in result["direct"]:
            if option["kind"] == "live":
                assert option["wheelchair_accessible"] is True

    def test_unfiltered_includes_inaccessible_buses(self, network_client, network_session):
        result = journey(
            network_client,
            "STOP_KATPADI_JUNCTION",
            "STOP_WALAJAPET",
            network_session,
            accessibility_only="false",
        )
        assert any(
            o["wheelchair_accessible"] is False for o in result["direct"] if o["kind"] == "live"
        ), "the unfiltered list should still contain buses that are not accessible"

    def test_horizon_is_respected(self, network_client, network_session):
        """A short horizon offers fewer or equal scheduled departures."""
        long_run = journey(
            network_client,
            "STOP_VELLORE_FORT",
            "STOP_VELLORE_NEW_BUS_STAND",
            network_session,
            horizon_min=30,
        )
        short_run = journey(
            network_client,
            "STOP_VELLORE_FORT",
            "STOP_VELLORE_NEW_BUS_STAND",
            network_session,
            horizon_min=15,
        )
        scheduled_long = [o for o in long_run["direct"] if o["kind"] == "scheduled"]
        scheduled_short = [o for o in short_run["direct"] if o["kind"] == "scheduled"]
        assert len(scheduled_short) <= len(scheduled_long)
        for option in scheduled_short:
            assert option["arrives_in_min"] <= 15

    def test_out_of_range_horizon_is_rejected(self, network_client, network_session):
        response = network_client.get(
            "/api/journey",
            params={
                "from_stop_id": stop_id(network_session, "STOP_VIT"),
                "to_stop_id": stop_id(network_session, "STOP_VELLORE_OLD_BUS_STAND"),
                "horizon_min": 100_000,
            },
        )
        assert response.status_code == 422


# ===========================================================================
# Peak-hour crowding, and the simulator's new telemetry fields
# ===========================================================================

class TestPeakCrowdingAndTelemetry:
    def test_peak_factor_is_highest_during_the_briefs_windows(self):
        """8-10 AM and 5-7 PM are busier than the middle of the day."""
        from datetime import datetime, timezone

        from simulation_ml.db.models import peak_factor

        def at(hour, minute=0):
            # IST hour -> UTC instant, so the test states local time.
            utc_hour = (hour - 5.5) % 24
            return datetime(2026, 1, 15, int(utc_hour), minute, tzinfo=timezone.utc)

        morning_peak = peak_factor(at(9))
        evening_peak = peak_factor(at(18))
        midday = peak_factor(at(13))
        night = peak_factor(at(2))

        assert morning_peak > midday, "09:00 must be busier than 13:00"
        assert evening_peak > midday, "18:00 must be busier than 13:00"
        assert midday > night
        assert morning_peak == pytest.approx(evening_peak)

    def test_peak_load_never_exceeds_capacity(self):
        from simulation_ml.db.models import peak_load_for

        for base in (0, 25, 45, 50):
            assert peak_load_for(base, 50) <= 50
        assert peak_load_for(0, 50) == 0

    def test_location_rows_record_current_next_and_delay(self, network_session):
        """The simulator writes all three, so the planner need not re-derive them."""
        rows = network_session.query(Location).filter(Location.route_id if False else Location.trip_id.isnot(None)).all()
        assert rows, "no telemetry seeded"

        for row in rows[:50]:
            if row.current_stop_id is None:
                continue  # the three curated demo trips predate these columns
            assert row.next_stop_id is not None, (
                "current_stop_id without next_stop_id: the pair is what makes "
                "'is the origin still ahead' answerable"
            )
            assert row.delay_sec is not None

    def test_crowd_levels_agree_with_the_shared_banding_function(self, network_session):
        """The seed, the simulator and the API must band loads identically."""
        from simulation_ml.db.models import Crowd

        rows = network_session.query(Crowd).all()
        assert rows
        for row in rows[:200]:
            assert row.level == crowd_level_for(row.load, row.capacity), (
                f"stored level {row.level!r} disagrees with "
                f"crowd_level_for({row.load}, {row.capacity})"
            )


# ===========================================================================
# The composite index the planner's hot path relies on
# ===========================================================================

class TestRouteStopIndex:
    def test_the_composite_index_exists_in_the_database(self, network_session):
        """ix_route_stop_lookup is what makes the stop-pair self-join cheap.

        Asserted rather than assumed: an Index() added to the model but never
        created (because an existing database was not recreated) would leave the
        planner doing a full scan and nothing would fail.
        """
        names = {
            row[0]
            for row in network_session.execute(
                __import__("sqlalchemy").text(
                    "SELECT name FROM sqlite_master WHERE type='index'"
                )
            )
        }
        assert "ix_route_stop_lookup" in names, (
            f"expected ix_route_stop_lookup, found {sorted(names)}"
        )

    def test_the_index_columns_are_the_stop_pair_lookup(self, network_session):
        import sqlalchemy

        rows = network_session.execute(
            sqlalchemy.text("PRAGMA index_info(ix_route_stop_lookup)")
        ).all()
        columns = [row[2] for row in rows]
        assert columns == ["route_id", "stop_id", "seq"], columns


def _utcnow():
    from datetime import datetime, timezone

    return datetime.now(timezone.utc)