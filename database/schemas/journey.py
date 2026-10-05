"""Schemas for GET /api/journey.

OWNER: Member 5.

Every field here maps to one item in the brief's requirement 3, which is worth
spelling out because it is why this is a separate schema rather than a reuse of
PlanOption: PlanOption describes a ROUTE, this describes a BUS carrying a
passenger between two specific stops.

    requirement                    field
    ---------------------------    -----------------------------
    bus number                     bus_reg, bus_id
    route name                     route_name, route_number, route_code
    the stops between From and To  stops[] (from_seq .. to_seq, travel order)
    scheduled arrival              scheduled_arrival
    predicted arrival              predicted_arrival
    delay                          delay_min
    crowd level                    crowd_level, crowd_load, crowd_ratio
    accessibility                  wheelchair_accessible, low_floor
    estimated journey time         journey_min

`sort` is echoed back so the UI can label the ranking it is actually showing
instead of hard-coding "sorted by ETA" next to a least-crowded list.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from database.schemas.route import Stop


class JourneyStop(BaseModel):
    """One stop on the requested slice of the route, in travel order."""

    stop_id: int
    stop_code: str
    name: str
    seq: int
    scheduled_offset_sec: int
    eta_min: int
    accessible: bool


class JourneyOption(BaseModel):
    """One BUS that can carry the passenger from `from` to `to` directly.

    TWO arrival times, deliberately not collapsed into one:

        arrives_in_min   minutes until the bus reaches the BOARDING point.
                         This is what a passenger standing at the stop is
                         waiting on, so it is what the ranking sorts by.
        eta_min          minutes until it reaches the DESTINATION.

    Reporting only one of these forces the UI to guess which a label like
    "arriving in 0 min" means, and it picked the wrong one - a bus sitting at
    the boarding stop became "arriving in 0 min" while being forty minutes from
    where the passenger was going.
    """

    option_id: str
    transfers: int = 0
    kind: str = Field(description="'live' | 'scheduled'")
    route_id: int
    route_number: str
    route_code: str
    route_name: str
    direction: str
    bus_id: int | None = None
    bus_reg: str | None = None
    bus_type: str | None = None
    capacity: int | None = None
    wheelchair_accessible: bool | None = None
    low_floor: bool | None = None
    from_stop_id: int | None = None
    to_stop_id: int | None = None
    stops: list[JourneyStop]
    arrives_in_min: int = Field(description="Minutes until the bus reaches the origin stop")
    eta_min: int = Field(description="Minutes until the bus reaches the destination stop")
    scheduled_arrival: str | None = None
    predicted_arrival: str | None = None
    delay_min: int | None = None
    crowd_level: str | None = None
    crowd_load: int | None = None
    crowd_ratio: float | None = None
    journey_min: int
    score: float | None = None
    departs_at: str | None = None


class JourneyLeg(BaseModel):
    """One vehicle in a multi-leg journey."""

    route_id: int
    route_number: str
    route_code: str
    route_name: str
    direction: str
    bus_id: int | None = None
    bus_reg: str | None = None
    bus_type: str | None = None
    wheelchair_accessible: bool | None = None
    low_floor: bool | None = None
    from_stop_id: int | None = None
    to_stop_id: int | None = None
    stops: list[JourneyStop]
    arrives_in_min: int
    crowd_level: str | None = None
    crowd_load: int | None = None
    capacity: int | None = None


class JourneyWithTransfer(BaseModel):
    """A journey requiring a change, always labelled with `transfers: 1`.

    Separate from JourneyOption rather than a union so a client can render the
    "1 transfer" badge from the type alone, and so the UI cannot accidentally
    read a leg's `stops` as if it were the whole journey's.

    `wait_min` is how long the passenger waits at the interchange AFTER the
    first leg arrives there - walking to the right bay included. Without it the
    UI would show a one-transfer option whose two legs overlap, which reads as a
    bug even though the arithmetic is defensible.
    """

    transfers: int = 1
    legs: list[JourneyLeg]
    transfer_stop: Stop
    wait_min: int
    total_min: int


class JourneyResponse(BaseModel):
    from_: Stop = Field(alias="from")
    to: Stop
    sort: str
    generated_at: str
    direct: list[JourneyOption]
    transfers: list[JourneyWithTransfer]
    message: str | None = Field(
        default=None,
        description="User-facing reason the list is empty; None when options exist",
    )

    model_config = {"populate_by_name": True}