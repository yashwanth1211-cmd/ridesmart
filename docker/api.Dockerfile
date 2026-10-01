# Member 5 owns this file.
# Build context is the repo root so the image can include backend/ and database/.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app

WORKDIR /app

COPY simulation_ml/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY simulation_ml /app/simulation_ml
COPY backend  /app/backend
COPY database /app/database

RUN mkdir -p /data

EXPOSE 8000

# Member 2 owns main.py. If the app entrypoint moves, update this line.
CMD ["uvicorn", "database.app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]