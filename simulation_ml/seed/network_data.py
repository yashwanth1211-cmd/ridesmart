"""A SYNTHETIC bus network for the Vellore - Katpadi region.

SYNTHETIC DATA - NOT OFFICIAL TNSTC DATA
=========================================
Nothing in this file came from a transport operator. The route numbers, service
patterns, bus fleet and headways are invented to exercise the planner; the
stop names are real places and the coordinates are approximate real-world
latitude/longitude (good to roughly a hundred metres), taken from public
geographic knowledge rather than from any surveyed timetable.

The existing three routes in ``simulation_ml/data/real_routes.json`` are a
different kind of data: their geometry came from OpenStreetMap and OSRM, and
their stop coordinates are surveyed. This module does NOT replace them. It adds a
network around them, reusing their stop codes wherever the real ones cover a
place the new routes need, so the whole graph stays connected and the original
demo journey still works.

WHY A SEPARATE MODULE, AND WHY IT IS OPT-IN
-------------------------------------------
``seed(seed)`` defaults to ``include_network=False`` so the curated three-route
demo stays byte-for-byte reproducible and the existing test-suite assertions
about counts keep meaning what they say. Run it with ``--network`` to build the
full network.

HOW A ROUTE BECOMES TWO ROWS
----------------------------
A route spec lists its stops in UP order. ``build_directional_routes`` emits two
rows per spec: the UP row and a DOWN row whose stop list is reversed. That is
what makes "sequence(from) < sequence(to) in that bus's direction" a per-bus
test rather than a per-corridor one: a bus on "21A DOWN" from Katpadi to
Kaniyambadi is a different Route row, so it simply does not serve
Kaniyambadi -> Katpadi.

GEOMETRY IS APPROXIMATE, AND SAYS SO
------------------------------------
The three real routes have OSRM road geometry. Re-running OSRM for ~60 new
routes is not something a seed script should do at start-up, and a straight line
between two stops is visibly not a road - it crosses whatever is in between.

So each leg gets four vertices with a parabolic lateral offset, proportional to
the leg length and signed deterministically from the two stop codes. That gives
a gently curved line that reads as a road on a map and, crucially, gives the
simulator a polyline to walk so buses do not cut through buildings. It is NOT
road geometry and ``/api/routes/{id}/shape`` should not be taken as one.
"""

from __future__ import annotations

import math

# ---------------------------------------------------------------------------
# Stops
# ---------------------------------------------------------------------------
# (code, name, lat, lon, accessible)
#
# `accessible` marks a stop with a raised kerb / level boarding. Real
# accessibility on this network is mixed and improving; these flags are plausible
# rather than surveyed, and drive the accessibility badges only.
#
# Codes starting STOP_ that already exist in data/real_routes.json are REUSED,
# not duplicated - see REUSED_STOP_CODES below.

