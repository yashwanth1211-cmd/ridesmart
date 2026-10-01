from pydantic import BaseModel


class TripETA(BaseModel):
	trip_id: str
	eta_min: int
	eta_predicted_min: int
	delay_min: int


class CrowdUpdate(BaseModel):
	passenger_count: int
