"""Schemas for the transport authority dashboard.

OWNER: Member 5 (integration).
"""

from pydantic import BaseModel


class RouteKpi(BaseModel):
    route_id: int
    code: str
    active_trips: int
    avg_delay_min: float
    avg_crowd_ratio: float
    demand_score: float


class AuthorityDashboard(BaseModel):
    total_buses: int
    active_buses: int
    delayed_buses: int
    avg_delay_min: float
    high_demand_route: str | None = None
    crowded_route: str | None = None
    routes: list[RouteKpi] = []
