"""Schemas for live bus positions.

OWNER: Member 5 (integration).

`BusPosition` is what Member 3 draws on the map, so every field it needs is
included: position, heading, speed, which stop is next, and the crowd badge.
"""

from pydantic import BaseModel


class BusPosition(BaseModel):
    bus_id: int
    bus_reg: str
    trip_id: int
    route_id: int
    route_code: str
    lat: float
    lon: float
    heading: float
    speed_kmph: float
    next_stop_name: str | None = None
    crowd_level: str
    crowd_load: int
    capacity: int
    wheelchair_accessible: bool
    low_floor: bool
    ts: str


class PositionIngest(BaseModel):
    """One telemetry tick, as sent by `simulate.py --push`."""

    bus_id: int
    trip_id: int | None = None
    route_id: int | None = None
    lat: float
    lon: float
    speed_kmph: float = 0.0
    heading: float = 0.0
    seq_progress: float = 0.0
    ts: str


class IngestResponse(BaseModel):
    accepted: int
