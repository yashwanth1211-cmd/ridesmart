from pydantic import BaseModel


class Stop(BaseModel):
	stop_id: str
	name: str
	latitude: float
	longitude: float


class Route(BaseModel):
	route_id: str
	name: str
	stops: list[Stop]
