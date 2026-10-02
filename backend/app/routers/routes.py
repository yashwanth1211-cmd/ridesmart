from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app import models


router = APIRouter(
    prefix="/routes",
    tags=["Routes"]
)


@router.get("/")
def get_routes(db: Session = Depends(get_db)):
    routes = db.query(models.Route).all()

    return [
        {
            "route_id": route.id,
            "route_number": route.route_number,
            "from": route.start_location,
            "to": route.end_location
        }
        for route in routes
    ]