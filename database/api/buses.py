"""Live bus tracking and telemetry ingest.

OWNER: Member 5 (integration). Replaces Member 2's hardcoded ACTIVE_BUSES list.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database.core.database import get_db
from database.core.errors import ApiError
from database.schemas.bus import BusPosition, IngestResponse, PositionIngest
from database.services.tracking import active_positions, bus_position, ingest_positions

router = APIRouter(prefix="/buses", tags=["Tracking"])


@router.get("/active", response_model=list[BusPosition])
def get_active_buses(db: Session = Depends(get_db)):
    """Latest position of every active bus.

    Frontend polls this every 2 seconds as a fallback if the WebSocket is
    unavailable. The response is [] only when no telemetry has been written yet
    - run the simulator, or call /buses/ingest.
    """
    return active_positions(db)


@router.post("/ingest", response_model=IngestResponse)
def ingest(payload: list[PositionIngest], db: Session = Depends(get_db)):
    """Accept telemetry from `simulate.py --push`.

    The simulator can write to the database directly, or POST here instead,
    which is the easier path when the API owns the database.
    """
    return {"accepted": ingest_positions(db, [p.model_dump() for p in payload])}


@router.get("/{bus_id}/location", response_model=BusPosition)
def get_bus_location(bus_id: int, db: Session = Depends(get_db)):
    position = bus_position(db, bus_id)
    if position is None:
        raise ApiError(status_code=404, detail=f"Bus {bus_id} not found", code="bus_not_found")
    return position