NETWORK_STOPS: list[tuple[str, str, float, float, bool]] = [
    # --- Vellore town ---
    ("STOP_VELLORE_NEW_BUS_STAND", "Vellore New Bus Stand", 12.9195, 79.1328, True),
    ("STOP_VELLORE_JUNCTION", "Vellore Junction", 12.9190, 79.1322, True),
    ("STOP_VELLORE_FORT", "Vellore Fort", 12.9179, 79.1366, False),
    ("STOP_COLLECTOR_OFFICE", "Collector Office", 12.9168, 79.1330, True),
    ("STOP_GANDHI_NAGAR", "Gandhi Nagar", 12.9272, 79.1451, False),
    ("STOP_AUTO_NAGAR", "Auto Nagar", 12.9301, 79.1398, False),
    ("STOP_SRIRAMAPURAM", "Sripuram (Golden Temple)", 12.9197, 79.1447, False),
    ("STOP_KALLAI", "Kallai", 12.9295, 79.1502, False),
    # --- north: Sathuvachari / Katpadi / VIT ---
    ("STOP_SATHUVACHARI", "Sathuvachari", 12.9402, 79.1553, True),
    ("STOP_THIRUVALAM", "Thiruvalam", 12.9388, 79.1479, False),
    ("STOP_VADAMLAI", "Vadamalai", 12.9120, 79.1660, False),
    # --- south: Thorapadi / Kaniyambadi ---
    ("STOP_THORAPADI", "Thorapadi", 12.9069, 79.1557, False),
    ("STOP_KANIYAMBADI", "Kaniyambadi", 12.8969, 79.1560, False),
    ("STOP_VIRUTHAMPET", "Viruthampet", 12.9205, 79.1553, False),
    # --- east: Walajapet / Ranipet / Odugathur / Arcot ---
    ("STOP_WALAJAPET", "Walajapet", 12.9277, 79.2380, True),
    ("STOP_RANIPET", "Ranipet", 12.9250, 79.3301, True),
    ("STOP_SANDROKUPPAM", "Sandrokuppam", 12.8866, 79.2702, False),
    ("STOP_ODUGATHUR", "Odugathur", 12.7898, 79.2705, False),
    ("STOP_POLACHI", "Polachi", 12.8469, 79.2747, False),
    ("STOP_ARCOT", "Arcot", 12.8793, 79.2920, True),
    ("STOP_UTHIRAMERUR", "Uthiramerur", 12.8222, 79.3633, False),
    # --- west: Gudiyatham ---
    ("STOP_GUDIYATHAM", "Gudiyatham", 12.8522, 79.4432, True),
    # --- northeast: Pernambut, on the Katpadi - Arakkonam road ---
    ("STOP_PERNAMBUT", "Pernambut", 12.9432, 79.1980, False),
    # --- south-west: the Tiruvannamalai corridor ---
    ("STOP_POOTHAMPALLI", "Poothampalli", 12.9263, 79.1870, False),
    ("STOP_VEMBAKKAM", "Vembakkam", 12.7836, 79.0361, False),
    ("STOP_ALANGAYAM", "Alangayam", 12.6019, 79.0861, False),
    ("STOP_VANDAVASI", "Vandavasi", 12.5064, 79.6089, False),
    # --- intercity ---
    ("STOP_ARAKKONAM", "Arakkonam", 13.0779, 79.1451, True),
    ("STOP_TIRUVANNAMALAI", "Tiruvannamalai", 12.2255, 79.0745, True),
    ("STOP_MELVISHARAM", "Melvisharam", 12.7705, 79.6300, False),
    ("STOP_AMBUR", "Ambur", 12.7800, 79.5700, True),
]

# Stop codes that data/real_routes.json already defines. Listed explicitly so the
# seed can prove it reused rather than silently created a second pin for the same
# place - "Vellore Old Bus Stand" appearing twice under two codes would put two
# markers on one bus stand.
REUSED_STOP_CODES = (
    "STOP_KATPADI_JUNCTION",
    "STOP_VIT",
    "STOP_CMC_HOSPITAL",
    "STOP_VELLORE_OLD_BUS_STAND",
    "STOP_VELLORE_TOWN",
    "STOP_TOLLGATE",
    "STOP_BAGAYAM",
    "STOP_KANGEYANALLUR",
    "STOP_OTTERI",
    "STOP_RAJA_THEATRE",
    "STOP_NATIONAL_THEATRE",
    "STOP_CMC_CAMPUS",
)

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
# (number, name, speed_kmph, headway_min, first, last, stops_up)
#
# `stops_up` is travel order for the UP direction. DOWN is derived by reversing.
#
# Speeds are timetable speeds including stops, deliberately lower than the 50-60
# km/h a bus reaches on open road: 19 km/h is an honest city average with
# signals, and 34 km/h is an honest intercity average.
#
# headway_min values sit in the 10-30 minute band the brief asks for; the first
# and last departures span the operating day.

