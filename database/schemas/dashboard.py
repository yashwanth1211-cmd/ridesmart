from pydantic import BaseModel


class AuthorityDashboard(BaseModel):
	total_buses: int
	active_buses: int
	delayed_buses: int
	high_demand_route: str
	crowded_route: str
