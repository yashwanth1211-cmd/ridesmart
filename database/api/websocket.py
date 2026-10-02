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


def _snapshot() -> list[dict]:
    """Read current positions. Runs in a thread so it never blocks the loop."""
    db = SessionLocal()
    try:
        return active_positions(db)
    finally:
        db.close()


@router.websocket("/ws/buses")
async def bus_websocket(websocket: WebSocket):
    await websocket.accept()

    try:
        while True:
            positions = await asyncio.to_thread(_snapshot)
            await websocket.send_json(positions)
            await asyncio.sleep(PUSH_INTERVAL_SEC)

    except WebSocketDisconnect:
        pass
    except (RuntimeError, ConnectionError):
        # client vanished mid-send; nothing to clean up beyond this handler
        pass
