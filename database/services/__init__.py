"""Service layer.

OWNER: Member 5 (integration).

Routers stay thin: they resolve the request, call one of these functions, and
shape the response. The interesting logic - planning, ETA prediction, crowd
estimation - lives here where it can be unit tested without HTTP.
"""
