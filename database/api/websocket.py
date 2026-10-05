"""Live position WebSocket.

OWNER: Member 5 (integration).

MEMBER 2: this replaces the hardcoded `while True: send_json({...})` loop, which
sent the same coordinates forever. This reads the database on each tick, so the
payload reflects whatever the simulator is actually doing.

If the client disconnects, the subscription is torn down and the loop exits -
the original version only caught WebSocketDisconnect, so a server-side send
failure would leak the task.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from database.core.database import SessionLocal
from database.services.tracking import active_positions

router = APIRouter(tags=["WebSocket"])

# how often to push a fresh snapshot
PUSH_INTERVAL_SEC = 2.0


def _snapshot(route_id: int | None) -> list[dict]:
    """Read current positions. Runs in a thread so it never blocks the loop."""
    db = SessionLocal()
    try:
        return active_positions(db, route_id=route_id)
    finally:
        db.close()


def _requested_route(websocket: WebSocket) -> int | None:
    """Read the optional ?route_id= scope off the handshake.

    The socket is opened per selection by the live map, so scope it here rather
    than pushing the whole fleet every 2s and filtering in the browser. A
    missing, blank or non-numeric value means "no scope", which keeps every
    existing client working.
    """
    raw = websocket.query_params.get("route_id")
    if raw is None or not raw.strip():
        return None
    try:
        return int(raw)
    except ValueError:
        # A malformed scope is treated as absent rather than fatal: dropping the
        # connection would leave the client polling forever with no error shown.
        return None


@router.websocket("/ws/buses")
async def bus_websocket(websocket: WebSocket):
    await websocket.accept()

    route_id = _requested_route(websocket)

    try:
        while True:
            positions = await asyncio.to_thread(_snapshot, route_id)
            await websocket.send_json(positions)
            await asyncio.sleep(PUSH_INTERVAL_SEC)

    except WebSocketDisconnect:
        pass
    except (RuntimeError, ConnectionError):
        # client vanished mid-send; nothing to clean up beyond this handler
        pass
