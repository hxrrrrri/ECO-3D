# ECO-3D Studio — Complete Setup & Deployment Guide

> Comprehensive installation instructions from zero to production.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Repository Structure](#2-repository-structure)
3. [Backend Setup — Python / FastAPI](#3-backend-setup--python--fastapi)
4. [Frontend Setup — Next.js 14](#4-frontend-setup--nextjs-14)
5. [Real-Time Data APIs — No Keys Required](#5-real-time-data-apis--no-keys-required)
6. [ML Model Weights (Optional)](#6-ml-model-weights-optional)
7. [Training Scripts](#7-training-scripts)
8. [PostgreSQL + PostGIS (Production)](#8-postgresql--postgis-production)
9. [Docker Compose — Full Stack](#9-docker-compose--full-stack)
10. [Running Tests](#10-running-tests)
11. [Production Deployment](#11-production-deployment)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Prerequisites

| Tool | Minimum Version | Check Command |
|---|---|---|
| Python | 3.11+ | `python3 --version` |
| Node.js | 18+ | `node --version` |
| npm | 9+ | `npm --version` |
| Git | any | `git --version` |
| Docker | 24+ (optional) | `docker --version` |

**No API keys are required.** All seven environmental data APIs (Open-Elevation, Open-Meteo, SoilGrids, NASA POWER, GloFAS, OSM Overpass, NOAA formula) are free and keyless.

---

## 2. Repository Structure

```
ECO-3D/
├── frontend/           Next.js 14 app
├── backend/            FastAPI + AI pipeline
├── scripts/            ML training scripts
├── data/               Synthetic training datasets
├── .env.example        Environment variable template
├── README.md
├── SETUP.md
├── FIXES.md
└── ARCHITECTURE.md
```

---

## 3. Backend Setup — Python / FastAPI

### 3.1 Clone & Create Virtual Environment

```bash
git clone https://github.com/your-org/eco-3d.git
cd eco-3d/backend

python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
```

### 3.2 Install Dependencies

```bash
pip install -r requirements.txt
```

This installs the full stack including optional ML packages (PyTorch, XGBoost, Ultralytics). If you want a minimal install without ML packages:

```bash
# Minimal install — app runs with physics-based fallbacks
pip install fastapi uvicorn[standard] sqlalchemy[asyncio] aiosqlite \
            pydantic pydantic-settings python-dotenv httpx pillow numpy \
            python-jose[cryptography] bcrypt sse-starlette python-multipart
```

### 3.3 Configure Environment

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
MAPBOX_TOKEN=                        # leave blank to use free OSM tiles
WEIGHTS_DIR=training/weights         # path to ML model weights directory
```

### 3.4 Initialise Database & Run

```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

On first startup, SQLAlchemy creates the SQLite database file and all tables automatically. Expected output:

```
INFO:     Database tables created/verified
INFO:     ECO-3D backend ready
INFO:     Application startup complete.
INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)
```

Verify the health endpoint:

```bash
curl http://localhost:8000/health
# → {"status":"ok","version":"2.0.0"}
```

### 3.5 Backend Dependency Details

**Core async HTTP (`httpx`)** — Per-API timeout configuration:

| API | Timeout | Notes |
|---|---|---|
| Open-Elevation | 12 s | 5-point DEM lookup |
| Open-Meteo Forecast | 12 s | Real-time wind |
| Open-Meteo ERA5 Climate | 20 s | 30-year monthly aggregation |
| SoilGrids ISRIC REST v2 | 15 s | 6 soil property layers |
| NASA POWER API | 20 s | 365 daily observations |
| Open-Meteo GloFAS | 12 s | 90-day discharge forecast |
| OSM Overpass | 14 s | Spatial water feature query |

All calls run concurrently via `asyncio.gather()`. Total Layer 2 latency equals the slowest single API call (~15–20 s worst case), **not** the sum.

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
NEXT_PUBLIC_MAPBOX_TOKEN=pk.eyJ1...      # for high-res satellite tiles
NEXT_PUBLIC_APP_NAME=ECO-3D Studio
```

### 4.3 Development Server

```bash
npm run dev
```

Navigate to [http://localhost:3000](http://localhost:3000).

### 4.4 Production Build

```bash
npm run build
npm run start
```

---

## 5. Real-Time Data APIs — No Keys Required

### Open-Elevation (SRTM 30m DEM)

```bash
curl "https://api.open-elevation.com/api/v1/lookup" \
  -H "Content-Type: application/json" \
  -d '{"locations":[{"latitude":10.0,"longitude":76.3}]}'
# → {"results":[{"elevation":14}]}
```

### Open-Meteo Forecast (Real-time wind)

```bash
curl "https://api.open-meteo.com/v1/forecast?latitude=10&longitude=76.3&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&forecast_days=1"
```

### Open-Meteo Climate — ERA5 (30-year rainfall normals)

```bash
curl "https://climate-api.open-meteo.com/v1/climate?latitude=10&longitude=76.3&start_date=1991-01-01&end_date=2020-12-31&monthly=precipitation_sum&models=ERA5"
```

### SoilGrids REST v2 — ISRIC / Wageningen University

```bash
curl "https://rest.isric.org/soilgrids/v2.0/properties/query?lon=76.3&lat=10&property=clay&property=sand&property=silt&property=phh2o&property=soc&property=bdod&depth=0-5cm&value=mean"
```

**Unit conversions applied by pipeline:**
- `clay_pct = clay_raw / 10` (g/kg → %)
- `soil_ph  = phh2o_raw / 10` (pH×10 → pH)
- `org_carbon = soc_raw / 10` (dg/kg → g/kg)
- `bulk_density = bdod_raw / 100` (cg/cm³ → g/cm³)

### NASA POWER API (NDVI proxy + solar radiation)

```bash
curl "https://power.larc.nasa.gov/api/temporal/daily/point?parameters=ALLSKY_SFC_SW_DWN,CLRSKY_SFC_PAR_TOT&community=AG&longitude=76.3&latitude=10&start=20240101&end=20241231&format=JSON"
```

NDVI proxy calculation:
```python
FPAR  = (avg_PAR × 0.45) / (avg_SW × 0.48)
NDVI ≈ FPAR × 0.72 + 0.05
```

### Open-Meteo GloFAS — EU Copernicus (river discharge)

```bash
curl "https://flood-api.open-meteo.com/v1/flood?latitude=10&longitude=76.3&daily=river_discharge&forecast_days=90"
```

### OSM Overpass API (distance to water)

```bash
curl -X POST "https://overpass-api.de/api/interpreter" \
  -d 'data=[out:json];way["waterway"~"^(river|stream)$"](9.95,76.25,10.05,76.35);out center;'
```

### NOAA Astronomical Formula (sun hours)

No network call. Computed from site latitude and Julian day number:

```python
decl   = 23.45 × sin(360/365 × (DOY − 81))    # declination degrees
cos_ha = −tan(φ) × tan(decl)                   # hour angle cosine
sun_h  = 2 × acos(cos_ha) / 15                 # hours of daylight
```

---

## 6. ML Model Weights (Optional)

The physics-based `compute_flood_risk()` and `compute_buildability()` functions produce accurate results without any ML weights. ML weights provide a second opinion / hybrid output.

### Directory Structure

```
backend/
├── ai/
│   ├── flood/weights/
│   │   ├── flood_xgboost.pkl
│   │   ├── flood_model.pkl
│   │   └── flood_metrics.json
│   └── buildability/weights/
│       ├── buildability_mlp.pkl
│       ├── buildability_model.pkl
│       └── buildability_metrics.json
└── training/weights/
    ├── flood_xgboost.pkl       (symlink / copy)
    └── buildability_mlp.pkl    (symlink / copy)
```

Pre-trained weights **are included** in the repository at `backend/ai/flood/weights/` and `backend/ai/buildability/weights/`.

### Verify Models Load

```bash
cd backend
python -c "
from ai.flood.model import predict_flood_probability
print('Flood model OK')
from ai.buildability.buildability_model import BuildabilityModel
print('Buildability model OK')
"
```

---

## 7. Training Scripts

Training scripts are located in `scripts/`. Run from the project root.

### Prerequisites

```bash
pip install -r scripts/requirements_training.txt
# or: pip install xgboost scikit-learn torch numpy pandas matplotlib
```

### Train Flood Model (XGBoost, ~10 seconds)

```bash
python scripts/train_flood_model.py
# optional: python scripts/train_flood_model.py --samples 5000 --estimators 300
```

Expected output:

```
Training XGBoost flood model on 2000 synthetic samples...
  Train RMSE: 0.038   R²: 0.946
  Test  RMSE: 0.042   R²: 0.941
Model saved → backend/ai/flood/weights/flood_xgboost.pkl
Metrics → backend/ai/flood/weights/flood_metrics.json
```

Physics-informed synthetic data generation formula:

```python
P(flood) = 0.40 × max(0, 1 − elev/100)
         + 0.15 × max(0, 1 − slope/30)
         + 0.10 × max(0, (rain − 500)/2500)
         + 0.15 × max(0, 1 − NDVI)
         + 0.10 × max(0, 1 − dist_water/500)
         + 0.10 × soil_stability
         + ε,    ε ~ N(0, 0.05)
```

### Train Buildability Model (PyTorch MLP, ~30 seconds)

```bash
python scripts/train_buildability_model.py
# optional: python scripts/train_buildability_model.py --samples 5000 --epochs 300 --plot
```

Architecture: `Linear(6→64) → ReLU → Dropout(0.1) → Linear(64→128) → ReLU → Dropout(0.1) → Linear(128→64) → ReLU → Linear(64→1)` — Total: 17,217 parameters.

Expected output:

```
Epoch 100/200  Loss: 38.42
Epoch 200/200  Loss: 14.87
Test MAE: 4.2 points   R²: 0.912
Model saved → backend/ai/buildability/weights/buildability_mlp.pkl
```

### Evaluate All Models

```bash
python scripts/evaluate_models.py
```

---

## 8. PostgreSQL + PostGIS (Production)

### Install PostgreSQL 16 + PostGIS 3.4

**Ubuntu/Debian:**
```bash
sudo apt install postgresql-16 postgresql-16-postgis-3 -y
```

**macOS (Homebrew):**
```bash
brew install postgresql@16 postgis
```

**Docker (recommended):**
```bash
docker run -d \
  --name eco3d-postgres \
  -e POSTGRES_DB=eco3d \
  -e POSTGRES_USER=eco3d \
  -e POSTGRES_PASSWORD=yourpassword \
  -p 5432:5432 \
  postgis/postgis:16-3.4
```

### Create Database

```bash
psql -U postgres -c "CREATE USER eco3d WITH PASSWORD 'yourpassword';"
psql -U postgres -c "CREATE DATABASE eco3d OWNER eco3d;"
psql -U eco3d -d eco3d -c "CREATE EXTENSION IF NOT EXISTS postgis;"
psql -U eco3d -d eco3d -c "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";"
```

### Update .env

```env
DATABASE_URL=postgresql+asyncpg://eco3d:yourpassword@localhost:5432/eco3d
```

Tables are created automatically on first startup via SQLAlchemy `create_all()`.

---

## 9. Docker Compose — Full Stack

```yaml
# docker-compose.yml (place in project root)
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

**Launch:**
```bash
SECRET_KEY=$(openssl rand -hex 32) docker compose up --build -d
docker compose logs -f backend
```

---

## 10. Running Tests

```bash
cd backend
pip install pytest pytest-asyncio httpx

# All tests
pytest tests/ -v

# Unit tests only (mocked APIs)
pytest tests/ -v -m "not integration"

# Integration tests (live API calls, slower)
pytest tests/ -v -m "integration"
```

---

## 11. Production Deployment

### Backend — systemd Service

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

### Frontend — PM2

```bash
cd frontend && npm run build
pm2 start npm --name eco3d-frontend -- start -- -p 3000
pm2 save && pm2 startup
```

### Nginx with SSE Support

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    # API + SSE streams
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

### API Rate Limits & Caching Recommendations

| API | Free Rate Limit | Recommended Cache TTL |
|---|---|---|
| Open-Elevation | ~1 req/s | 24 hr (terrain is static) |
| Open-Meteo Forecast | 10,000 req/day | 1 hr |
| Open-Meteo ERA5 | 10,000 req/day | 7 days (climatology) |
| SoilGrids ISRIC | ~1 req/s | 30 days (soil is stable) |
| NASA POWER | 1,000 req/day | 7 days |
| Open-Meteo GloFAS | 10,000 req/day | 6 hr |
| OSM Overpass | Fair use | 24 hr |

Recommended caching layer: `aioredis` async Redis client with per-API TTL keyed on `(lat, lon)`.

---

## 12. Troubleshooting

**`ModuleNotFoundError: No module named 'torch'`**
PyTorch (~2 GB) is optional. The system runs without it.
```bash
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
```

**SoilGrids returns 404 or empty data**
Expected for open ocean, ice sheets, or extreme coordinates. The latitude-calibrated fallback activates automatically. Check logs for `[SoilGrids] fallback`.

**GloFAS returns null / no discharge data**
Expected for locations far from any river (deserts, highlands). The full topo model is used without GloFAS blending. Look for `[GloFAS] Fallback` in logs.

**NASA POWER returns fill values (-999)**
Occurs at extreme latitudes or for future dates not yet processed. The pipeline filters fill values. Check logs for `[NASA POWER] failed`.

**Analysis takes > 30 seconds**
One or more APIs are slow. All calls have hard timeouts (12–20 s). Total time = slowest single call. Enable Redis caching for repeated coordinates.

**SSE stream disconnects immediately**
Nginx must have `proxy_buffering off` and `proxy_read_timeout 86400s`. Without these, Nginx buffers the stream and the browser never receives events.

**`Database is locked` (SQLite dev mode)**
SQLite has limited concurrent write support. Restart the backend to clear connections, or switch to PostgreSQL.

**Frontend: `CORS error` calling backend**
Ensure `NEXT_PUBLIC_API_URL` in `.env.local` exactly matches the backend origin including port number. The FastAPI CORS middleware allows `"*"` in development.

**Plot IDs with special characters break routing**
Plot IDs are generated as `PLOT{abs_lat_int}X{abs_lon_int}` to avoid double-dashes from negative coordinates. If you see routing errors, check for legacy IDs using the old `PLOT-{lat}-{lon}` format.
