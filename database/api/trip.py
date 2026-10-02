from fastapi import APIRouter, HTTPException

from database.schemas.trip import TripETA, CrowdUpdate


router = APIRouter(
    prefix="/trips",
    tags=["Trips"],
)


TRIPS = {
    "TRIP101": {
        "trip_id": "TRIP101",
        "eta_min": 15,
        "eta_predicted_min": 17,
        "delay_min": 2,
        "passenger_count": 35,
    },
    "TRIP102": {
        "trip_id": "TRIP102",
        "eta_min": 22,
        "eta_predicted_min": 24,
        "delay_min": 2,
        "passenger_count": 20,
    },
}


@router.get("/{trip_id}/eta", response_model=TripETA)
def get_trip_eta(trip_id: str):

    if trip_id not in TRIPS:
        raise HTTPException(
            status_code=404,
            detail=f"Trip {trip_id} not found",
        )

    return TRIPS[trip_id]


@router.put("/{trip_id}/crowd")
def update_trip_crowd(trip_id: str, crowd: CrowdUpdate):

    if trip_id not in TRIPS:
        raise HTTPException(
            status_code=404,
            detail=f"Trip {trip_id} not found",
        )

    TRIPS[trip_id]["passenger_count"] = crowd.passenger_count

    return {
        "trip_id": trip_id,
        "passenger_count": crowd.passenger_count,
        "message": "Crowd updated successfully",
    }