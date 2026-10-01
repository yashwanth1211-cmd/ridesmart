from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app import models


router = APIRouter(
    prefix="/plan",
    tags=["Route Planner"]
)


@router.get("/")
def plan_route(
    from_location: str,
    to_location: str,
    db: Session = Depends(get_db)
):
    routes = db.query(models.Route).all()

    results = []

    for route in routes:
        start_match = from_location.lower() in route.start_location.lower()
        end_match = to_location.lower() in route.end_location.lower()

        if start_match and end_match:

            bus = db.query(models.Bus).filter(
                models.Bus.bus_number == route.route_number
            ).first()

            if bus:
                occupancy = (bus.passenger_count / bus.capacity) * 100

                if occupancy < 40:
                    crowd = "LOW"
                elif occupancy < 80:
                    crowd = "MEDIUM"
                else:
                    crowd = "HIGH"

                if bus.speed and bus.speed > 0:
                    eta = round(10 + (30 / bus.speed), 1)
                else:
                    eta = 15

                results.append(
                    {
                        "route_id": route.id,
                        "route_number": route.route_number,
                        "from": route.start_location,
                        "to": route.end_location,
                        "bus_id": bus.id,
                        "bus_number": bus.bus_number,
                        "eta_minutes": eta,
                        "crowd": crowd,
                        "passenger_count": bus.passenger_count,
                        "capacity": bus.capacity,
                        "accessible": bus.accessible
                    }
                )

    if not results:
        return {
            "message": "No matching routes found",
            "from": from_location,
            "to": to_location,
            "routes": []
        }

    return {
        "from": from_location,
        "to": to_location,
        "routes": results
    }