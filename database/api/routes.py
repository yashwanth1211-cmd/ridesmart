"""Route and stop endpoints.

OWNER: Member 5 (integration). Replaces Member 2's hardcoded ROUTES list.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database.core.database import get_db
from database.core.errors import ApiError
from database.schemas.route import (
    Route,
    RouteShape,
    RouteStop,
    RouteWithStops,
    Stop,
)
from database.services.tracking import all_stops
from simulation_ml.db.models import Route as RouteModel

router = APIRouter(prefix="/routes", tags=["Routes"])


@router.get("", response_model=list[Route])
def list_routes(db: Session = Depends(get_db)):
    return [r.as_dict() for r in db.query(RouteModel).order_by(RouteModel.id).all()]


@router.get("/{route_id}", response_model=RouteWithStops)
def get_route(route_id: int, db: Session = Depends(get_db)):
    route = db.get(RouteModel, route_id)
    if route is None:
        raise ApiError(status_code=404, detail=f"Route {route_id} not found", code="route_not_found")

    payload = route.as_dict()
    payload["stops"] = [rs.as_dict() for rs in route.ordered_stops()]
    return payload


@router.get("/{route_id}/stops", response_model=list[RouteStop])
def get_route_stops(route_id: int, db: Session = Depends(get_db)):
    route = db.get(RouteModel, route_id)
    if route is None:
        raise ApiError(status_code=404, detail=f"Route {route_id} not found", code="route_not_found")

    return [rs.as_dict() for rs in route.ordered_stops()]


@router.get("/{route_id}/shape", response_model=RouteShape)
def get_route_shape(route_id: int, db: Session = Depends(get_db)):
    """The real road polyline for a route, in travel order.

    The map draws this and the simulator walks it, so both agree on where the
    bus is. Without it the map joins stop coordinates with straight lines that
    cut across whatever is in between.
    """
    route = db.get(RouteModel, route_id)
    if route is None:
        raise ApiError(status_code=404, detail=f"Route {route_id} not found", code="route_not_found")

    pts = sorted(route.shape_points, key=lambda p: (p.leg, p.seq))
    return {
        "route_id": route.id,
        "code": route.code,
        "total_m": round(pts[-1].cum_m, 1) if pts else 0.0,
        "point_count": len(pts),
        "points": [{"seq": p.seq, "lat": p.lat, "lon": p.lon, "cum_m": p.cum_m} for p in pts],
    }


stops_router = APIRouter(tags=["Stops"])


@stops_router.get("/stops", response_model=list[Stop])
def list_stops(db: Session = Depends(get_db)):
    """All stops, for the planner's from/to pickers."""
    return all_stops(db)
