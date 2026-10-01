from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app import models


router = APIRouter(
    prefix="/stops",
    tags=["Stops"]
)


@router.get("/")
def get_stops(db: Session = Depends(get_db)):
    stops = db.query(models.Stop).all()

    return [
        {
            "stop_id": stop.id,
            "name": stop.name,
            "latitude": stop.latitude,
            "longitude": stop.longitude
        }
        for stop in stops
    ]