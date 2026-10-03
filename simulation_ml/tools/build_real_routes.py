"""
Author the real Vellore-Katpadi route data.

Queries Overpass for real bus stops, snaps them to landmarks, then asks OSRM for
the real drivable road geometry between consecutive stops. Writes
simulation_ml/data/real_routes.json, which is committed so nothing in the app
depends on Overpass or OSRM at runtime.

Re-run only when the route layout changes:  python simulation_ml/tools/build_real_routes.py

THE CORRIDOR
------------
Vellore town and Katpadi are ~7 km apart, not the ~30 km that a naive reading of
"Katpadi" suggests. The network runs north-east to south-west down one arterial:

    Kingston Engineering College   13.01236, 79.13409   campus anchor, see CAMPUS
    VIT                          12.96814, 79.15625
    Katpadi Junction bus stand   12.96626, 79.13749
    TNEB                         12.95659, 79.14179
    Vellore (city centre)        12.90718, 79.13097
    Vellore Old Bus Stand        12.92215, 79.13252

Every route below runs along that spine, which is why the demo journey (VIT ->
Vellore Old Bus Stand) is shared by all three and the planner can offer a
genuine choice. `*` in the build log marks a campus anchor rather than a
surveyed transit stop.
"""
import json
import math
import os
import time
import urllib.parse
import urllib.request

UA = "RideSmart-dev/1.0 (authoring real route geometry)"

# Anchor coordinates are the OSM coordinates of the landmark itself; the stop
# NAME is re-read from OSM at build time so a retag upstream is picked up.
LANDMARKS = {
    "VIT": (12.96814, 79.15625),
    "KATPADI_JUNCTION": (12.96626, 79.13749),
    "ODAI_PILLAIYAR": (12.95865, 79.13718),
    "TNEB": (12.95659, 79.14179),
    "AUXILIUM": (12.95847, 79.14162),
    "DKM": (12.95012, 79.14139),
    "SILK_MILL": (12.94979, 79.13719),
    "KANGEYANALLUR": (12.94688, 79.13697),
    "NATIONAL_THEATRE": (12.92883, 79.13384),
    "CMC_HOSPITAL": (12.92555, 79.13338),
    "VELLORE_OLD_BUS_STAND": (12.92215, 79.13252),
    "VELLORE_TOWN": (12.92309, 79.12495),
    "VELLORE_CANTONMENT": (12.91065, 79.12785),
    "RAJA_THEATRE": (12.91489, 79.13266),
    "VELAPPADI": (12.90531, 79.13578),
    "LAKSHMI_THEATRE": (12.90300, 79.13167),
    "SANKARANPALAYAM": (12.90161, 79.13529),
    "TOLLGATE": (12.89966, 79.13110),
    "AGARAVARAM": (12.88989, 79.13575),
    "OTTERI": (12.88478, 79.13574),
    "BAGAYAM": (12.88009, 79.13471),
    "CMC_CAMPUS": (12.87922, 79.13001),
}

# Campus anchors. These are places a bus genuinely terminates at, but OSM has no
# transit node for them, so there is nothing to snap to. Each entry is the OSM
# key of the real feature; the generator looks it up by name and uses its actual
# coordinates, then records kind="campus" so nothing downstream claims it is a
# surveyed bus bay.
#
# Kingston Engineering College is the case in point: OSM maps the college on
# Chitoor main road (13.012, 79.134) but the nearest named bus stop is 4.2 km
# away at Palloor. Snapping to Palloor would put the pin in the wrong place.
CAMPUS = {
    "KINGSTON_COLLEGE": "KINGSTON ENGINEERING COLLEGE",
}

# Comfortably contains every landmark above: lat 12.878-13.013, lon 79.124-79.157.
BBOX = "12.86,79.10,13.06,79.20"

