"""Crowd-aware route planning.

OWNER: Member 5 (integration).

The standout feature. Returns MULTIPLE ranked options, each with a predicted ETA
and a crowd level, so the passenger can weigh speed against comfort.

Returning a single option would defeat the purpose.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database.core.database import get_db
from database.core.errors import ApiError
from database.schemas.planning import PlanRequest, PlanResponse
from database.services.planner import plan_journey

router = APIRouter(prefix="/routes", tags=["Route Planning"])


@router.post("/plan", response_model=PlanResponse)
def plan(request: PlanRequest, db: Session = Depends(get_db)):
    from_code = request.from_.strip()
    to_code = request.to.strip()

    if not from_code or not to_code:
        raise ApiError(
            status_code=400,
            detail="from and to are required",
            code="missing_stops",
        )

    known = _codes(db)
    if from_code not in known or to_code not in known:
        unknown = from_code if from_code not in known else to_code
        raise ApiError(
            status_code=400,
            detail=f"Unknown stop code: {unknown}",
            code="unknown_stop",
        )

    result = plan_journey(
        db,
        from_code=from_code,
        to_code=to_code,
        accessibility_only=request.accessibility_only,
    )

    if result is None:
        # Both stops are real, but nothing connects them.
        raise ApiError(
            status_code=400,
            detail=f"No route connects {from_code} to {to_code}",
            code="no_route",
        )

    return result


def _codes(db: Session) -> set[str]:
    from simulation_ml.db.models import Stop

    return {s.code for s in db.query(Stop).all()}
