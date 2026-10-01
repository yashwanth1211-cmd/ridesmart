import asyncio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect


router = APIRouter(
    tags=["WebSocket"],
)


@router.websocket("/ws/buses")
async def bus_websocket(websocket: WebSocket):
    await websocket.accept()

    try:
        while True:
            await websocket.send_json(
                {
                    "bus_id": "BUS101",
                    "route_id": "21A",
                    "latitude": 12.9716,
                    "longitude": 77.5946,
                    "speed": 32.5,
                    "crowding_level": "medium",
                }
            )

            await asyncio.sleep(5)

    except WebSocketDisconnect:
        print("Client disconnected from bus WebSocket")