"""RideSmart API - single entry point.

OWNER: Member 5 (integration).

This is the ONLY FastAPI app in the project. Member 1's `backend/` and Member
2's `database/` were two independent apps that could not both run; `backend/` is
now retired and its useful logic (the DB dependency pattern, the planner
approach) has been absorbed here.

Start with:
    uvicorn database.main:app --reload
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from database.api.buses import router as buses_router
from database.api.dashboard import router as dashboard_router
from database.api.planning import router as planning_router
from database.api.routes import router as routes_router
from database.api.routes import stops_router
from database.api.trip import router as trip_router
from database.api.websocket import router as websocket_router
from database.core.config import settings
from database.core.database import SessionLocal, init_db
from database.core.errors import ApiError, code_for


@asynccontextmanager
async def lifespan(app: FastAPI):
    # THE fix for the empty-database bug: Member 1 created tables but never
    # populated them, so every endpoint returned []. Seeding here means a fresh
    # clone has demo data on the first request.
    init_db()
    yield


app = FastAPI(
    title=settings.APP_NAME,
    description="Smart Public Transportation Backend API",
    version=settings.APP_VERSION,
    lifespan=lifespan,
)

# ---------------------------------------------------------------------------
# Error shape - see tests_docs/api_contract.yaml `conventions.error_shape`
# Every error response is {"detail": ..., "code": ...}. Registered globally
# rather than per-endpoint so a new route cannot forget `code`.
# ---------------------------------------------------------------------------


@app.exception_handler(ApiError)
async def api_error_handler(request: Request, exc: ApiError):
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail, "code": exc.code},
        headers=getattr(exc, "headers", None),
    )


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(request: Request, exc: StarletteHTTPException):
    """Catches plain HTTPException and the 404s from unmatched paths."""
    detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
    code = getattr(exc, "code", None) or code_for(exc.status_code)
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": detail, "code": code},
        headers=getattr(exc, "headers", None),
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    """Malformed request bodies become 422 with the contract shape.

    FastAPI's default is {"detail": [ ...list of dicts... ]}, which is not a
    string and has no code.
    """
    first = exc.errors()[0] if exc.errors() else {}
    field = ".".join(str(p) for p in first.get("loc", [])[1:]) or "body"
    return JSONResponse(
        status_code=422,
        content={
            "detail": f"{field}: {first.get('msg', 'invalid request')}",
            "code": "validation_error",
        },
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Every endpoint lives under /api, as declared in tests_docs/api_contract.yaml.
# Member 3 codes against these paths, so the prefix is not optional.
app.include_router(routes_router, prefix="/api")
app.include_router(stops_router, prefix="/api")
app.include_router(planning_router, prefix="/api")
app.include_router(buses_router, prefix="/api")
app.include_router(trip_router, prefix="/api")
app.include_router(dashboard_router, prefix="/api")
# websockets live under /api too, so Member 3 connects to ws://host/api/ws/buses
app.include_router(websocket_router, prefix="/api")


@app.get("/")
def root():
    return {"message": "RideSmart API is running", "docs": "/docs"}


@app.get("/api/health")
def health():
    """Liveness plus a database check, so a broken DB is visible immediately.

    Declared with an explicit path rather than mounted via the router, so it
    sits alongside the other /api routes.
    """
    db = SessionLocal()
    try:
        from simulation_ml.db.models import Route

        db.query(Route).count()
        return {
            "status": "ok",
            "database": "ok",
            "time": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as exc:  # pragma: no cover - only on a broken DB
        return {"status": "degraded", "database": f"error: {exc}"}
    finally:
        db.close()
