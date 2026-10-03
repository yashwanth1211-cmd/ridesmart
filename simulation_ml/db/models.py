"""RideSmart ORM models.

OWNER: Member 5 (temporarily, while Member 4 is unavailable).
IMPORTED BY: Member 2 (database/ - FastAPI application).

This module is the single source of truth for the data layer. Do not
redeclare these tables anywhere else. If you need a new column, add it here
first, then tell the group.

Target engine: SQLite for development, portable to PostgreSQL by changing
DATABASE_URL. No SQLite-specific column types are used.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    create_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker

# --------------------------------------------------------------------------
# Engine / session helpers
# --------------------------------------------------------------------------

def database_url() -> str:
    return os.getenv("DATABASE_URL", "sqlite:///./ridesmart.db")


class Base(DeclarativeBase):
    pass


_engine = None
_SessionLocal = None


def get_engine(url: str | None = None):
    global _engine
    if _engine is None or url is not None:
        target = url or database_url()
        connect_args = {"check_same_thread": False} if target.startswith("sqlite") else {}
        _engine = create_engine(target, future=True, connect_args=connect_args)
    return _engine


def get_sessionmaker(url: str | None = None):
    global _SessionLocal
    if _SessionLocal is None or url is not None:
        _SessionLocal = sessionmaker(bind=get_engine(url), future=True)
    return _SessionLocal


def utcnow() -> datetime:
    """Timezone-aware UTC now. Every timestamp in this project is UTC."""
    return datetime.now(timezone.utc)


def as_utc(dt: datetime | None) -> datetime | None:
    """Re-attach UTC to a naive datetime read back from the database.

    SQLite has no native timezone support, so it silently drops tzinfo on read.
    Without this, `row.ts - utcnow()` raises TypeError. Any code comparing a
    DB timestamp against the current time must wrap the DB value in this.
    """
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def crowd_level_for(load: int, capacity: int) -> str:
    """Single source of truth for crowd banding.

    Thresholds are declared in tests_docs/api_contract.yaml. The simulator,
    the seed data and Member 2's API all call this function so the demo can
    never show a crowd badge that disagrees with the API.
    """
    if capacity <= 0:
        return "low"
    ratio = load / capacity
    if ratio < 0.4:
        return "low"
    if ratio < 0.75:
        return "med"
    return "high"


# --------------------------------------------------------------------------
# Tables
# --------------------------------------------------------------------------

class Stop(Base):
    """A physical bus stop."""

    __tablename__ = "stop"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lon: Mapped[float] = mapped_column(Float, nullable=False)
    accessible: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    route_stops: Mapped[list["RouteStop"]] = relationship(back_populates="stop")

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "code": self.code,
            "name": self.name,
            "lat": self.lat,
            "lon": self.lon,
            "accessible": bool(self.accessible),
        }


class Route(Base):
    """A bus route, e.g. 21A."""

    __tablename__ = "route"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(16), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    direction: Mapped[str] = mapped_column(String(8), default="up", nullable=False)

    route_stops: Mapped[list["RouteStop"]] = relationship(
        back_populates="route",
        order_by="RouteStop.seq",
        cascade="all, delete-orphan",
    )
    shape_points: Mapped[list["RouteShapePoint"]] = relationship(
        back_populates="route",
        order_by="RouteShapePoint.leg, RouteShapePoint.seq",
        cascade="all, delete-orphan",
    )
    trips: Mapped[list["Trip"]] = relationship(back_populates="route")

    @property
    def stop_count(self) -> int:
        return len(self.route_stops)

    def ordered_stops(self) -> list["RouteStop"]:
        return sorted(self.route_stops, key=lambda rs: rs.seq)

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "code": self.code,
            "name": self.name,
            "direction": self.direction,
            "stop_count": self.stop_count,
        }


class RouteStop(Base):
    """Ordered membership of a stop within a route."""

    __tablename__ = "route_stop"
    __table_args__ = (
        UniqueConstraint("route_id", "seq", name="uq_route_seq"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    route_id: Mapped[int] = mapped_column(
        ForeignKey("route.id", ondelete="CASCADE"), nullable=False, index=True
    )
    stop_id: Mapped[int] = mapped_column(
        ForeignKey("stop.id", ondelete="CASCADE"), nullable=False, index=True
    )
    seq: Mapped[int] = mapped_column(Integer, nullable=False, doc="0-based travel order")
    scheduled_offset_sec: Mapped[int] = mapped_column(
        Integer, default=0, nullable=False,
        doc="Seconds from trip start to scheduled arrival at this stop",
    )

    route: Mapped[Route] = relationship(back_populates="route_stops")
    stop: Mapped[Stop] = relationship(back_populates="route_stops")

    def as_dict(self) -> dict:
        return {
            "seq": self.seq,
            "scheduled_offset_sec": self.scheduled_offset_sec,
            "stop": self.stop.as_dict(),
        }


class RouteShapePoint(Base):
    """One vertex of a route's real road polyline.

    The simulator advances a bus ALONG this polyline rather than drawing a
    straight line between consecutive stops, so buses travel on roads instead of
    through buildings. Points are ordered by `leg` (which stop-to-stop hop they
    belong to) then `seq` (position within that hop).

    Coordinates come from OSRM via simulation_ml/tools/build_real_routes.py and
    are committed as data, so nothing here depends on a routing service at
    runtime. `cum_m` is the distance from the start of the whole route to this
    point, precomputed by the seed: it lets the simulator turn a 0-1 progress
    fraction into an exact point on the shape without walking the polyline.
    """

    __tablename__ = "route_shape_point"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    route_id: Mapped[int] = mapped_column(
        ForeignKey("route.id", ondelete="CASCADE"), nullable=False, index=True
    )
    leg: Mapped[int] = mapped_column(
        Integer, nullable=False, doc="Index of the stop-to-stop hop this point belongs to"
    )
    seq: Mapped[int] = mapped_column(
        Integer, nullable=False, doc="Position within the leg, 0-based"
    )
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lon: Mapped[float] = mapped_column(Float, nullable=False)
    cum_m: Mapped[float] = mapped_column(
        Float, default=0.0, nullable=False,
        doc="Metres from the first vertex of the whole route",
    )

    def as_coord(self) -> tuple[float, float]:
        return self.lat, self.lon

    route: Mapped[Route] = relationship(back_populates="shape_points")


class Bus(Base):
    """A physical vehicle."""

    __tablename__ = "bus"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    reg_no: Mapped[str] = mapped_column(String(24), unique=True, nullable=False)
    capacity: Mapped[int] = mapped_column(Integer, default=50, nullable=False)
    wheelchair: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    low_floor: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    trips: Mapped[list["Trip"]] = relationship(back_populates="bus")

    def as_dict(self) -> dict:
        return {
            "bus_id": self.id,
            "bus_reg": self.reg_no,
            "capacity": self.capacity,
            "wheelchair_accessible": bool(self.wheelchair),
            "low_floor": bool(self.low_floor),
        }


class Trip(Base):
    """One run of a bus along a route."""

    __tablename__ = "trip"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    bus_id: Mapped[int] = mapped_column(ForeignKey("bus.id"), nullable=False, index=True)
    route_id: Mapped[int] = mapped_column(ForeignKey("route.id"), nullable=False, index=True)
    direction: Mapped[str] = mapped_column(String(8), default="up", nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="active", nullable=False, index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    planned_duration_sec: Mapped[int] = mapped_column(Integer, default=1200, nullable=False)

    __table_args__ = (
        CheckConstraint("status IN ('active','completed','cancelled')", name="ck_trip_status"),
    )

    bus: Mapped[Bus] = relationship(back_populates="trips")
    route: Mapped[Route] = relationship(back_populates="trips")
    locations: Mapped[list["Location"]] = relationship(
        back_populates="trip", cascade="all, delete-orphan"
    )
    crowds: Mapped[list["Crowd"]] = relationship(
        back_populates="trip", cascade="all, delete-orphan"
    )


class Schedule(Base):
    """Per-trip timetable offsets. Kept separate from Trip for extensibility."""

    __tablename__ = "schedule"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    trip_id: Mapped[int] = mapped_column(
        ForeignKey("trip.id", ondelete="CASCADE"), nullable=False, index=True
    )
    stop_id: Mapped[int] = mapped_column(ForeignKey("stop.id"), nullable=False, index=True)
    scheduled_offset_sec: Mapped[int] = mapped_column(Integer, nullable=False)
    scheduled_arrival: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Location(Base):
    """Telemetry tick. Written by the simulator, read by Member 1 and Member 2.

    This is the historical table Member 1's ETA model trains on.
    """

    __tablename__ = "location"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    bus_id: Mapped[int] = mapped_column(ForeignKey("bus.id"), nullable=False, index=True)
    trip_id: Mapped[int] = mapped_column(ForeignKey("trip.id", ondelete="CASCADE"), index=True)
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lon: Mapped[float] = mapped_column(Float, nullable=False)
    speed_kmph: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    heading: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    seq_progress: Mapped[float] = mapped_column(
        Float, default=0.0, doc="Fraction of the route completed, 0.0-1.0"
    )
    ts: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False, index=True)

    trip: Mapped[Trip] = relationship(back_populates="locations")

    def as_position(self) -> dict:
        return {
            "bus_id": self.bus_id,
            "lat": self.lat,
            "lon": self.lon,
            "speed_kmph": round(self.speed_kmph, 1),
            "heading": round(self.heading, 1),
            "ts": self.ts.isoformat(),
        }


class Crowd(Base):
    """Occupancy estimate at a stop for a trip."""

    __tablename__ = "crowd"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    trip_id: Mapped[int] = mapped_column(
        ForeignKey("trip.id", ondelete="CASCADE"), nullable=False, index=True
    )
    stop_id: Mapped[int] = mapped_column(ForeignKey("stop.id"), nullable=False, index=True)
    load: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    capacity: Mapped[int] = mapped_column(Integer, default=50, nullable=False)
    level: Mapped[str] = mapped_column(String(8), default="low", nullable=False)
    ts: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False, index=True)

    __table_args__ = (
        CheckConstraint("level IN ('low','med','high')", name="ck_crowd_level"),
    )

    trip: Mapped[Trip] = relationship(back_populates="crowds")
    stop: Mapped[Stop] = relationship()

    @property
    def ratio(self) -> float:
        return round(self.load / self.capacity, 3) if self.capacity else 0.0

    def as_dict(self) -> dict:
        return {
            "trip_id": self.trip_id,
            "stop_id": self.stop_id,
            "load": self.load,
            "capacity": self.capacity,
            "ratio": self.ratio,
            "level": self.level,
            "ts": self.ts.isoformat(),
        }


class SegmentStat(Base):
    """Observed travel time per route segment - the bridge to Member 1's ETA model.

    The seed pre-populates realistic values so Member 1 has a working baseline
    ETA on hour one, without waiting for the simulator to accumulate history.

    score 1.0 == exactly on schedule. Values below 1.0 mean the segment is
    usually faster than published, above 1.0 means usually slower.
    """

    __tablename__ = "segment_stat"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    route_id: Mapped[int] = mapped_column(
        ForeignKey("route.id", ondelete="CASCADE"), nullable=False, index=True
    )
    from_stop_id: Mapped[int] = mapped_column(ForeignKey("stop.id"), nullable=False)
    to_stop_id: Mapped[int] = mapped_column(ForeignKey("stop.id"), nullable=False)
    avg_travel_sec: Mapped[float] = mapped_column(Float, nullable=False)
    sched_travel_sec: Mapped[int] = mapped_column(
        Integer, nullable=False, doc="Timetable value for the same segment"
    )
    samples: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    observed_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint("route_id", "from_stop_id", "to_stop_id", name="uq_segment"),
    )

    @property
    def factor(self) -> float:
        """Observed / scheduled. 1.2 means this segment runs 20% late."""
        return self.avg_travel_sec / self.sched_travel_sec if self.sched_travel_sec else 1.0

    def as_dict(self) -> dict:
        return {
            "route_id": self.route_id,
            "from_stop_id": self.from_stop_id,
            "to_stop_id": self.to_stop_id,
            "avg_travel_sec": round(self.avg_travel_sec, 1),
            "sched_travel_sec": self.sched_travel_sec,
            "factor": round(self.factor, 3),
            "samples": self.samples,
        }


def create_all(url: str | None = None) -> None:
    """Create every table. Safe to call repeatedly."""
    Base.metadata.create_all(get_engine(url))


def drop_all(url: str | None = None) -> None:
    Base.metadata.drop_all(get_engine(url))


def reset_database(url: str | None = None) -> None:
    """Wipe and recreate. Used by the seed script and the test fixtures."""
    drop_all(url)
    create_all(url)


__all__ = [
    "Base",
    "Stop",
    "Route",
    "RouteStop",
    "RouteShapePoint",
    "Bus",
    "Trip",
    "Schedule",
    "Location",
    "Crowd",
    "SegmentStat",
    "create_all",
    "drop_all",
    "reset_database",
    "get_engine",
    "get_sessionmaker",
    "database_url",
    "utcnow",
    "as_utc",
    "crowd_level_for",
]