# Codes, names and stop order are ours; coordinates and stop names are real.
# The per-route speed / crowding contrast is deliberate - it is the demo's story.
ROUTES = [
    {
        "code": "V1",
        "name": "Kingston - Bagayam",
        "crowd_bias": "medium",
        "stops": [
            "KINGSTON_COLLEGE", "VIT", "KATPADI_JUNCTION", "TNEB",
            "ODAI_PILLAIYAR", "SILK_MILL", "CMC_HOSPITAL",
            "VELLORE_OLD_BUS_STAND", "VELLORE_TOWN", "VELLORE_CANTONMENT",
            "RAJA_THEATRE", "TOLLGATE", "BAGAYAM",
        ],
    },
    {
        "code": "V2",
        "name": "Kingston - Otteri",
        "crowd_bias": "low",
        "stops": [
            "KINGSTON_COLLEGE", "VIT", "KATPADI_JUNCTION", "TNEB", "AUXILIUM",
            "DKM", "KANGEYANALLUR", "CMC_HOSPITAL", "VELLORE_OLD_BUS_STAND",
            "LAKSHMI_THEATRE", "AGARAVARAM", "OTTERI",
        ],
    },
    {
        "code": "M1",
        "name": "Kingston - Christian Medical College",
        "crowd_bias": "high",
        "stops": [
            "KINGSTON_COLLEGE", "VIT", "KATPADI_JUNCTION", "TNEB",
            "ODAI_PILLAIYAR", "SILK_MILL", "NATIONAL_THEATRE",
            "VELLORE_OLD_BUS_STAND", "VELLORE_TOWN", "VELLORE_CANTONMENT",
            "RAJA_THEATRE", "VELAPPADI", "SANKARANPALAYAM", "OTTERI",
            "CMC_CAMPUS",
        ],
    },
]


def overpass(query):
    data = urllib.parse.urlencode({"data": query}).encode()
    req = urllib.request.Request(
        "https://overpass-api.de/api/interpreter", data=data, headers={"User-Agent": UA}
    )
    with urllib.request.urlopen(req, timeout=240) as r:
        return json.load(r)


def km(a, b):
    R = 6371.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = math.radians(b[0] - a[0]), math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def osrm_leg(a, b):
    """Real driving geometry between two OSM points. coords are [lon, lat]."""
    url = (
        "https://router.project-osrm.org/route/v1/driving/"
        f"{a['lon']},{a['lat']};{b['lon']},{b['lat']}"
        "?overview=full&geometries=geojson"
    )
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.load(r)
    route = data["routes"][0]
    return route["geometry"]["coordinates"], route["distance"]


def simplify(points, tol_m=4.0):
    """Ramer-Douglas-Peucker, so the committed JSON stays small.

    The perpendicular distance below is computed on raw lat/lon, which are
    DEGREES. Passing a metre tolerance straight in would be catastrophic: 4.0
    degrees is about 444 km, so every polyline collapses to its two endpoints
    and the "real road geometry" silently degenerates into a straight line.
    Convert metres to degrees first.
    """
    if len(points) < 3:
        return points

    tol = tol_m / 111_320.0  # metres -> degrees of latitude

    def perp(p, a, b):
        (x, y), (x1, y1), (x2, y2) = p, a, b
        dx, dy = x2 - x1, y2 - y1
        if dx == 0 and dy == 0:
            return math.hypot(x - x1, y - y1)
        t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
        return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))

    def rdp(pts):
        dmax, idx = 0.0, 0
        for i in range(1, len(pts) - 1):
            d = perp(pts[i], pts[0], pts[-1])
            if d > dmax:
                dmax, idx = d, i
        if dmax > tol:
            return rdp(pts[: idx + 1])[:-1] + rdp(pts[idx:])
        return [pts[0], pts[-1]]

    return rdp(points)


print(f"Overpass: transit stops in {BBOX} (Vellore-Katpadi)")
res = overpass(
    "[out:json][timeout:240];("
    f'node["highway"="bus_stop"]({BBOX});'
    f'node["amenity"="bus_station"]({BBOX});'
    f'node["railway"~"^(station|halt)$"]({BBOX});'
    ");out body;"
)
nodes = [n for n in res["elements"] if n.get("tags", {}).get("name")]
print(f"  {len(nodes)} named transit points")

