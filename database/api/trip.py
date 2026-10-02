"""Trip ETA and crowd override endpoints.

OWNER: Member 5 (integration). Replaces Member 2's hardcoded TRIPS dict.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database.core.database import get_db
from database.schemas.trip import CrowdEstimate, CrowdUpdate, StopEta
from database.services.planner import set_crowd, trip_etas

router = APIRouter(prefix="/trips", tags=["Trips"])


@router.get("/{trip_id}/eta", response_model=list[StopEta])
def get_eta(trip_id: int, db: Session = Depends(get_db)):
    """Predicted vs scheduled arrival at each stop, from observed travel times."""
    rows = trip_etas(db, trip_id)
    if not rows:
        raise HTTPException(status_code=404, detail=f"Trip {trip_id} not found")
    return rows


@router.put("/{trip_id}/crowd", response_model=CrowdEstimate)
def update_crowd(trip_id: int, payload: CrowdUpdate, db: Session = Depends(get_db)):
    """Manually override a trip's crowd level.

    This is the interactive demo step: set a bus to empty, re-plan the same
    journey, and watch the ranking change.
    """
    from simulation_ml.db.models import Trip

    trip = db.get(Trip, trip_id)
    if trip is None:
        raise HTTPException(status_code=404, detail=f"Trip {trip_id} not found")

    try:
        load, capacity = payload.resolved_load(trip.bus.capacity)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    result = set_crowd(
        db,
        trip_id=trip_id,
        load=load,
        capacity=capacity,
        stop_id=payload.stop_id,
    )
    if not result:
        raise HTTPException(status_code=404, detail=f"Trip {trip_id} not found")

    return result
