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
def network_db(temp_db):
    """Seeded database PLUS the synthetic Vellore - Katpadi network.

    Opt-in via `seed(include_network=True)`. The default seed deliberately stays
    at the three hand-authored OSM routes so the counts asserted in test_smoke.py
    keep meaning what they say; anything that needs the wide network (direction
    filtering, transfers, the fleet, service patterns) uses this instead.
    """
    from simulation_ml.seed.seed import seed

    seed(reset=False, url=temp_db, include_network=True)
    return temp_db


@pytest.fixture()
def session(seeded_db):
    Session = m.get_sessionmaker(seeded_db)
    with Session() as s:
        yield s


@pytest.fixture()
def network_session(network_db):
    Session = m.get_sessionmaker(network_db)
    with Session() as s:
        yield s


def _wire_app(db_url, monkeypatch):
    """Point the FastAPI app at `db_url` and return a TestClient.

    Factored out of the fixtures because there are now two seeded databases to
    serve (the curated three-route demo and the full synthetic network), and the
    module-rebinding dance below is the fiddly part - not the seeding.
    """
    monkeypatch.setenv("DATABASE_URL", db_url)

    # reset the cached engine so the app picks up the temp DB
    m._engine = None
    m._SessionLocal = None

    """
    database.core.database binds DATABASE_URL, `engine` and `SessionLocal` at
    IMPORT time (see its module header), so setting the env var only takes
    effect for whichever test happens to import the app first. Python caches
    the module, so every later test silently reused the FIRST test's database
    file instead of its own.

    That went unnoticed because the seeded content is identical in every
    temporary database, so read-only tests could not tell the difference. It
    breaks the moment a test writes: mutating the DB in a test and then
    asserting through the client appeared to do nothing.

    Rebinding the module attributes makes the isolation this fixture's
    docstring already promises actually true.
    """
    import database.core.database as core_db

    stale = {id(core_db.SessionLocal), id(core_db.engine)}

    core_db.DATABASE_URL = db_url
    core_db.engine = m.get_engine(db_url)
    core_db.SessionLocal = m.get_sessionmaker(db_url)

    # `from database.core.database import SessionLocal` snapshots the object at
    # import time, so rebinding the module attribute alone is not enough:
    # database/main.py and database/api/websocket.py each captured the FIRST
    # test's sessionmaker in their own namespace. Repoint every consumer that is
    # still holding the stale one, matched by identity so nothing unrelated is
    # touched.
    fresh = {id(core_db.SessionLocal), id(core_db.engine)}
    for module in list(sys.modules.values()):
        for name in ("SessionLocal", "engine"):
            if id(getattr(module, name, None)) in stale - fresh:
                setattr(module, name, getattr(core_db, name))

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

    return TestClient(app)


@pytest.fixture()
def client(seeded_db, monkeypatch):
    """FastAPI TestClient wired to the temporary SQLite database.

    Deliberately does NOT skip when the app is missing. An earlier version
    skipped, which quietly turned 13 broken endpoints into 13 "passing" skips.
    A missing app is a real failure now.
    """
    with _wire_app(seeded_db, monkeypatch) as c:
        yield c


@pytest.fixture()
def network_client(network_db, monkeypatch):
    """TestClient over the full synthetic network.

    Separate from `client` rather than a parameterised `client` so a test that
    only works against the wide network says so in its own signature, and a
    test that accidentally relies on the wide data fails loudly instead of
    quietly passing on whichever fixture it happened to ask for.
    """
    with _wire_app(network_db, monkeypatch) as c:
        yield c

