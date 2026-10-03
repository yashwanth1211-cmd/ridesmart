"""Schemas for route and stop responses.

OWNER: Member 5 (integration).

Field names follow tests_docs/api_contract.yaml: `lat`/`lon`, not
`latitude`/`longitude`. Member 3 codes against these, so the names matter.
"""

from pydantic import BaseModel


class Stop(BaseModel):
    id: int
    code: str
    name: str
    lat: float
    lon: float
    accessible: bool
    # 'transit' for a stop OSM maps as a real bus stop/station, 'campus' for one
    # anchored at a landmark because no bay was surveyed there.
    kind: str = "transit"


class RouteStop(BaseModel):
    seq: int
    scheduled_offset_sec: int
    stop: Stop


class Route(BaseModel):
    id: int
    code: str
    name: str
    direction: str
    stop_count: int


class RouteWithStops(BaseModel):
    id: int
    code: str
    name: str
    direction: str
    stop_count: int
    stops: list[RouteStop]


class ShapePoint(BaseModel):
    """One vertex of the route's real road polyline."""

    seq: int
    lat: float
    lon: float
    cum_m: float


class RouteShape(BaseModel):
    """The road geometry a bus actually drives.

    Stop coordinates alone are not enough to draw a route: consecutive stops
    can be 2 km apart with a river or a park between them, so a line through
    them is not a drivable path. These vertices come from OSRM and are what the
    map draws and what the simulator walks, so the line on screen is the line
    the bus is on.
    """

    route_id: int
    code: str
    total_m: float
    point_count: int
    points: list[ShapePoint]
