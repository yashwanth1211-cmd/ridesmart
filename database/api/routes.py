from fastapi import APIRouter, HTTPException

from database.schemas.route import Route, Stop


router = APIRouter(
    prefix="/routes",
    tags=["Routes"],
)


ROUTES = [
    {
        "route_id": "21A",
        "name": "Central Station - Airport",
        "stops": [
            {
                "stop_id": "S101",
                "name": "Central Station",
                "latitude": 12.9716,
                "longitude": 77.5946,
            },
            {
                "stop_id": "S102",
                "name": "City Market",
                "latitude": 12.9650,
                "longitude": 77.5900,
            },
            {
                "stop_id": "S103",
                "name": "Airport",
                "latitude": 13.1986,
                "longitude": 77.7066,
            },
        ],
    },
    {
        "route_id": "7A",
        "name": "Railway Station - Tech Park",
        "stops": [
            {
                "stop_id": "S201",
                "name": "Railway Station",
                "latitude": 12.9750,
                "longitude": 77.6000,
            },
            {
                "stop_id": "S202",
                "name": "Tech Park",
                "latitude": 12.9300,
                "longitude": 77.6800,
            },
        ],
    },
]


@router.get("", response_model=list[Route])
def get_routes():
    return ROUTES


@router.get("/{route_id}", response_model=Route)
def get_route(route_id: str):

    for route in ROUTES:
        if route["route_id"] == route_id:
            return route

    raise HTTPException(
        status_code=404,
        detail=f"Route {route_id} not found",
    )


@router.get("/{route_id}/stops", response_model=list[Stop])
def get_route_stops(route_id: str):

    for route in ROUTES:
        if route["route_id"] == route_id:
            return route["stops"]

    raise HTTPException(
        status_code=404,
        detail=f"Route {route_id} not found",
    )