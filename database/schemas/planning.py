"""Schemas for the crowd-aware route planner.

OWNER: Member 5 (integration).

`PlanOption` is the single most important object in the project. It is the whole
reason RideSmart exists: the passenger sees MULTIPLE routes, each with an ETA
and a crowd level, and chooses the trade-off.

Returning one option would defeat the feature. `test_plan_returns_at_least_two_
options` guards against exactly that regression.
"""

from pydantic import BaseModel, Field

from database.schemas.route import Stop


class PlanRequest(BaseModel):
    from_: str = Field(alias="from")
    to: str
    accessibility_only: bool = False

    model_config = {"populate_by_name": True}


class PlanStop(BaseModel):
    stop_id: int
    name: str
    eta_min: int
    accessible: bool


class PlanOption(BaseModel):
    """One candidate route, ranked and scored."""

    route_id: int
    code: str
    name: str
    eta_min: int
    eta_scheduled_min: int
    eta_predicted_min: int
    delay_min: int
    crowd_level: str
    crowd_load: int
    capacity: int
    crowd_ratio: float
    wheelchair_accessible: bool
    low_floor: bool
    score: float
    stops: list[PlanStop]


class PlanResponse(BaseModel):
    from_: Stop = Field(alias="from")
    to: Stop
    generated_at: str
    options: list[PlanOption]

    model_config = {"populate_by_name": True}
