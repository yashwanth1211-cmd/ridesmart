from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from database.api.buses import router as buses_router
from database.api.routes import router as routes_router
from database.api.planning import router as planning_router
from database.api.trip import router as trip_router
from database.api.dashboard import router as dashboard_router
from database.api.websocket import router as websocket_router
from database.core.config import settings


app = FastAPI(
    title=settings.APP_NAME,
    description="Smart Public Transportation Backend API",
    version=settings.APP_VERSION,
)


# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Register API routers
app.include_router(buses_router)
app.include_router(routes_router)
app.include_router(planning_router)
app.include_router(trip_router)
app.include_router(dashboard_router)
app.include_router(websocket_router)


@app.get("/")
def root():
    return {
        "message": "RideSmart API is running"
    }


@app.get("/health")
def health():
    return {
        "status": "healthy"
    }