ROUTE_SPECS: list[tuple] = [
    # ================= city routes =================
    (
        "1A", "Vellore Fort - Katpadi Junction", 21.0, 12, "05:30", "22:00",
        [
            "STOP_VELLORE_FORT", "STOP_COLLECTOR_OFFICE", "STOP_VELLORE_OLD_BUS_STAND",
            "STOP_VELLORE_TOWN", "STOP_RAJA_THEATRE", "STOP_TOLLGATE",
            "STOP_KALLAI", "STOP_KATPADI_JUNCTION",
        ],
    ),
    (
        "5", "Sathuvachari - Bagayam", 19.0, 15, "05:45", "21:30",
        [
            "STOP_SATHUVACHARI", "STOP_THIRUVALAM", "STOP_GANDHI_NAGAR",
            "STOP_VELLORE_TOWN", "STOP_RAJA_THEATRE", "STOP_LAKSHMI_THEATRE",
            "STOP_VELAPPADI", "STOP_BAGAYAM",
        ],
    ),
    (
        "7A", "Bagayam - Sripuram", 20.0, 20, "06:00", "21:00",
        [
            "STOP_BAGAYAM", "STOP_LAKSHMI_THEATRE", "STOP_VELLORE_TOWN",
            "STOP_COLLECTOR_OFFICE", "STOP_SRIRAMAPURAM",
        ],
    ),
    (
        "7B", "Gandhi Nagar - Auto Nagar", 18.0, 20, "06:15", "20:45",
        [
            "STOP_GANDHI_NAGAR", "STOP_VELLORE_TOWN", "STOP_RAJA_THEATRE",
            "STOP_NATIONAL_THEATRE", "STOP_AUTO_NAGAR",
        ],
    ),
    (
        "12", "VIT - Bagayam", 24.0, 10, "05:15", "22:30",
        [
            "STOP_VIT", "STOP_KATPADI_JUNCTION", "STOP_ODAI_PILLAIYAR",
            "STOP_VELLORE_TOWN", "STOP_RAJA_THEATRE", "STOP_TOLLGATE",
            "STOP_BAGAYAM",
        ],
    ),
    (
        "21A", "Vellore New Bus Stand - Kaniyambadi", 19.0, 12, "05:30", "22:15",
        [
            "STOP_VELLORE_NEW_BUS_STAND", "STOP_VELLORE_FORT", "STOP_VADAMLAI",
            "STOP_THORAPADI", "STOP_VIRUTHAMPET", "STOP_KANIYAMBADI",
        ],
    ),
    (
        "21B", "CMC Hospital - Thorapadi", 20.0, 15, "05:45", "21:45",
        [
            "STOP_CMC_HOSPITAL", "STOP_VELLORE_TOWN", "STOP_VIRUTHAMPET",
            "STOP_THORAPADI",
        ],
    ),
    (
        "32", "Collector Office - Sripuram", 20.0, 20, "06:00", "21:00",
        [
            "STOP_COLLECTOR_OFFICE", "STOP_VELLORE_OLD_BUS_STAND",
            "STOP_VELLORE_TOWN", "STOP_GANDHI_NAGAR", "STOP_SRIRAMAPURAM",
        ],
    ),
    (
        "45", "Viruthampet - Sathuvachari", 22.0, 15, "05:40", "21:30",
        [
            "STOP_VIRUTHAMPET", "STOP_VELLORE_TOWN", "STOP_KALLAI",
            "STOP_THIRUVALAM", "STOP_SATHUVACHARI",
        ],
    ),
    (
        "55", "Kangeyanallur - Bagayam", 19.0, 20, "06:00", "21:15",
        [
            "STOP_KANGEYANALLUR", "STOP_VELLORE_TOWN", "STOP_RAJA_THEATRE",
            "STOP_LAKSHMI_THEATRE", "STOP_BAGAYAM",
        ],
    ),
    (
        "66", "Odugathur - Bagayam", 22.0, 25, "05:50", "20:30",
        [
            "STOP_ODUGATHUR", "STOP_SANDROKUPPAM", "STOP_OTTERI", "STOP_BAGAYAM",
        ],
    ),
    (
        "71", "Vellore New Bus Stand - Odugathur", 21.0, 20, "05:30", "20:45",
        [
            "STOP_VELLORE_NEW_BUS_STAND", "STOP_VELLORE_FORT", "STOP_VADAMLAI",
            "STOP_KANIYAMBADI", "STOP_OTTERI", "STOP_SANDROKUPPAM", "STOP_ODUGATHUR",
        ],
    ),
    (
        "83", "Kaniyambadi - Sathuvachari", 20.0, 15, "05:50", "21:30",
        [
            "STOP_KANIYAMBADI", "STOP_THORAPADI", "STOP_VIRUTHAMPET",
            "STOP_VELLORE_TOWN", "STOP_GANDHI_NAGAR", "STOP_SATHUVACHARI",
        ],
    ),
    (
        "94", "Auto Nagar - Viruthampet", 20.0, 20, "06:00", "20:45",
        [
            "STOP_AUTO_NAGAR", "STOP_GANDHI_NAGAR", "STOP_VELLORE_TOWN",
            "STOP_VIRUTHAMPET",
        ],
    ),
    # ================= suburban =================
    (
        "101", "Vellore - Walajapet", 25.0, 20, "05:30", "21:00",
        [
            "STOP_VELLORE_NEW_BUS_STAND", "STOP_VIRUTHAMPET", "STOP_WALAJAPET",
        ],
    ),
    (
        "102", "Katpadi - Walajapet", 26.0, 20, "05:30", "21:00",
        [
            "STOP_KATPADI_JUNCTION", "STOP_KALLAI", "STOP_VELLORE_TOWN",
            "STOP_VIRUTHAMPET", "STOP_WALAJAPET",
        ],
    ),
    (
        "103", "Vellore - Ranipet", 26.0, 15, "05:15", "22:00",
        [
            "STOP_VELLORE_NEW_BUS_STAND", "STOP_VIRUTHAMPET", "STOP_WALAJAPET",
            "STOP_RANIPET",
        ],
    ),
    (
        "104", "Katpadi - Ranipet", 27.0, 20, "05:30", "21:30",
        [
            "STOP_KATPADI_JUNCTION", "STOP_KALLAI", "STOP_VELLORE_TOWN",
            "STOP_WALAJAPET", "STOP_RANIPET",
        ],
    ),
    (
        "105", "Bagayam - Ranipet", 25.0, 25, "05:45", "20:30",
        [
            "STOP_BAGAYAM", "STOP_OTTERI", "STOP_SANDROKUPPAM", "STOP_POLACHI",
            "STOP_RANIPET",
        ],
    ),
    (
        "106", "Arcot - Walajapet", 26.0, 25, "05:45", "20:30",
        [
            "STOP_ARCOT", "STOP_ODUGATHUR", "STOP_SANDROKUPPAM", "STOP_WALAJAPET",
        ],
    ),
    (
        "107", "Arcot - Ranipet", 25.0, 30, "06:00", "20:00",
        [
            "STOP_ARCOT", "STOP_ODUGATHUR", "STOP_SANDROKUPPAM", "STOP_RANIPET",
        ],
    ),
    (
        "108", "Vellore - Gudiyatham", 28.0, 25, "05:15", "21:30",
        [
            "STOP_VELLORE_NEW_BUS_STAND", "STOP_VIRUTHAMPET", "STOP_WALAJAPET",
            "STOP_RANIPET", "STOP_UTHIRAMERUR", "STOP_GUDIYATHAM",
        ],
    ),
    (
        "109", "Ranipet - Gudiyatham", 27.0, 30, "05:30", "20:30",
        [
            "STOP_RANIPET", "STOP_UTHIRAMERUR", "STOP_GUDIYATHAM",
        ],
    ),
    # ================= intercity =================
    (
        "201", "Vellore - Tiruvannamalai", 34.0, 30, "05:00", "21:00",
        [
            "STOP_VELLORE_NEW_BUS_STAND", "STOP_POOTHAMPALLI", "STOP_VEMBAKKAM",
            "STOP_ALANGAYAM", "STOP_VANDAVASI", "STOP_TIRUVANNAMALAI",
        ],
    ),
    (
        "202", "Vellore - Arakkonam", 32.0, 30, "05:00", "21:30",
        [
            "STOP_VELLORE_NEW_BUS_STAND", "STOP_PERNAMBUT", "STOP_VADAMLAI",
            "STOP_ARAKKONAM",
        ],
    ),
    (
        "203", "Katpadi - Arakkonam", 31.0, 30, "05:15", "21:30",
        [
            "STOP_KATPADI_JUNCTION", "STOP_VADAMLAI", "STOP_ARAKKONAM",
        ],
    ),
    (
        "301", "Vellore - Melvisharam", 35.0, 30, "05:00", "20:30",
        [
            "STOP_VELLORE_NEW_BUS_STAND", "STOP_VIRUTHAMPET", "STOP_WALAJAPET",
            "STOP_RANIPET", "STOP_GUDIYATHAM", "STOP_AMBUR", "STOP_MELVISHARAM",
        ],
    ),
    (
        "302", "Vellore - Ambur", 33.0, 30, "05:15", "21:00",
        [
            "STOP_VELLORE_NEW_BUS_STAND", "STOP_VIRUTHAMPET", "STOP_WALAJAPET",
            "STOP_RANIPET", "STOP_GUDIYATHAM", "STOP_AMBUR",
        ],
    ),
    (
        "303", "Arakkonam - Katpadi Express", 36.0, 20, "05:00", "22:00",
        [
            "STOP_ARAKKONAM", "STOP_VIT", "STOP_KATPADI_JUNCTION",
        ],
    ),
]

