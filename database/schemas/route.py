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
