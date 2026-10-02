from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import (
    buses,
    routes,
    stops,
    planner,
    stats,
    tracking
)

from app.database import engine
from app import models


app = FastAPI(
    title="RideSmart API",
    description="Backend for Smart Public Transportation System",
    version="1.0"
)

models.Base.metadata.create_all(bind=engine)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(buses.router)
app.include_router(routes.router)
app.include_router(stops.router)
app.include_router(planner.router)
app.include_router(stats.router)
app.include_router(tracking.router)


@app.get("/")
def home():
    return {
        "message": "RideSmart Backend is Running"
    }


@app.get("/health")
def health():
    return {
        "status": "OK"
    }