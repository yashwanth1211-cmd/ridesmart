"""
Author the real Bengaluru route data.

Queries Overpass for real bus stops, snaps them to landmarks, then asks OSRM for
the real drivable road geometry between consecutive stops. Writes
simulation_ml/data/real_routes.json, which is committed so nothing in the app
depends on Overpass or OSRM at runtime.

Re-run only when the route layout changes:  python simulation_ml/tools/build_real_routes.py
"""
import json
import math
import os
import time
import urllib.parse
import urllib.request

UA = "RideSmart-dev/1.0 (authoring real route geometry)"

# Anchor coordinates are well-known public landmarks; the stop NAME and exact
# coordinate always come from OSM.
LANDMARKS = {
    "MAJESTIC": (12.9767, 77.5713),
    "VIDHANA": (12.9794, 77.5910),
    "MG_ROAD": (12.9756, 77.6069),
    "BRIGADE_ROAD": (12.9719, 77.6068),
    "INDIRANAGAR": (12.9784, 77.6408),
    "KORAMANGALA": (12.9352, 77.6245),
    "JAYANAGAR": (12.9250, 77.5938),
    "RAJAJINAGAR": (12.9915, 77.5520),
    "YESHWANTHPUR": (13.0234, 77.5540),
    "MARATHAHALLI": (12.9591, 77.6974),
    "HSR_LAYOUT": (12.9116, 77.6474),
    "ELECTRONIC_CITY": (12.8452, 77.6602),
    "WHITEFIELD": (12.9698, 77.7500),
    "KR_MARKET": (12.9616, 77.5735),
    "TRINITY": (12.9448, 77.6220),
    "BANASHANKARI": (12.9250, 77.5667),
    "MALLESHWARAM": (13.0035, 77.5720),
    "BASAVANAGUDI": (12.9420, 77.5730),
    "NAGASANDRA": (13.0360, 77.5450),
    "HARIHARA": (12.9380, 77.5790),
}

BBOX = "12.83,77.50,13.06,77.78"

# Codes and stop order are ours; coordinates and names are real.
# The crowding contrast per route is deliberate - it is the demo's story.
ROUTES = [
    {
        "code": "21A",
        "name": "Rajajinagar - Electronic City",
        "crowd_bias": "low",
        "stops": [
            "RAJAJINAGAR", "MAJESTIC", "KR_MARKET", "BASAVANAGUDI",
            "BANASHANKARI", "JAYANAGAR", "HSR_LAYOUT", "MARATHAHALLI",
            "ELECTRONIC_CITY",
        ],
    },
    {
        "code": "7B",
        "name": "Yeshwanthpur - Koramangala",
        "crowd_bias": "medium",
        "stops": [
            "YESHWANTHPUR", "MALLESHWARAM", "RAJAJINAGAR", "MAJESTIC",
            "VIDHANA", "MG_ROAD", "BRIGADE_ROAD", "INDIRANAGAR", "KORAMANGALA",
        ],
    },
    {
        "code": "3C",
        "name": "Majestic - Nagasandra",
        "crowd_bias": "high",
        "stops": [
            "MAJESTIC", "KR_MARKET", "HARIHARA", "BANASHANKARI", "JAYANAGAR",
            "TRINITY", "KORAMANGALA", "INDIRANAGAR", "MG_ROAD", "VIDHANA",
            "NAGASANDRA",
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


print(f"Overpass: bus stops in {BBOX}")
res = overpass(f'[out:json][timeout:240];node["highway"="bus_stop"]({BBOX});out body;')
nodes = [n for n in res["elements"] if n.get("tags", {}).get("name")]
print(f"  {len(nodes)} named stops")

stops = {}
for key, anchor in LANDMARKS.items():
    best = min(nodes, key=lambda n: km(anchor, (n["lat"], n["lon"])))
    stops[key] = {
        "code": f"STOP_{key}",
        "name": best["tags"]["name"],
        "lat": round(best["lat"], 6),
        "lon": round(best["lon"], 6),
    }

used = {k for r in ROUTES for k in r["stops"]}
print(f"\nusing {len(used)} stops across {len(ROUTES)} routes\n")

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
        print(f"  {r['code']}  {seq_stops[i]['name'][:26]:<26} -> {seq_stops[i+1]['name'][:26]:<26} {dist/1000:5.2f} km  ({len(coords)} pts)")
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
    json.dump({"source": "OpenStreetMap via Overpass API; road geometry via OSRM", "routes": out_routes}, fh, indent=1)
size = os.path.getsize(dest) / 1024
print(f"wrote {dest} ({size:.0f} KB)")