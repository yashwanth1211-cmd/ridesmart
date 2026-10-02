"""Route and stop endpoints.

OWNER: Member 5 (integration). Replaces Member 2's hardcoded ROUTES list.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database.core.database import get_db
from database.schemas.route import Route, RouteStop, RouteWithStops, Stop
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
        raise HTTPException(status_code=404, detail=f"Route {route_id} not found")

    payload = route.as_dict()
    payload["stops"] = [rs.as_dict() for rs in route.ordered_stops()]
    return payload


@router.get("/{route_id}/stops", response_model=list[RouteStop])
def get_route_stops(route_id: int, db: Session = Depends(get_db)):
    route = db.get(RouteModel, route_id)
    if route is None:
        raise HTTPException(status_code=404, detail=f"Route {route_id} not found")

    return [rs.as_dict() for rs in route.ordered_stops()]


stops_router = APIRouter(tags=["Stops"])


@stops_router.get("/stops", response_model=list[Stop])
def list_stops(db: Session = Depends(get_db)):
    """All stops, for the planner's from/to pickers."""
    return all_stops(db)
