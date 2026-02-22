# ECO-3D Studio — Setup & Deployment Guide

Complete installation instructions from zero to production.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Repository Structure](#2-repository-structure)
3. [Backend Setup — Python / FastAPI](#3-backend-setup--python--fastapi)
4. [Frontend Setup — Next.js 14](#4-frontend-setup--nextjs-14)
5. [Real-Time Data APIs — No Keys Required](#5-real-time-data-apis--no-keys-required)
6. [ML Model Weights (Optional)](#6-ml-model-weights-optional)
7. [PostgreSQL + PostGIS (Production)](#7-postgresql--postgis-production)
8. [Docker Compose — Full Stack](#8-docker-compose--full-stack)
9. [Running Tests](#9-running-tests)
10. [Production Deployment](#10-production-deployment)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Prerequisites

| Tool | Minimum Version | Check |
|---|---|---|
| Python | 3.11+ | `python3 --version` |
| Node.js | 18+ | `node --version` |
| npm | 9+ | `npm --version` |
| Git | any | `git --version` |
| Docker (optional) | 24+ | `docker --version` |

No API keys are required for the core real-time data pipeline. All seven environmental data APIs (Open-Elevation, Open-Meteo, SoilGrids, NASA POWER, GloFAS, OSM Overpass, NOAA formula) are free and key-free.

---

## 2. Repository Structure

```
ECO-3D/
├── frontend/        Next.js 14 app
├── backend/         FastAPI + AI pipeline
├── scripts/         ML training scripts
├── docker-compose.yml
├── .env.example
├── README.md
└── SETUP.md
```

---

## 3. Backend Setup — Python / FastAPI

### 3.1 Clone & create virtual environment

```bash
git clone https://github.com/your-org/eco-3d.git
cd eco-3d/backend

python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
```

### 3.2 Install dependencies

```bash
pip install -r requirements.txt
```

Key packages installed:

```
fastapi==0.110.0          uvicorn[standard]==0.29.0
sqlalchemy[asyncio]==2.0  aiosqlite==0.20.0
pydantic==2.7.0           python-jose[cryptography]==3.3.0
bcrypt==4.1.2             httpx==0.27.0
torch==2.3.0              torchvision==0.18.0
ultralytics==8.2.0        xgboost==2.0.3
python-multipart==0.0.9   sse-starlette==2.1.0
```

### 3.3 Configure environment

```bash
cp ../.env.example .env
```

Edit `.env`:

```env
# Required
DATABASE_URL=sqlite+aiosqlite:///./eco3d.db
SECRET_KEY=your-secret-here          # generate: openssl rand -hex 32

# Optional — defaults work without these
ACCESS_TOKEN_EXPIRE_MINUTES=1440
MAPBOX_TOKEN=                        # leave blank to use OSM tiles
WEIGHTS_DIR=training/weights         # path to ML model weights
```

### 3.4 Initialise database & run

```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

On first startup the app creates the SQLite database and all tables automatically. You should see:

```
INFO: Database tables created/verified
INFO: ECO-3D API v2.1.0 — real-time data mode active
INFO: Application startup complete.
INFO: Uvicorn running on http://0.0.0.0:8000
```

Verify: `curl http://localhost:8000/health` → `{"status":"ok","version":"2.1.0"}`

### 3.5 Backend dependencies explained

**Core real-time data fetching** — `httpx` (async HTTP client) with per-API timeout tuning:
- Open-Elevation: 12 s timeout (5-point DEM lookup)
- Open-Meteo Forecast: 12 s (real-time wind)
- Open-Meteo ERA5 Climate: 20 s (30-year monthly aggregation)
- SoilGrids ISRIC REST v2: 15 s (6 soil property layers)
- NASA POWER API: 20 s (365 daily observations)
- Open-Meteo GloFAS: 12 s (90-day discharge forecast)
- OSM Overpass: 14 s (spatial water feature query)

All calls fire concurrently via `asyncio.gather()`. Total Layer 2 latency is bounded by the slowest single API (~15–20 s worst case), not the sum.

---

## 4. Frontend Setup — Next.js 14

### 4.1 Install

```bash
cd frontend
npm install
```

### 4.2 Configure

```bash
# Minimum required
echo "NEXT_PUBLIC_API_URL=http://localhost:8000" > .env.local
```

Optional additions to `.env.local`:

```env
NEXT_PUBLIC_MAPBOX_TOKEN=pk.eyJ1...   # for satellite tile quality upgrade
NEXT_PUBLIC_APP_NAME=ECO-3D Studio
```

### 4.3 Run development server

```bash
npm run dev
```

Navigate to [http://localhost:3000](http://localhost:3000).

### 4.4 Build for production

```bash
npm run build
npm run start
```

---

## 5. Real-Time Data APIs — No Keys Required

All seven APIs used for environmental data are free and require no registration or API key. Here is what each does and how to verify it independently:

### Open-Elevation (SRTM 30m DEM)
Provides elevation in metres at any lat/lon. The pipeline queries 5 points (centre + N/S/E/W) to compute slope via the max rise-over-run.
```bash
curl "https://api.open-elevation.com/api/v1/lookup" \
  -H "Content-Type: application/json" \
  -d '{"locations":[{"latitude":10.0,"longitude":76.3}]}'
# → {"results":[{"elevation":14}]}
```

### Open-Meteo Forecast (Real-time wind)
Current wind speed (m/s) and direction (°) at 10 m above ground.
```bash
curl "https://api.open-meteo.com/v1/forecast?latitude=10&longitude=76.3&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&forecast_days=1"
```

### Open-Meteo Climate — ERA5 (30-year rainfall normals)
Monthly precipitation_sum aggregated to annual total (mm/yr).
```bash
curl "https://climate-api.open-meteo.com/v1/climate?latitude=10&longitude=76.3&start_date=1991-01-01&end_date=2020-12-31&monthly=precipitation_sum&models=ERA5"
```

### SoilGrids REST v2 — ISRIC / Wageningen University (soil profile)
Six soil properties at 0–5 cm depth: clay, sand, silt (g/kg), phh2o (pH×10), soc (dg/kg), bdod (cg/cm³). Resolution: 250 m global.
```bash
curl "https://rest.isric.org/soilgrids/v2.0/properties/query?lon=76.3&lat=10&property=clay&property=sand&property=silt&property=phh2o&property=soc&property=bdod&depth=0-5cm&value=mean"
```

SoilGrids unit conversions applied by the pipeline:
- `clay_pct = clay_raw / 10`   (g/kg → %)
- `soil_ph  = phh2o_raw / 10`  (pH×10 → pH)
- `org_carbon = soc_raw / 10`  (dg/kg → g/kg)
- `bulk_density = bdod_raw / 100` (cg/cm³ → g/cm³)

USDA Texture Triangle classification maps clay/sand/silt % to a texture name (Sandy Loam, Loam, Clay Loam, Clay, etc.) and a binary `soil_buildable` flag.

### NASA POWER API (NDVI proxy + solar radiation)
Daily shortwave radiation (ALLSKY_SFC_SW_DWN) and photosynthetically active radiation (CLRSKY_SFC_PAR_TOT) over the past 365 days. NDVI is estimated as: `FPAR = (avg_PAR × 0.45) / (avg_SW × 0.48)` → `NDVI ≈ FPAR × 0.72 + 0.05`.
```bash
curl "https://power.larc.nasa.gov/api/temporal/daily/point?parameters=ALLSKY_SFC_SW_DWN,CLRSKY_SFC_PAR_TOT&community=AG&longitude=76.3&latitude=10&start=20240101&end=20241231&format=JSON"
```

### Open-Meteo GloFAS — EU Copernicus (river discharge 90-day forecast)
River discharge (m³/s) forecast for 90 days. Peak and mean values mapped to a GloFAS flood index (0–1) via logarithmic thresholds. Returns null for plots far from any river system.
```bash
curl "https://flood-api.open-meteo.com/v1/flood?latitude=10&longitude=76.3&daily=river_discharge&forecast_days=90"
```

### OSM Overpass API (distance to water)
Queries rivers, streams, canals, wetlands, lakes within 5 km. Computes Haversine distance to nearest centroid.
```bash
curl -X POST "https://overpass-api.de/api/interpreter" \
  -d 'data=[out:json];way["waterway"~"^(river|stream)$"](9.95,76.25,10.05,76.35);out center;'
```

### NOAA Astronomical Formula (sun hours)
No network call. Computed from site latitude and Julian day number using the sunrise equation: `cos(hour_angle) = −tan(φ) × tan(δ)` where δ = 23.45° × sin(360/365 × (DOY − 81)).

---

## 6. ML Model Weights (Optional)

The physics-based `compute_flood_risk()` and `compute_buildability()` functions run without any ML weights and produce accurate results for real data. ML model weights provide an optional second opinion.

### 6.1 Directory structure

```
backend/training/weights/
├── flood_model.json            XGBoost booster (if trained)
└── buildability_model.pt       PyTorch MLP state dict (if trained)
```

### 6.2 Train flood model (XGBoost, ~10 seconds)

```bash
cd backend
python scripts/train_flood_model.py
```

Generates 2 000 physics-informed synthetic samples:
```python
P(flood) = 0.40 × max(0, 1 − elev/100)
         + 0.15 × max(0, 1 − slope/30)
         + 0.10 × max(0, (rain − 500)/2500)
         + 0.15 × max(0, 1 − NDVI)
         + 0.10 × max(0, 1 − dist_water/500)
         + 0.10 × soil_stability
         + ε,    ε ~ N(0, 0.05)
```

Expected output:
```
Training XGBoost flood model on 2000 synthetic samples...
  Train RMSE: 0.038   R²: 0.946
  Test  RMSE: 0.042   R²: 0.941
Model saved to training/weights/flood_model.json
```

### 6.3 Train buildability model (PyTorch MLP, ~30 seconds)

```bash
python scripts/train_buildability_model.py
```

Architecture: `Linear(6→64) → ReLU → Dropout(0.1) → Linear(64→128) → ReLU → Dropout(0.1) → Linear(128→64) → ReLU → Linear(64→1)`. Total params: 17 217.

Expected output:
```
Epoch 100/200  Loss: 38.42
Epoch 200/200  Loss: 14.87
Test MAE: 4.2 points   R²: 0.912
Model saved to training/weights/buildability_model.pt
```

### 6.4 Verify models load

```bash
python -c "
from ai.flood.model import predict_flood_probability
from ai.buildability.buildability_model import predict_buildability_score
print('Flood:', predict_flood_probability({'elevation':15,'slope':2,'rainfall_mm':2800,'ndvi':0.6,'clay_fraction':0.28,'distance_to_water_m':300}))
print('Build: OK')
"
```

---

## 7. PostgreSQL + PostGIS (Production)

### 7.1 Install PostgreSQL 16 + PostGIS 3.4

**Ubuntu/Debian:**
```bash
sudo apt install postgresql-16 postgresql-16-postgis-3 -y
```

**macOS (Homebrew):**
```bash
brew install postgresql@16 postgis
```

**Docker (recommended for production):**
```bash
docker run -d \
  --name eco3d-postgres \
  -e POSTGRES_DB=eco3d \
  -e POSTGRES_USER=eco3d \
  -e POSTGRES_PASSWORD=yourpassword \
  -p 5432:5432 \
  postgis/postgis:16-3.4
```

### 7.2 Create database

```bash
psql -U postgres -c "CREATE USER eco3d WITH PASSWORD 'yourpassword';"
psql -U postgres -c "CREATE DATABASE eco3d OWNER eco3d;"
psql -U eco3d -d eco3d -c "CREATE EXTENSION IF NOT EXISTS postgis;"
psql -U eco3d -d eco3d -c "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";"
```

### 7.3 Update .env

```env
DATABASE_URL=postgresql+asyncpg://eco3d:yourpassword@localhost:5432/eco3d
```

### 7.4 Run migrations

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
# Tables are created automatically on first startup via SQLAlchemy
```

---

## 8. Docker Compose — Full Stack

### 8.1 docker-compose.yml

```yaml
version: "3.9"

services:
  postgres:
    image: postgis/postgis:16-3.4
    environment:
      POSTGRES_DB: eco3d
      POSTGRES_USER: eco3d
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-eco3dpass}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U eco3d"]
      interval: 10s
      timeout: 5s
      retries: 5

  backend:
    build: ./backend
    environment:
      DATABASE_URL: postgresql+asyncpg://eco3d:${POSTGRES_PASSWORD:-eco3dpass}@postgres:5432/eco3d
      SECRET_KEY: ${SECRET_KEY}
      WEIGHTS_DIR: /app/training/weights
    ports:
      - "8000:8000"
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - ./backend/training:/app/training

  frontend:
    build: ./frontend
    environment:
      NEXT_PUBLIC_API_URL: http://backend:8000
      NEXT_PUBLIC_MAPBOX_TOKEN: ${MAPBOX_TOKEN:-}
    ports:
      - "3000:3000"
    depends_on:
      - backend

volumes:
  pgdata:
```

### 8.2 Launch

```bash
SECRET_KEY=$(openssl rand -hex 32) docker compose up --build -d
```

View logs:
```bash
docker compose logs -f backend
docker compose logs -f frontend
```

---

## 9. Running Tests

```bash
cd backend
pip install pytest pytest-asyncio httpx

# Run all tests
pytest tests/ -v

# Test real-data pipeline specifically
pytest tests/test_real_env_data.py -v

# Test with real API calls (slower, requires internet)
pytest tests/test_real_env_data.py -v -m "integration"
```

The test suite uses `pytest-asyncio` for async endpoint tests. API calls in unit tests are mocked with `httpx.MockTransport`; integration tests call live APIs.

---

## 10. Production Deployment

### 10.1 Backend — systemd service

```ini
# /etc/systemd/system/eco3d-backend.service
[Unit]
Description=ECO-3D FastAPI Backend
After=network.target postgresql.service

[Service]
Type=exec
User=eco3d
WorkingDirectory=/opt/eco3d/backend
EnvironmentFile=/opt/eco3d/.env
ExecStart=/opt/eco3d/backend/venv/bin/uvicorn main:app \
          --host 0.0.0.0 --port 8000 --workers 4
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now eco3d-backend
```

### 10.2 Frontend — PM2

```bash
cd frontend && npm run build
pm2 start npm --name eco3d-frontend -- start -- -p 3000
pm2 save && pm2 startup
```

### 10.3 Nginx reverse proxy with SSE support

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    # API + SSE
    location /api/ {
        proxy_pass http://127.0.0.1:8000/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # Critical for SSE (Server-Sent Events)
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_set_header Connection '';
        chunked_transfer_encoding on;
    }

    # Frontend
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
    }
}
```

### 10.4 Rate limiting for external APIs

The seven real-time APIs are free but have fair-use rate limits. For high-traffic production:

| API | Rate limit | Mitigation |
|---|---|---|
| Open-Elevation | ~1 req/s | Redis cache on (lat, lon) pairs |
| Open-Meteo | 10 000 req/day | Redis cache, 1-hr TTL |
| SoilGrids ISRIC | ~1 req/s | Redis cache, 24-hr TTL (soil data is stable) |
| NASA POWER | 1 000 req/day | Redis cache, 7-day TTL |
| Open-Meteo GloFAS | 10 000 req/day | Redis cache, 6-hr TTL |
| OSM Overpass | Fair use | Cache on bounding box |

Recommended caching layer: `redis-py` with `aioredis` for async cache lookups before each API call.

---

## 11. Troubleshooting

### Backend won't start: `ModuleNotFoundError: No module named 'torch'`
PyTorch is large (~2 GB). The system runs without it — the physics-based fallback is always available.
```bash
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
```

### SoilGrids returns 404 or empty data
Some remote locations have no SoilGrids coverage (e.g., open ocean, ice sheets). The latitude-calibrated fallback activates automatically. Check logs for `[SoilGrids] fallback`.

### GloFAS returns null / no discharge data
Expected for locations far from any river system (deserts, highlands). The pipeline uses the full topo model without GloFAS blending. Check logs for `[GloFAS] Fallback`.

### NASA POWER returns fill values (-999)
Occasionally happens at extreme latitudes or for recent dates not yet processed. The pipeline filters out fill values and uses the ecological fallback. Check logs for `[NASA POWER] failed`.

### Analysis takes > 30 seconds
One or more external APIs are slow. All calls have hard timeouts (12–20 s each). The `asyncio.gather()` runs all concurrently so total wall time equals the slowest single call, not the sum. If consistently slow, enable Redis caching.

### SSE stream disconnects immediately
Ensure Nginx has `proxy_buffering off` and `proxy_read_timeout 86400s`. Without this, Nginx buffers the stream and the browser never receives events.

### `Database is locked` (SQLite dev mode)
SQLite supports limited concurrent writes. Either restart the backend to clear connections, or switch to PostgreSQL for production.

### Frontend: `CORS error` calling backend
Ensure `NEXT_PUBLIC_API_URL` in `.env.local` exactly matches the backend origin including port. The FastAPI CORS middleware is configured for `http://localhost:3000` in development.