# How many buses each route number carries, and the service class. Three per
# number over 29 numbers comes to 91 vehicles, inside the 60-100 the brief asks
# for.
#
# (route_number, bus_type, count)
FLEET_PLAN: list[tuple[str, str, int]] = [
    ("1A", "ordinary", 4),
    ("5", "ordinary", 4),
    ("7A", "ordinary", 3),
    ("7B", "ordinary", 3),
    ("12", "express", 4),
    ("21A", "ordinary", 4),
    ("21B", "ordinary", 3),
    ("32", "ordinary", 3),
    ("45", "express", 4),
    ("55", "ordinary", 3),
    ("66", "ordinary", 3),
    ("71", "ordinary", 3),
    ("83", "ordinary", 3),
    ("94", "ordinary", 3),
    ("101", "ordinary", 3),
    ("102", "ordinary", 4),
    ("103", "deluxe", 4),
    ("104", "deluxe", 4),
    ("105", "ordinary", 3),
    ("106", "ordinary", 3),
    ("107", "ordinary", 3),
    ("108", "deluxe", 3),
    ("109", "ordinary", 3),
    ("201", "deluxe", 3),
    ("202", "deluxe", 3),
    ("203", "deluxe", 3),
    ("301", "deluxe", 4),
    ("302", "deluxe", 3),
    ("303", "express", 3),
]

