from app.database import SessionLocal, engine
from app import models

models.Base.metadata.create_all(bind=engine)

db = SessionLocal()

try:
    if db.query(models.Bus).count() == 0:
        buses = [
            models.Bus(
                bus_number="21A",
                latitude=12.9716,
                longitude=79.1588,
                speed=30,
                passenger_count=18,
                capacity=50,
                accessible=True
            ),
            models.Bus(
                bus_number="7A",
                latitude=12.9690,
                longitude=79.1600,
                speed=25,
                passenger_count=35,
                capacity=50,
                accessible=True
            ),
            models.Bus(
                bus_number="22B",
                latitude=12.9750,
                longitude=79.1650,
                speed=20,
                passenger_count=47,
                capacity=50,
                accessible=False
            )
        ]

        db.add_all(buses)

    if db.query(models.Stop).count() == 0:
        stops = [
            models.Stop(
                name="VIT Main Gate",
                latitude=12.9692,
                longitude=79.1559
            ),
            models.Stop(
                name="Katpadi",
                latitude=12.9720,
                longitude=79.1380
            ),
            models.Stop(
                name="Katpadi Railway Station",
                latitude=12.9724,
                longitude=79.1385
            )
        ]

        db.add_all(stops)

    if db.query(models.Route).count() == 0:
        routes = [
            models.Route(
                route_number="21A",
                start_location="VIT University",
                end_location="Katpadi Railway Station"
            ),
            models.Route(
                route_number="7A",
                start_location="VIT University",
                end_location="Vellore Bus Stand"
            ),
            models.Route(
                route_number="22B",
                start_location="Katpadi",
                end_location="Vellore Town"
            )
        ]

        db.add_all(routes)

    db.commit()

    print("RideSmart sample data added successfully.")

finally:
    db.close()