"""Database session management for the RideSmart API.

OWNER: Member 5 (integration).

Member 1 built a working `get_db()` dependency in `backend/app/database.py`. It
was sound, so the pattern is kept here - only the engine source changed, to
point at the shared `simulation_ml` ORM instead of Member 1's duplicate tables.

There is now ONE schema in this project: `simulation_ml/db/models.py`.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from sqlalchemy.orm import Session, sessionmaker

# Put the repo root on sys.path so `import database.main` / `import simulation_ml`
# work no matter which directory uvicorn or pytest was started from.
# database/core/database.py -> parents[2] is the repo root. (parents[3] pointed one
# level too high, at the folder *containing* the repo, which risks importing a
# stray sibling package that happens to share the name.)
REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from simulation_ml.db.models import (  # noqa: E402
    Base,
    as_utc,
    crowd_level_for,
    get_engine,
    get_sessionmaker,
)

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./ridesmart.db")

engine = get_engine(DATABASE_URL)
SessionLocal = get_sessionmaker(DATABASE_URL)


def get_db():
    """FastAPI dependency yielding a scoped session.

    Yields rather than returns, so the session is always closed even if the
    handler raises.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """Create tables and seed if the database is empty.

    Called once on startup. Without this every endpoint returns an empty list,
    which is exactly the bug that made Member 1's backend look broken.
    """
    Base.metadata.create_all(bind=engine)

    from simulation_ml.seed.seed import seed

    seed(reset=False, url=DATABASE_URL)


__all__ = [
    "Base",
    "Session",
    "SessionLocal",
    "engine",
    "get_db",
    "init_db",
    "as_utc",
    "crowd_level_for",
]
