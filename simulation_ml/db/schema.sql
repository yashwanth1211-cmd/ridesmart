-- RideSmart reference schema
-- OWNER: Member 5 (temporarily, while Member 4 is unavailable)
--
-- This file is DOCUMENTATION. The schema that actually creates tables is
-- simulation_ml/db/models.py (SQLAlchemy ORM). Keep this in sync when you
-- change a column.
--
-- Portable SQL: no SQLite-specific types, so switching DATABASE_URL to
-- PostgreSQL requires no schema changes.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- stops ----
CREATE TABLE stop (
    id         INTEGER PRIMARY KEY,
    code       VARCHAR(64)  NOT NULL UNIQUE,
    name       VARCHAR(120) NOT NULL,
    lat        DOUBLE       NOT NULL,
    lon        DOUBLE       NOT NULL,
    accessible BOOLEAN      NOT NULL DEFAULT 0,
    -- 'transit' = OSM maps a real bus stop / bus station / station here.
    -- 'campus'  = anchored at a landmark instead (e.g. Kingston Engineering
    --             College, which OSM has no bus bay for). Kept honest in the
    --             data so the UI can label it rather than imply it is surveyed.
    kind       VARCHAR(16)  NOT NULL DEFAULT 'transit'
);
CREATE INDEX ix_stop_code ON stop (code);

-- --------------------------------------------------------------- routes ----
CREATE TABLE route (
    id        INTEGER PRIMARY KEY,
    code      VARCHAR(16)  NOT NULL UNIQUE,
    name      VARCHAR(120) NOT NULL,
    direction VARCHAR(8)   NOT NULL DEFAULT 'up'
);

-- Ordered membership of a stop in a route.
CREATE TABLE route_stop (
    id                   INTEGER PRIMARY KEY,
    route_id             INTEGER NOT NULL REFERENCES route (id) ON DELETE CASCADE,
    stop_id              INTEGER NOT NULL REFERENCES stop  (id) ON DELETE CASCADE,
    seq                  INTEGER NOT NULL,           -- 0-based travel order
    scheduled_offset_sec INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT uq_route_seq UNIQUE (route_id, seq)
);
CREATE INDEX ix_route_stop_route ON route_stop (route_id);
CREATE INDEX ix_route_stop_stop  ON route_stop (stop_id);

-- ----------------------------------------------------------------- buses ----
CREATE TABLE bus (
    id         INTEGER PRIMARY KEY,
    reg_no     VARCHAR(24) NOT NULL UNIQUE,
    capacity   INTEGER     NOT NULL DEFAULT 50,
    wheelchair BOOLEAN     NOT NULL DEFAULT 0,
    low_floor  BOOLEAN     NOT NULL DEFAULT 0,
    active     BOOLEAN     NOT NULL DEFAULT 1
);

-- ----------------------------------------------------------------- trips ----
CREATE TABLE trip (
    id                    INTEGER PRIMARY KEY,
    bus_id                INTEGER NOT NULL REFERENCES bus  (id),
    route_id              INTEGER NOT NULL REFERENCES route (id),
    direction             VARCHAR(8)   NOT NULL DEFAULT 'up',
    status                VARCHAR(16)  NOT NULL DEFAULT 'active',
    started_at            TIMESTAMP    NOT NULL,
    planned_duration_sec  INTEGER      NOT NULL DEFAULT 1200,
    CONSTRAINT ck_trip_status CHECK (status IN ('active', 'completed', 'cancelled'))
);
CREATE INDEX ix_trip_bus    ON trip (bus_id);
CREATE INDEX ix_trip_route  ON trip (route_id);
CREATE INDEX ix_trip_status ON trip (status);

-- Per-trip timetable offsets.
CREATE TABLE schedule (
    id                   INTEGER PRIMARY KEY,
    trip_id              INTEGER NOT NULL REFERENCES trip (id) ON DELETE CASCADE,
    stop_id              INTEGER NOT NULL REFERENCES stop (id),
    scheduled_offset_sec INTEGER NOT NULL,
    scheduled_arrival    TIMESTAMP
);
CREATE INDEX ix_schedule_trip ON schedule (trip_id);

-- --------------------------------------------------------- telemetry ----
-- Written by the simulator. This is the historical table Member 1's ETA
-- model trains on.
CREATE TABLE location (
    id           INTEGER PRIMARY KEY,
    bus_id       INTEGER NOT NULL REFERENCES bus (id),
    trip_id      INTEGER NOT NULL REFERENCES trip (id) ON DELETE CASCADE,
    lat          DOUBLE      NOT NULL,
    lon          DOUBLE      NOT NULL,
    speed_kmph   DOUBLE      NOT NULL DEFAULT 0,
    heading      DOUBLE      NOT NULL DEFAULT 0,
    seq_progress DOUBLE      NOT NULL DEFAULT 0,   -- fraction of route done, 0.0-1.0
    ts           TIMESTAMP   NOT NULL
);
CREATE INDEX ix_location_trip ON location (trip_id);
CREATE INDEX ix_location_ts   ON location (ts);
CREATE INDEX ix_location_bus  ON location (bus_id);

-- --------------------------------------------------------------- crowd ----
CREATE TABLE crowd (
    id       INTEGER PRIMARY KEY,
    trip_id  INTEGER NOT NULL REFERENCES trip (id) ON DELETE CASCADE,
    stop_id  INTEGER NOT NULL REFERENCES stop (id),
    load     INTEGER NOT NULL DEFAULT 0,
    capacity INTEGER NOT NULL DEFAULT 50,
    level    VARCHAR(8) NOT NULL DEFAULT 'low',
    ts       TIMESTAMP   NOT NULL,
    CONSTRAINT ck_crowd_level CHECK (level IN ('low', 'med', 'high'))
);
CREATE INDEX ix_crowd_trip ON crowd (trip_id);
CREATE INDEX ix_crowd_ts   ON crowd (ts);

-- ------------------------------------------------------- segment stats ----
-- THE BRIDGE TO MEMBER 1's ETA MODEL.
-- Observed travel time per route segment, seeded with realistic values so a
-- baseline ETA works immediately. factor = avg_travel_sec / sched_travel_sec;
-- 1.2 means the segment normally runs 20% slower than the timetable.
CREATE TABLE segment_stat (
    id                INTEGER PRIMARY KEY,
    route_id          INTEGER NOT NULL REFERENCES route (id) ON DELETE CASCADE,
    from_stop_id      INTEGER NOT NULL REFERENCES stop (id),
    to_stop_id        INTEGER NOT NULL REFERENCES stop (id),
    avg_travel_sec    DOUBLE  NOT NULL,
    sched_travel_sec  INTEGER NOT NULL,
    samples           INTEGER NOT NULL DEFAULT 0,
    observed_at       TIMESTAMP NOT NULL,
    CONSTRAINT uq_segment UNIQUE (route_id, from_stop_id, to_stop_id)
);
CREATE INDEX ix_segment_route ON segment_stat (route_id);

-- ------------------------------------------------------------- notes ----
-- Crowd banding, single source of truth (see models.py::crowd_level_for):
--   low  : load / capacity <  0.40
--   med  : 0.40 <= load / capacity < 0.75
--   high : load / capacity >= 0.75
--
-- Seeded demo values hit every band:
--   12 / 50 = 0.24 low | 35 / 50 = 0.70 med | 42 / 50 = 0.84 high