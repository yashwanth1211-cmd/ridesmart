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
-- ONE ROW IS ONE DIRECTION.
-- route_number is the public number shared by both directions ("21A"); code is
-- the unique identity of one direction ("21A UP" / "21A DOWN"). The DOWN row
-- stores its stops reversed, so seq is always travel order.
CREATE TABLE route (
    id            INTEGER PRIMARY KEY,
    code          VARCHAR(16) NOT NULL UNIQUE,
    route_number  VARCHAR(16) NOT NULL DEFAULT '',
    name          VARCHAR(120) NOT NULL,
    direction     VARCHAR(8)  NOT NULL DEFAULT 'up'
);
CREATE INDEX ix_route_route_number       ON route (route_number);
CREATE INDEX ix_route_number_direction   ON route (route_number, direction);

-- Ordered membership of a stop in a route.
-- leg_distance_m is the road distance from the previous stop; 0 on the first.
CREATE TABLE route_stop (
    id                   INTEGER PRIMARY KEY,
    route_id             INTEGER NOT NULL REFERENCES route (id) ON DELETE CASCADE,
    stop_id              INTEGER NOT NULL REFERENCES stop  (id) ON DELETE CASCADE,
    seq                  INTEGER NOT NULL,           -- 0-based travel order
    scheduled_offset_sec INTEGER NOT NULL DEFAULT 0,
    leg_distance_m       DOUBLE  NOT NULL DEFAULT 0,
    CONSTRAINT uq_route_seq UNIQUE (route_id, seq)
);
CREATE INDEX ix_route_stop_route ON route_stop (route_id);
CREATE INDEX ix_route_stop_stop  ON route_stop (stop_id);
-- The journey planner's hot path: "every route where this stop precedes that
-- stop" is a self-join on route_id, and without this it scans the whole table.
CREATE INDEX ix_route_stop_lookup ON route_stop (route_id, stop_id, seq);

-- ----------------------------------------------------------------- buses ----
-- bus_type is the service class: 'ordinary' city, 'express', or 'deluxe'
-- intercity coach. It lives on the bus, not the route, because buses are
-- reassigned between services over the day.
-- display_name is the short reference a passenger says out loud ("Bus 4");
-- reg_no is the vehicle registration and stays alongside it. Uniqueness is
-- seeded by construction (sequential, fleet-wide) and asserted in tests
-- rather than in a constraint, because the empty default is legal on a row
-- inserted before seeding assigns one.
CREATE TABLE bus (
    id           INTEGER PRIMARY KEY,
    reg_no       VARCHAR(24) NOT NULL UNIQUE,
    display_name VARCHAR(16) NOT NULL DEFAULT '',
    capacity     INTEGER     NOT NULL DEFAULT 50,
    wheelchair   BOOLEAN     NOT NULL DEFAULT 0,
    low_floor    BOOLEAN     NOT NULL DEFAULT 0,
    bus_type     VARCHAR(10) NOT NULL DEFAULT 'ordinary',
    active       BOOLEAN     NOT NULL DEFAULT 1,
    CONSTRAINT ck_bus_type CHECK (bus_type IN ('ordinary', 'express', 'deluxe'))
);
CREATE INDEX ix_bus_bus_type ON bus (bus_type);

-- ----------------------------------------------------- service patterns ----
-- A route's through-the-day timetable for one direction: first bus, last bus,
-- headway. Stored compactly rather than as one Trip row per departure, so
-- "is anything leaving in the next 90 minutes?" is arithmetic instead of tens
-- of thousands of rows. Trips still exist for the runs that are actually live.
CREATE TABLE service_pattern (
    id                INTEGER PRIMARY KEY,
    route_id          INTEGER NOT NULL REFERENCES route (id) ON DELETE CASCADE,
    direction         VARCHAR(8) NOT NULL DEFAULT 'up',
    first_departure   VARCHAR(5) NOT NULL DEFAULT '05:30',
    last_departure    VARCHAR(5) NOT NULL DEFAULT '21:30',
    headway_min       INTEGER    NOT NULL DEFAULT 20,
    peak_headway_min  INTEGER    NOT NULL DEFAULT 0,
    CONSTRAINT uq_service_pattern UNIQUE (route_id, direction),
    CONSTRAINT ck_service_headway CHECK (headway_min BETWEEN 5 AND 60)
);
CREATE INDEX ix_service_pattern_route ON service_pattern (route_id);

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
--
-- current_stop_id / next_stop_id / delay_sec are what the simulator already
-- knew when it wrote the tick. Storing them lets the journey planner answer
-- "which buses still have this stop ahead of them" from one indexed read
-- instead of re-walking the route shape, and "is this bus late" without
-- re-deriving the schedule. All optional so older writers still load.
CREATE TABLE location (
    id              INTEGER PRIMARY KEY,
    bus_id          INTEGER NOT NULL REFERENCES bus (id),
    trip_id         INTEGER NOT NULL REFERENCES trip (id) ON DELETE CASCADE,
    lat             DOUBLE      NOT NULL,
    lon             DOUBLE      NOT NULL,
    speed_kmph      DOUBLE      NOT NULL DEFAULT 0,
    heading         DOUBLE      NOT NULL DEFAULT 0,
    seq_progress    DOUBLE      NOT NULL DEFAULT 0,   -- fraction of route done, 0.0-1.0
    current_stop_id INTEGER     REFERENCES stop (id),
    next_stop_id    INTEGER     REFERENCES stop (id),
    delay_sec       DOUBLE      NOT NULL DEFAULT 0,   -- negative = running early
    ts              TIMESTAMP   NOT NULL
);
CREATE INDEX ix_location_trip ON location (trip_id);
CREATE INDEX ix_location_ts   ON location (ts);
CREATE INDEX ix_location_bus  ON location (bus_id);
CREATE INDEX ix_location_current_stop ON location (current_stop_id);
CREATE INDEX ix_location_next_stop    ON location (next_stop_id);

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