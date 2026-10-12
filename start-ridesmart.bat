@echo off
cd /d Y:\SDG\ridesmart
start "RideSmart API" cmd /k "Y:\SDG\ridesmart\.venv\Scripts\python.exe -m uvicorn database.main:app --port 8000"
timeout /t 4 >nul
start "RideSmart Simulator" cmd /k "Y:\SDG\ridesmart\.venv\Scripts\python.exe -m simulation_ml.simulate --speed 5 --interval 2"
start "RideSmart Frontend" cmd /k "cd frontend && npm run dev"
timeout /t 6 >nul
start http://localhost:5173
