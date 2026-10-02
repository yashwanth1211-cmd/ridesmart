"""Shared pytest fixtures.

OWNER: Member 5.

Every test runs against a THROWAWAY SQLite file, never ridesmart.db, so a test
run can never corrupt demo data.

If Member 2's FastAPI app has not been written yet, the API tests skip instead
of erroring. That keeps `pytest` green from hour one and turns red the moment
the app appears -- which is the signal we want.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from simulation_ml.db import models as m  # noqa: E402


@pytest.fixture()
def temp_db(tmp_path):
    """Fresh empty database for one test."""
    url = f"sqlite:///{(tmp_path / 'test.db').as_posix()}"
    m.reset_database(url)
    yield url
    m.Base.metadata.drop_all(m.get_engine(url))


@pytest.fixture()
def seeded_db(temp_db):
    """Seeded database: 3 routes, 12 stops, 4 buses, 3 active trips."""
    from simulation_ml.seed.seed import seed

    seed(reset=False, url=temp_db)
    return temp_db


@pytest.fixture()
def session(seeded_db):
    Session = m.get_sessionmaker(seeded_db)
    with Session() as s:
        yield s


@pytest.fixture()
def client(seeded_db, monkeypatch):
    """FastAPI TestClient wired to the temporary SQLite database.

    Deliberately does NOT skip when the app is missing. An earlier version
    skipped, which quietly turned 13 broken endpoints into 13 "passing" skips.
    A missing app is a real failure now.
    """
    monkeypatch.setenv("DATABASE_URL", seeded_db)

    # reset the cached engine so the app picks up the temp DB
    m._engine = None
    m._SessionLocal = None

    app = None
    errors = []
    for candidate in ("database.main:app", "database.app:app", "backend.main:app"):
        mod_path, _, attr = candidate.partition(":")
        try:
            module = __import__(mod_path, fromlist=[attr])
            app = getattr(module, attr)
            break
        except Exception as exc:
            errors.append(f"{candidate}: {exc!r}")

    if app is None:
        pytest.fail(
            "could not import the FastAPI app `app`. Tried:\n  "
            + "\n  ".join(errors)
            + "\nExpected database/main.py to expose `app`."
        )

    from fastapi.testclient import TestClient

    with TestClient(app) as c:
        yield c