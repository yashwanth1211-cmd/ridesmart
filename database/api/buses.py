from fastapi import APIRouter, HTTPException

from database.schemas.bus import BusActive, BusLocation


router = APIRouter(
    prefix="/buses",
    tags=["Buses"],
)


ACTIVE_BUSES = [
    {
        "bus_id": "BUS101",
        "route_id": "21A",
        "latitude": 12.9716,
        "longitude": 77.5946,
        "speed": 32.5,
        "crowding_level": "medium",
    },
    {
        "bus_id": "BUS102",
        "route_id": "7A",
        "latitude": 12.9750,
        "longitude": 77.6000,
        "speed": 25.0,
        "crowding_level": "low",
    },
]


@router.get("/active", response_model=list[BusActive])
def get_active_buses():
    return ACTIVE_BUSES


@router.get("/{bus_id}/location", response_model=BusLocation)
def get_bus_location(bus_id: str):

    for bus in ACTIVE_BUSES:
        if bus["bus_id"] == bus_id:
            return bus

    raise HTTPException(
        status_code=404,
        detail=f"Bus {bus_id} not found",
    )