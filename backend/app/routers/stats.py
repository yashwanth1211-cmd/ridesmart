from fastapi import APIRouter

router = APIRouter(
    prefix="/stats",
    tags=["Dashboard"]
)


@router.get("/")
def get_stats():
    return {
        "total_buses": 84,
        "active_buses": 71,
        "delayed_buses": 12,
        "out_of_service": 1,
        "high_demand_route": "7A",
        "most_crowded_route": "21B"
    }