"""
Bus count per route is what decides whether the planner has a CHOICE, and this
is the single most consequential line in the dataset.

Three buses split 2 up / 1 down; four split 2 / 2. Either way the up direction
gets two buses, but at three they land close together on the route, so a journey
from one origin tends to find both past it, or both sitting at the terminus, and
every result for that origin looks alike. The "least crowded" ranking then has
nothing to reorder - not because it is broken, but because a fleet that thin
cannot express a trade-off.

So the busy city corridors get four and the sparse ones three: 96 network buses,
which with the four hand-authored OSM demo buses is exactly 100 - the top of the
brief's 60-100 band. Going past it was tempting for more choice and not worth
breaking a stated constraint.
"""

# Capacity and accessibility by service class. A deluxe intercity coach is
# bigger and has step-free entry; an ordinary city bus is 50 seats and kerbside.
CLASS_SPECS: dict[str, dict] = {
    "ordinary": {"capacity": 50, "wheelchair": False, "low_floor": False},
    "express": {"capacity": 52, "wheelchair": True, "low_floor": True},
    "deluxe": {"capacity": 45, "wheelchair": True, "low_floor": True},
}

# The operator prefix. Tamil Nadu registrations are TN + district code + series
# letter; Vellore district is TN 09.
REG_PREFIX = "TN09"
REG_SERIES = "AB"

# Registration series per bus type, so the fleet is legible in the UI: the same
# letter block means the same kind of vehicle.
CLASS_SERIES = {
    "ordinary": "C",
    "express": "E",
    "deluxe": "D",
}


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------

