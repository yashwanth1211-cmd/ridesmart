"""Schemas for trip ETA and crowd overrides.

OWNER: Member 5 (integration).
"""

from pydantic import BaseModel, Field


class StopEta(BaseModel):
    stop_id: int
    stop_name: str
    scheduled_min: int
    predicted_min: int
    delay_min: int


class CrowdUpdate(BaseModel):
    """Manual crowd override.

    `load` is the contract field name. An optional `passenger_count` alias is
    accepted so Member 1's original endpoint spelling still works.
    """

    load: int | None = None
    capacity: int | None = None
    passenger_count: int | None = None
    stop_id: int | None = Field(default=None)

    def resolved_load(self, default_capacity: int) -> tuple[int, int]:
        load = self.load if self.load is not None else self.passenger_count
        if load is None:
            raise ValueError("load is required")
        return int(load), int(self.capacity or default_capacity)


class CrowdEstimate(BaseModel):
    trip_id: int
    stop_id: int
    load: int
    capacity: int
    ratio: float
    level: str
    ts: str
