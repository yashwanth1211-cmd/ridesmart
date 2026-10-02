import asyncio
import websockets


async def test_websocket():
    uri = "ws://127.0.0.1:8000/ws/buses"

    async with websockets.connect(uri) as websocket:
        print("Connected to RideSmart WebSocket!")

        for i in range(3):
            message = await websocket.recv()
            print("Received:", message)


asyncio.run(test_websocket())