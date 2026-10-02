# Member 5 owns this file.
# Build context is the repo root so the image can include database/ and simulation_ml/.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app \
    DATABASE_URL=sqlite:////data/ridesmart.db

WORKDIR /app

COPY database/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY simulation_ml /app/simulation_ml
COPY database     /app/database

RUN mkdir -p /data

EXPOSE 8000

# Entrypoint is database/main.py. lifespan() creates the schema and seeds it, so
# the container is useful with no extra command. Do not use --reload in a real
# image; it is only harmless here because this is a dev/demo image.
CMD ["uvicorn", "database.main:app", "--host", "0.0.0.0", "--port", "8000"]