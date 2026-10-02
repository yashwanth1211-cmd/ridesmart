from fastapi import APIRouter, HTTPException

from database.schemas.planning import (
    RoutePlanRequest,
    RoutePlanResponse,
)


router = APIRouter(
    prefix="/routes",
    tags=["Route Planning"],
)


@router.post("/plan", response_model=RoutePlanResponse)
def plan_route(request: RoutePlanRequest):

    if not request.origin.strip():
        raise HTTPException(
            status_code=400,
            detail="Origin cannot be empty",
        )

    if not request.destination.strip():
        raise HTTPException(
            status_code=400,
            detail="Destination cannot be empty",
        )

    return {
        "candidates": [
            {
                "route_id": "21A",
                "eta_min": 18,
                "eta_predicted_min": 20,
                "delay_min": 2,
                "crowding_level": "medium",
                "crowding_reason": "Moderate passenger demand",
                "path_stops": [
                    "Central Station",
                    "City Market",
                    "Airport",
                ],
            },
            {
                "route_id": "7A",
                "eta_min": 25,
                "eta_predicted_min": 27,
                "delay_min": 2,
                "crowding_level": "low",
                "crowding_reason": "Low passenger demand",
                "path_stops": [
                    "Central Station",
                    "Railway Station",
                    "Airport",
                ],
            },
        ]
    }