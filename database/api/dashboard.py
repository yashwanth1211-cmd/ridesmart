from fastapi import APIRouter
from database.schemas.dashboard import AuthorityDashboard

router = APIRouter(
    prefix="/authority",
    tags=["Authority Dashboard"],
)


@router.get("/dashboard", response_model=AuthorityDashboard)
def get_authority_dashboard():
    return {
        "total_buses": 25,
        "active_buses": 18,
        "delayed_buses": 4,
        "high_demand_route": "21A",
        "crowded_route": "21A",
    }