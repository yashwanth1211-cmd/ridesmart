"""Direction-aware journey search.

OWNER: Member 5.

    GET /api/journey?from_stop_id=8&to_stop_id=21
    GET /api/journey?from_stop_id=8&to_stop_id=21&sort=crowd
    GET /api/journey?from_stop_id=8&to_stop_id=21&accessibility_only=true

WHY THIS EXISTS ALONGSIDE POST /api/routes/plan
-----------------------------------------------
`plan_journey` is the crowd trade-off feature: given two stops it returns every
ROUTE that connects them, so the passenger can choose between fast-and-packed and
slow-and-empty. It is the demo's centrepiece and it stays exactly as it is.

The gap is that a passenger standing at a stop is asking a sharper question:
"which bus do I physically catch, and is it going the right way?" A route list
cannot answer that. It has no bus number, no crowd reading for the specific
vehicle, no arrival time, and it silently includes a corridor served in only one
direction if the database ever holds both.

This endpoint answers the sharper question:

  * direction is enforced per bus, not per corridor - a bus on "21A DN" is a
    different Route row with reversed stops, so it cannot be offered for a
    journey only "21A UP" serves;
  * only buses that are live, or leaving soon, appear at all;
  * each result is one BUS with its number, the stops in between, scheduled and
    predicted arrival, delay, crowd and accessibility;
  * when no single bus connects the two stops, one-transfer options are offered
    and labelled `transfers: 1`.

Stop IDs rather than codes because the frontend already has the numeric ids from
GET /api/stops, and a wrong code is a 404 either way - but an id cannot be a
typo into a different stop, which a code can.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from database.core.database import get_db
from database.core.errors import ApiError
from database.schemas.journey import JourneyResponse
from database.services.journey import (
    SEARCH_HORIZON_MIN,
    find_journeys,
)

router = APIRouter(tags=["Journey Planning"])


@router.get("/journey", response_model=JourneyResponse)
def journey(
    from_stop_id: int = Query(..., ge=1, description="Origin stop id"),
    to_stop_id: int = Query(..., ge=1, description="Destination stop id"),
    sort: str = Query(
        "eta",
        pattern="^(eta|crowd)$",
        description=(
            "'eta' ranks by earliest predicted arrival. 'crowd' ranks by "
            "score = ETA + crowding penalty, i.e. least crowded among the "
            "quick options."
        ),
    ),
    accessibility_only: bool = Query(
        False, description="Only buses with wheelchair access"
    ),
    include_transfers: bool = Query(
        True, description="Offer one-transfer options when no direct bus exists"
    ),
    horizon_min: int = Query(
        SEARCH_HORIZON_MIN,
        ge=5,
        le=360,
        description="How far ahead to look for a scheduled departure",
    ),
    db: Session = Depends(get_db),
):
    result = find_journeys(
        db,
        from_stop_id=from_stop_id,
        to_stop_id=to_stop_id,
        sort=sort,
        accessibility_only=accessibility_only,
        horizon_min=horizon_min,
        include_transfers=include_transfers,
    )

    # Unknown stop is a client error worth a clear code: the UI can tell "you
    # picked a stop that no longer exists" apart from "nothing connects those
    # two", which is a normal empty result and not an error at all.
    if result is None:
        raise ApiError(
            status_code=404,
            detail="Unknown stop id",
            code="stop_not_found",
        )

    return result