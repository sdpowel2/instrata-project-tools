# Lead Finder worker (Fly app instrata-leadfinder). Deploy from this directory:
#   fly deploy --remote-only
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    LEADFINDER_DATA_DIR=/data

WORKDIR /app

# Dependencies first (cached layer), then the code. Editable install so config/
# and Skills/ resolve next to the package (settings.ROOT = /app).
COPY pyproject.toml README.md ./
COPY leadfinder ./leadfinder
RUN pip install -e .

COPY config ./config
COPY Skills ./Skills

EXPOSE 8080
CMD ["leadfinder", "worker", "--host", "0.0.0.0", "--port", "8080"]
