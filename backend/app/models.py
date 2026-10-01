from sqlalchemy import Column, Integer, String, Float, Boolean
from app.database import Base


class Bus(Base):
    __tablename__ = "buses"

    id = Column(Integer, primary_key=True, index=True)
    bus_number = Column(String, unique=True, index=True)
    latitude = Column(Float)
    longitude = Column(Float)
    speed = Column(Float)
    passenger_count = Column(Integer)
    capacity = Column(Integer)
    accessible = Column(Boolean)


class Stop(Base):
    __tablename__ = "stops"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String)
    latitude = Column(Float)
    longitude = Column(Float)


class Route(Base):
    __tablename__ = "routes"

    id = Column(Integer, primary_key=True, index=True)
    route_number = Column(String)
    start_location = Column(String)
    end_location = Column(String)