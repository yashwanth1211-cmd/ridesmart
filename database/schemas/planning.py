from pydantic import BaseModel


class RoutePlanRequest(BaseModel):
    origin: str
    destination: str


class RouteCandidate(BaseModel):
    route_id: str
    eta_min: int
    eta_predicted_min: int
    delay_min: int
    crowding_level: str
    crowding_reason: str
    path_stops: list[str]


class RoutePlanResponse(BaseModel):
    candidates: list[RouteCandidate]