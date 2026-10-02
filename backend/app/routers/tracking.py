from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
import random

from app.database import get_db
from app import models


router = APIRouter(
    prefix="/tracking",
    tags=["Live Tracking"]
)


@router.get("/live")
def get_live_buses(db: Session = Depends(get_db)):

    buses = db.query(models.Bus).all()

    results = []

    for bus in buses:

        bus.latitude += random.uniform(-0.0005, 0.0005)
        bus.longitude += random.uniform(-0.0005, 0.0005)

        results.append(
            {
                "bus_id": bus.id,
                "bus_number": bus.bus_number,
                "latitude": round(bus.latitude, 6),
                "longitude": round(bus.longitude, 6),
                "speed": bus.speed
            }
        )

    db.commit()

    return {
        "live_buses": results
    }