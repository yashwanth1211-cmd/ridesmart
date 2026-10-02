from pydantic import BaseModel


class BusLocation(BaseModel):
	bus_id: str
	route_id: str
	latitude: float
	longitude: float
	speed: float = 0.0


class BusActive(BaseModel):
	bus_id: str
	route_id: str
	latitude: float
	longitude: float
	speed: float = 0.0
	crowding_level: str