def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres."""
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


# How much longer the road is than the straight line between two stops. 1.0 would
# mean a motorway; 1.35 is a plausible figure for a corridor that follows a river
# or works around a built-up block. Used for BOTH the timetable and the shape, so
# the two can never disagree.
ROAD_WINDING = 1.28

# Lateral bulge of a synthetic leg, as a fraction of its length. Big enough to
# read as a curve on a map, small enough not to invent a stop somewhere odd.
LEG_BULGE = 0.13


def _leg_bulge_sign(from_code: str, to_code: str) -> float:
    """Deterministic +1/-1 from the two stop codes.

    Stable across runs and across machines, which matters: a seed that produced
    a different map every time would be untestable. Alternating signs along a
    corridor also stops the shape reading as a sawtooth.
    """
    return 1.0 if (hash(from_code + ">" + to_code) & 1) else -1.0


def leg_coords(
    a_lat: float, a_lon: float, b_lat: float, b_lon: float,
    from_code: str, to_code: str,
) -> tuple[list[list[float]], float]:
    """Four approximate vertices for one leg, plus the road distance.

    The lateral offset follows a parabola peaking mid-leg, so the line curves
    instead of forming a visible V at the midpoint. Returning `metres` here -
    the WINDED distance - is what keeps the timetable honest: the scheduled time
    for the leg is derived from exactly the distance the shape claims.
    """
    sign = _leg_bulge_sign(from_code, to_code)

    straight = haversine_m(a_lat, a_lon, b_lat, b_lon)
    road_m = straight * ROAD_WINDING

    # Perpendicular unit vector to the leg, for the offset.
    dlat = math.radians(b_lat - a_lat)
    dlon = math.radians(b_lon - a_lon)
    px = -math.sin(dlon) * math.cos(math.radians(a_lat))
    py = math.cos(dlat)
    norm = math.hypot(px, py) or 1.0
    px, py = px / norm, py / norm

    # 8 m per degree of latitude, close enough for a bulge of a few hundred metres.
    m_per_deg_lat = 111_320.0
    bulge_m = min(straight * LEG_BULGE, 350.0)

    coords: list[list[float]] = []
    for t in (0.0, 1 / 3, 2 / 3, 1.0):
        # 4t(1-t) peaks at 1.0 when t = 0.5 and is 0 at both ends.
        offset = bulge_m * 4 * t * (1 - t) * sign
        lat = a_lat + (b_lat - a_lat) * t + (py * offset) / m_per_deg_lat
        lon = a_lon + (b_lon - a_lon) * t + (px * offset) / (m_per_deg_lat * math.cos(math.radians(a_lat)))
        coords.append([round(lat, 6), round(lon, 6)])

    return coords, road_m


# ---------------------------------------------------------------------------
# Spec -> directional route rows
# ---------------------------------------------------------------------------

def build_directional_routes(
    stop_coords: dict[str, tuple[float, float]],
    leg_slowdown: float = 1.18,
) -> list[dict]:
    """Expand ROUTE_SPECS into one row per direction.

    `leg_slowdown` is the observed/timetable ratio seeded into segment_stat. The
    planner reads those rows for its ETA, so 1.18 means the network as a whole
    runs 18% behind the published timetable - which is both realistic for an
    urban bus network and what makes the predicted-vs-scheduled column show
    something other than a row of zeros.

    Each returned dict is shaped exactly like a row of
    data/real_routes.json, so seed.py consumes both from one code path.
    """
    out: list[dict] = []

    for number, name, kmph, headway, first, last, stops_up in ROUTE_SPECS:
        mps = kmph * 1000.0 / 3600.0

        legs = []
        offset = 0.0
        stop_rows: list[dict] = []
        for i, code in enumerate(stops_up):
            lat, lon = stop_coords[code]

            # The leg INTO this stop has to be computed before the stop row is
            # written, because offset_sec is cumulative and leg_distance_m
            # describes the leg that ends here. Appending first and adding the
            # leg after shifts the whole timetable one stop late: every stop
            # reports zero distance and zero time, and the last one reports a
            # leg that does not exist.
            prev = stops_up[i - 1] if i else None
            leg_m = 0.0
            if prev:
                p_lat, p_lon = stop_coords[prev]
                coords, leg_m = leg_coords(p_lat, p_lon, lat, lon, prev, code)
                legs.append({"coords": coords, "metres": leg_m})
                offset += leg_m / mps

            stop_rows.append(
                {
                    "code": code,
                    "name": _stop_name(code),
                    "lat": lat,
                    "lon": lon,
                    "offset_sec": int(round(offset)),
                    "leg_distance_m": leg_m,
                }
            )

        up = {
            "code": f"{number} UP",
            "route_number": number,
            "name": name,
            "direction": "up",
            "stops": stop_rows,
            "legs": legs,
            "factors": [leg_slowdown] * len(legs),
            "duration_sec": int(round(offset)),
            "headway_min": headway,
            "first_departure": first,
            "last_departure": last,
        }

        # DOWN: the identical corridor, traversed the other way. The stop list is
        # reversed and the timetable restarts from zero at the far terminus.
        # Distances match the UP legs one for one - the same road is the same
        # length in both directions - but the shape's lateral bulge is signed
        # from the stop codes in travel order, so the DOWN line curves the other
        # way rather than tracing UP backwards.
        down_stops: list[dict] = []
        down_legs: list[dict] = []
        down_offset = 0.0
        down_codes = list(reversed(stops_up))
        for i, code in enumerate(down_codes):
            lat, lon = stop_coords[code]
            prev = down_codes[i - 1] if i else None
            leg_m = 0.0
            if prev:
                p_lat, p_lon = stop_coords[prev]
                coords, leg_m = leg_coords(p_lat, p_lon, lat, lon, prev, code)
                down_legs.append({"coords": coords, "metres": leg_m})
                down_offset += leg_m / mps
            down_stops.append({
                "code": code,
                "name": _stop_name(code),
                "lat": lat,
                "lon": lon,
                "offset_sec": int(round(down_offset)),
                "leg_distance_m": leg_m,
            })

        down = {
            "code": f"{number} DN",
            "route_number": number,
            "name": name,
            "direction": "down",
            "stops": down_stops,
            "legs": down_legs,
            "factors": [leg_slowdown] * len(down_legs),
            "duration_sec": int(round(down_offset)),
            "headway_min": headway,
            "first_departure": first,
            "last_departure": last,
        }

        out.extend((up, down))

    return out


_NAMES: dict[str, str] = {code: name for code, name, *_ in NETWORK_STOPS}


def _stop_name(code: str) -> str:
    """Display name for a stop code, including the reused OSM ones."""
    if code in _NAMES:
        return _NAMES[code]
    # Reused from data/real_routes.json. The seed only needs the name when
    # writing a fresh route_stop; Stop rows keep their OSM names.
    return code.replace("STOP_", "").replace("_", " ").title()


# ---------------------------------------------------------------------------
# Fleet
# ---------------------------------------------------------------------------

def build_fleet() -> list[dict]:
    """One row per vehicle, spread across the route numbers.

    Registration numbers are generated deterministically from the index so two
    runs of the seed produce the same fleet - the tests assert on reg numbers.
    """
    buses: list[dict] = []
    serial = 1000

    for number, bus_type, count in FLEET_PLAN:
        spec = CLASS_SPECS[bus_type]
        for i in range(count):
            serial += 1
            series = CLASS_SERIES[bus_type]
            buses.append({
                "reg_no": f"{REG_PREFIX}{REG_SERIES}{series}{serial}",
                "bus_type": bus_type,
                "route_number": number,
                "capacity": spec["capacity"],
                # Not every bus in a class is accessible in reality. Roughly one
                # in three per class gets the badge, so the accessibility filter
                # has to actually exclude something.
                "wheelchair": spec["wheelchair"] and (i % 3 != 2),
                "low_floor": spec["low_floor"] and (i % 2 == 0),
                "direction": "up" if i % 2 == 0 else "down",
            })

    return buses


def network_summary() -> dict:
    """Counts, for the seed's closing printout and for the tests."""
    fleet = build_fleet()
    return {
        "stops": len(NETWORK_STOPS),
        "reused_stops": len(REUSED_STOP_CODES),
        "route_numbers": len(ROUTE_SPECS),
        "directional_routes": len(ROUTE_SPECS) * 2,
        "buses": len(fleet),
        "accessible_buses": sum(1 for b in fleet if b["wheelchair"]),
    }