"""Transport authority dashboard.

OWNER: Member 5 (integration). Replaces Member 2's hardcoded KPI values.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database.core.database import get_db
from database.schemas.dashboard import AuthorityDashboard
from database.services.tracking import dashboard

router = APIRouter(tags=["Authority Dashboard"])


@router.get("/authority/dashboard", response_model=AuthorityDashboard)
def get_dashboard(db: Session = Depends(get_db)):
    """Fleet status, delays, and the highest-demand and most crowded routes."""
    return dashboard(db)
