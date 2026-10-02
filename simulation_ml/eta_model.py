
"""RideSmart ETA prediction module.

Estimates the remaining travel time using existing route-segment
statistics, with scheduled travel time as a fallback.

This module does not modify the database schema or simulator.
"""

from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from simulation_ml.db.models import (
    Location,
    RouteStop,
    SegmentStat,
    Stop,
    Trip,
    get_sessionmaker,
)


def predict_eta(trip_id: int, destination_stop_id: int) -> dict:
    """Predict the remaining travel time to a destination stop.

    Returns a dictionary containing ETA seconds, estimated arrival
    time, and the prediction method.
    """
    Session = get_sessionmaker()

    with Session() as session:
        # 1. Validate the trip.
        trip = session.get(Trip, trip_id)

        if trip is None:
            raise ValueError(f"Trip {trip_id} was not found.")

        if trip.status != "active":
            raise ValueError(f"Trip {trip_id} is not active.")

        # 2. Validate the destination.
        destination = session.get(Stop, destination_stop_id)

        if destination is None:
            raise ValueError(
                f"Destination stop {destination_stop_id} was not found."
            )

        # 3. Get the stops along the trip's route.
        route_stops = session.scalars(
            select(RouteStop)
            .where(RouteStop.route_id == trip.route_id)
            .order_by(RouteStop.seq)
        ).all()

        if len(route_stops) < 2:
            raise ValueError(
                f"Route for trip {trip_id} has insufficient stops."
            )

        # 4. Find the destination's position on the route.
        destination_position = next(
            (
                index
                for index, route_stop in enumerate(route_stops)
                if route_stop.stop_id == destination_stop_id
            ),
            None,
        )

        if destination_position is None:
            raise ValueError(
                "The destination stop is not on this trip's route."
            )

        # 5. Get the latest simulated bus location.
        latest_location = session.scalars(
            select(Location)
            .where(Location.trip_id == trip_id)
            .order_by(Location.ts.desc(), Location.id.desc())
        ).first()

        if latest_location is None:
            raise ValueError(
                f"No location data is available for trip {trip_id}."
            )

        # 6. Convert progress into a position along the route.
        progress = max(
            0.0,
            min(1.0, float(latest_location.seq_progress)),
        )
        route_position = progress * (len(route_stops) - 1)

        # 7. Calculate the remaining travel time.
        if destination_position <= route_position:
            remaining_seconds = 0.0
        else:
            remaining_seconds = 0.0

            for index in range(destination_position):
                segment_start = route_stops[index]
                segment_end = route_stops[index + 1]

                # Skip segments the bus has already passed.
                if index + 1 <= route_position:
                    continue

                # Prefer observed travel statistics when available.
                segment_stat = session.scalars(
                    select(SegmentStat).where(
                        SegmentStat.route_id == trip.route_id,
                        SegmentStat.from_stop_id
                        == segment_start.stop_id,
                        SegmentStat.to_stop_id
                        == segment_end.stop_id,
                    )
                ).first()

                if (
                    segment_stat is not None
                    and segment_stat.avg_travel_sec is not None
                ):
                    segment_seconds = float(
                        segment_stat.avg_travel_sec
                    )
                else:
                    # Fall back to scheduled segment duration.
                    segment_seconds = float(
                        segment_end.scheduled_offset_sec
                        - segment_start.scheduled_offset_sec
                    )

                # If the bus is partway through this segment,
                # count only the fraction that remains.
                if index < route_position:
                    fraction_remaining = index + 1 - route_position
                    remaining_seconds += (
                        max(0.0, fraction_remaining) * segment_seconds
                    )
                else:
                    remaining_seconds += segment_seconds

            remaining_seconds = max(
                0.0,
                float(round(remaining_seconds)),
            )

        # 8. Estimate the arrival time.
        arrival_time = datetime.now(timezone.utc) + timedelta(
            seconds=remaining_seconds
        )

        return {
            "trip_id": trip_id,
            "destination_stop_id": destination_stop_id,
            "eta_seconds": int(remaining_seconds),
            "arrival_time": arrival_time.isoformat(),
            "method": "segment_baseline",
        }