# Refuse to guess: an anchor whose nearest OSM node is implausibly far away means
# the landmark was renamed, moved, or the bbox no longer covers it.
MAX_SNAP_KM = 1.5
stops = {}
for key, anchor in LANDMARKS.items():
    best = min(nodes, key=lambda n: km(anchor, (n["lat"], n["lon"])))
    d = km(anchor, (best["lat"], best["lon"]))
    if d > MAX_SNAP_KM:
        raise SystemExit(
            f"{key}: nearest named OSM node is {d:.2f} km from the anchor "
            f"({best['tags']['name']!r}). The landmark probably moved - update "
            f"LANDMARKS/BBOX before re-running."
        )
    stops[key] = {
        "code": f"STOP_{key}",
        "name": best["tags"]["name"],
        "lat": round(best["lat"], 6),
        "lon": round(best["lon"], 6),
        "kind": "transit",
    }

# Campus anchors: look the real OSM feature up by name and use its own
# coordinates. There is no transit node to snap to, which is exactly why these
# are tracked separately.
print(f"\nresolving {len(CAMPUS)} campus anchor(s)")
for key, osm_name in CAMPUS.items():
    res = overpass(
        f'[out:json][timeout:240];nwr["name"="{osm_name}"]({BBOX});out center;'
    )
    hits = res.get("elements", [])
    if not hits:
        raise SystemExit(
            f"{key}: no OSM feature named {osm_name!r} in {BBOX}. If it was "
            f"renamed or moved, update CAMPUS/BBOX - do not fall back to a "
            f"guessed coordinate."
        )
    if len(hits) > 1:
        print(f"  note: {len(hits)} features named {osm_name!r}, using the first")
    el = hits[0]
    lat = el.get("lat") or el.get("center", {}).get("lat")
    lon = el.get("lon") or el.get("center", {}).get("lon")
    stops[key] = {
        "code": f"STOP_{key}",
        "name": el["tags"]["name"],
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "kind": "campus",
    }
    print(f"  {key:<18} {osm_name} @ {lat:.5f},{lon:.5f}  (kind=campus)")

used = {k for r in ROUTES for k in r["stops"]}
n_campus = sum(1 for k in used if stops[k]["kind"] == "campus")
print(f"\nusing {len(used)} stops across {len(ROUTES)} routes "
      f"({n_campus} campus, {len(used) - n_campus} transit)\n")

out_routes = []
for r in ROUTES:
    seq_stops = [stops[k] for k in r["stops"]]
    legs = []
    total_m = 0.0
    for i in range(len(seq_stops) - 1):
        coords, dist = osrm_leg(seq_stops[i], seq_stops[i + 1])
        coords = simplify(coords)
        legs.append({"coords": [[round(c[1], 6), round(c[0], 6)] for c in coords], "metres": round(dist, 1)})
        total_m += dist
        flag = lambda st: "*" if st["kind"] == "campus" else " "
        print(f"  {r['code']}  {seq_stops[i]['name'][:24]:<24}{flag(seq_stops[i])} -> {seq_stops[i+1]['name'][:24]:<24}{flag(seq_stops[i+1])} {dist/1000:5.2f} km  ({len(coords)} pts)")
        time.sleep(1.1)  # be polite to the public OSRM demo server
    out_routes.append({
        "code": r["code"],
        "name": r["name"],
        "crowd_bias": r["crowd_bias"],
        "stops": seq_stops,
        "legs": legs,
        "total_metres": round(total_m, 1),
    })
    print(f"  {r['code']}  TOTAL {total_m/1000:.2f} km\n")

dest = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "real_routes.json")
os.makedirs(os.path.dirname(dest), exist_ok=True)
with open(dest, "w", encoding="utf-8") as fh:
    json.dump(
        {
            "source": "OpenStreetMap via Overpass API; road geometry via OSRM",
            "region": "Vellore - Katpadi, Tamil Nadu",
            "routes": out_routes,
        },
        fh,
        indent=1,
        ensure_ascii=False,
    )
size = os.path.getsize(dest) / 1024
print(f"wrote {dest} ({size:.0f} KB)")