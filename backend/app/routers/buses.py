from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app import models


router = APIRouter(
    prefix="/buses",
    tags=["Buses"]
)


@router.get("/")
def get_buses(db: Session = Depends(get_db)):
    buses = db.query(models.Bus).all()

    return [
        {
            "bus_id": bus.id,
            "bus_number": bus.bus_number,
            "latitude": bus.latitude,
            "longitude": bus.longitude,
            "speed": bus.speed,
            "passenger_count": bus.passenger_count,
            "capacity": bus.capacity,
            "accessible": bus.accessible
        }
        for bus in buses
    ]


@router.get("/{bus_id}/eta")
def get_bus_eta(bus_id: int, db: Session = Depends(get_db)):
    bus = db.query(models.Bus).filter(models.Bus.id == bus_id).first()

    if not bus:
        return {
            "error": "Bus not found"
        }

    if bus.speed and bus.speed > 0:
        eta = round(10 + (30 / bus.speed), 1)
    else:
        eta = 15

    return {
        "bus_id": bus.id,
        "bus_number": bus.bus_number,
        "eta_minutes": eta
    }


@router.get("/{bus_id}/crowd")
def get_bus_crowd(bus_id: int, db: Session = Depends(get_db)):
    bus = db.query(models.Bus).filter(models.Bus.id == bus_id).first()

    if not bus:
        return {
            "error": "Bus not found"
        }

    percentage = (bus.passenger_count / bus.capacity) * 100

    if percentage < 40:
        crowd = "LOW"
    elif percentage < 80:
        crowd = "MEDIUM"
    else:
        crowd = "HIGH"

    return {
        "bus_id": bus.id,
        "bus_number": bus.bus_number,
        "passenger_count": bus.passenger_count,
        "capacity": bus.capacity,
        "occupancy_percent": round(percentage, 1),
        "crowd": crowd
    }