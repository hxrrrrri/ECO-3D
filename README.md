# ECO-3D Studio — AI-Generative Sustainable Architecture Platform

> **End-to-end sustainable land development intelligence** — from a single map click to a fully rendered, interactive 3D floor plan, powered by real-time satellite and public-API environmental data and a five-layer AI pipeline.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Key Features](#2-key-features)
3. [System Architecture](#3-system-architecture)
4. [Five-Layer AI Pipeline](#4-five-layer-ai-pipeline)
5. [Real-Time Data Sources](#5-real-time-data-sources)
6. [Flood Risk & Buildability Formulas](#6-flood-risk--buildability-formulas)
7. [Technology Stack](#7-technology-stack)
8. [Project Structure](#8-project-structure)
9. [Installation — Quick Start](#9-installation--quick-start)
10. [Usage Guide](#10-usage-guide)
11. [API Reference](#11-api-reference)
12. [Database Schema](#12-database-schema)
13. [Environment Variables](#13-environment-variables)
14. [AnalysisResponse Field Reference](#14-analysisresponse-field-reference)
15. [Dependencies](#15-dependencies)
16. [Future Improvements](#16-future-improvements)

---

## 1. Project Overview

ECO-3D Studio transforms any geographic coordinate into a comprehensive sustainable development assessment in seconds. It is a full-stack platform comprising:

- A **Next.js 14 / React 18** frontend with interactive Leaflet maps, animated SVG floor plans, and Three.js WebGL 3D models.
- A **FastAPI / Python 3.11** backend that orchestrates seven concurrent real-time API calls and a five-stage AI inference pipeline.
- A **SQLite (dev) / PostgreSQL + PostGIS (prod)** persistence layer for users, plots, analyses, and floor plans.

The workflow is: **Click map → detect cadastral boundary → fetch 7 APIs concurrently → run 5 AI layers → render 2D floor plan + interactive 3D model → generate regulatory report.**

Every external API call has a deterministic physics-based fallback. The system is designed to never return HTTP 500.

---

## 2. Key Features

| Feature | Description |
|---|---|
| **Real-time environmental data** | 7 simultaneous API calls: elevation (SRTM), wind (Open-Meteo), rainfall (ERA5), soil profile (SoilGrids ISRIC), NDVI+solar (NASA POWER), river discharge (GloFAS EU Copernicus), water proximity (OSM Overpass) |
| **Satellite segmentation** | DeepLabV3 + ResNet-50 performs pixel-wise land cover classification into 6 classes (vegetation, water, urban, bare land, agriculture, forest) |
| **Tree canopy detection** | YOLOv8n detects individual tree bounding boxes on satellite tiles and back-projects detections to geo-coordinates |
| **Flood risk scoring** | Blended model: 70% topographic physics + 30% GloFAS hydrological data, clamped to [0.01, 0.97] |
| **Buildability assessment** | Physics model integrating 6 SoilGrids properties, NDVI, wind load, solar access, elevation zones — optionally supplemented by a PyTorch MLP |
| **Genetic algorithm floor plan** | 80-generation, 60-population GA optimising sunlight (35%), ventilation (25%), structural integrity (25%), and tree preservation (15%) |
| **Interactive 3D viewer** | Three.js open-top 3D model with procedural canvas textures, real wind/solar overlays, camera presets, and edit mode |
| **Regulatory reporting** | Auto-generated reports citing FEMA, LEED BD+C v4, ASHRAE 55, SoilGrids, GloFAS, NASA POWER |
| **Deterministic fallbacks** | Every API and ML call has a seeded-random physics fallback — the platform never crashes |
| **SSE progress streaming** | Server-Sent Events push pipeline progress to the browser in real time |

---

## 3. System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  BROWSER  —  Next.js 14 App Router (React 18 + TypeScript)          │
│                                                                     │
│  /map           /analysis/[id]        /floorplan    /model3d        │
│  Leaflet        ┌──────────────────┐  SVG layout   Three.js WebGL   │
│  OSM + Mapbox   │ Plot Scores      │  GA metrics   Open-top viewer  │
│  Cadastral      │ Topography       │               Real wind/sun    │
│  boundary       │ Climate (live)   │               overlays         │
│                 │ Soil — SoilGrids │                                │
│                 │ River — GloFAS   │                                │
│                 └──────────────────┘                                │
│        Zustand global state: JWT · plot · AnalysisResponse         │
└─────────────────────────────┬───────────────────────────────────────┘
                HTTP/JSON + JWT Bearer + SSE EventSource
┌─────────────────────────────▼───────────────────────────────────────┐
│  FASTAPI BACKEND  (Python 3.11, Uvicorn ASGI)                       │
│                                                                     │
│  POST /analyze-plot → analysis_pipeline.py                         │
│    asyncio.gather():                                                │
│      Layer 1A  DeepLabV3 segmentation (OSM satellite tile)         │
│      Layer 1B  YOLOv8n tree detection (geo-projected bbox)         │
│      Layer 2   real_env_data.fetch_all_real_data()                 │
│                  ├ fetch_elevation_slope()  ← Open-Elevation SRTM  │
│                  ├ fetch_wind()             ← Open-Meteo           │
│                  ├ fetch_rainfall()         ← ERA5 Climate         │
│                  ├ fetch_soil_data()        ← SoilGrids v2 ISRIC   │
│                  ├ fetch_ndvi_and_solar()   ← NASA POWER           │
│                  ├ fetch_flood_discharge()  ← GloFAS EU Copernicus │
│                  └ fetch_distance_to_water()← OSM Overpass         │
│    Layer 3  compute_flood_risk()  (topo×0.70 + GloFAS×0.30)       │
│    Layer 4  compute_buildability() (soil+env physics + MLP)        │
│    SQLAlchemy async → persist raw_features JSONB                   │
│    SSE EventSourceResponse → browser progress stream               │
│                                                                     │
│  POST /generate-floorplan → genetic.py (80 gen, pop 60)            │
└──────────────────┬──────────────────┬───────────────────────────────┘
                   │                  │
     ┌─────────────▼───┐    ┌─────────▼──────────────────────────┐
     │  EXTERNAL APIs  │    │  DATABASE                          │
     │  Open-Elevation │    │  SQLite (dev) / PostgreSQL (prod)  │
     │  Open-Meteo     │    │  users · plots · analyses          │
     │  ERA5 Climate   │    │  floorplans · notifications        │
     │  SoilGrids ISRIC│    │  raw_features JSONB (all 20 env   │
     │  NASA POWER     │    │  fields stored per analysis)       │
     │  GloFAS         │    └────────────────────────────────────┘
     │  OSM Overpass   │
     └─────────────────┘
```

---

## 4. Five-Layer AI Pipeline

### Layer 1A — Semantic Segmentation (DeepLabV3 + ResNet-50)
**File:** `backend/ai/segmentation/segmenter.py`

DeepLabV3 with a ResNet-50 backbone performs pixel-wise semantic segmentation on an OSM satellite tile fetched at zoom 18 (~0.6 m/pixel), resized to 512×512 and normalised with ImageNet statistics (mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]).

Atrous Spatial Pyramid Pooling (ASPP) with dilation rates 1, 6, 12, and 18 captures multi-scale context without resolution loss. The pretrained COCO 21-class output is remapped to the platform's 6 eco-relevant classes:

| ECO-3D Class | COCO Source Classes |
|---|---|
| `vegetation` | plant, potted plant |
| `bare_land` | background (default) |
| `water` | boat, sky (proxy) |
| `urban` | person, car |
| `agriculture` | — (via spatial heuristics) |
| `forest` | — (via spatial heuristics) |

Output: per-class pixel-area percentage dictionary.

### Layer 1B — Tree Canopy Detection (YOLOv8n)
**File:** `backend/ai/detection/tree_detector.py`

YOLOv8 nano (conf=0.35, IoU=0.45) detects individual tree bounding boxes on the same satellite tile. Pixel centres are reverse-projected to lat/lon using Mercator tile mathematics:

```
lat = lat_max − (py / tile_size) × (lat_max − lat_min)
lon = lon_min + (px / tile_size) × (lon_max − lon_min)
```

Canopy radius is estimated from bounding box width × tile width in metres. Trees with radius > 5 m are flagged **protected** and passed to the Genetic Algorithm as spatial exclusion constraints.

### Layer 2 — Real-Time Environmental Feature Engineering
**File:** `backend/services/real_env_data.py`

Seven concurrent async API calls via `asyncio.gather()`. Each call is wrapped in an independent try/except with a seeded-random deterministic fallback, so no single API failure can block the pipeline.

| Function | API Endpoint | Key Outputs |
|---|---|---|
| `fetch_elevation_slope()` | Open-Elevation (5-pt SRTM) | elevation (m), slope (°) |
| `fetch_wind()` | Open-Meteo Forecast | speed (m/s), 16-pt compass direction |
| `fetch_rainfall()` | Open-Meteo ERA5 Climate | annual mm (30-yr 1991–2020 normal) |
| `fetch_soil_data()` | SoilGrids REST v2 ISRIC | clay/sand/silt %, pH, organic carbon, bulk density, USDA texture |
| `fetch_ndvi_and_solar()` | NASA POWER API | NDVI proxy (0–0.9), solar kWh/m²/day |
| `fetch_flood_discharge()` | Open-Meteo GloFAS | peak/mean discharge m³/s, flood index (0–1) |
| `fetch_distance_to_water()` | OSM Overpass | metres to nearest river/lake/wetland |

**SoilGrids unit conversions:**
- `clay_pct = clay_raw / 10` (g/kg → %)
- `soil_ph = phh2o_raw / 10` (pH×10 → pH)
- `org_carbon = soc_raw / 10` (dg/kg → g/kg)
- `bulk_density = bdod_raw / 100` (cg/cm³ → g/cm³)

**NASA POWER NDVI proxy formula:**
```
FPAR  = (avg_PAR × 0.45) / (avg_SW × 0.48)
NDVI ≈ FPAR × 0.72 + 0.05
```
Computed from 365 days of daily shortwave (ALLSKY_SFC_SW_DWN) and PAR (CLRSKY_SFC_PAR_TOT).

### Layer 3 — Blended Flood Risk Score
**File:** `backend/services/real_env_data.py → compute_flood_risk()`

```
When GloFAS data is available:
  flood_risk = 0.70 × topo_model + 0.30 × glofas_index

  topo_model = 0.42 × elev_risk
             + 0.20 × slope_risk
             + 0.16 × rain_risk
             + 0.13 × clay_risk
             + 0.09 × water_risk
```
Output clamped to [0.01, 0.97]. See Section 6 for full formulas.

### Layer 4 — Buildability Score (Physics + Optional MLP)
**File:** `backend/services/real_env_data.py → compute_buildability()`

Composite score ∈ [1, 99] integrating six real SoilGrids properties, NDVI, wind, solar, and elevation penalties. An optional PyTorch MLP (6→64→128→64→1, 17,217 parameters) supplements the physics model when trained weights are present.

### Layer 5 — Genetic Algorithm Floor Plan Optimisation
**File:** `backend/ai/floorplan/genetic.py`

| Parameter | Value |
|---|---|
| Population | 60 chromosomes |
| Generations | 80 |
| Mutation rate | 0.20 |
| Elite fraction | 33% |
| Fitness weights | Sunlight 35%, Ventilation 25%, Structural 25%, Tree 15% |

Real wind direction from Open-Meteo is fed into the ventilation fitness score targeting a NW–SE cross-ventilation axis (315°) for maximum natural airflow.

---

## 5. Real-Time Data Sources

All data is fetched live on every analysis request. No API keys are required.

| Data | API / Source | Resolution | Key? |
|---|---|---|---|
| Elevation (m) | Open-Elevation — SRTM | 30 m global | No |
| Slope (°) | 5-point DEM stencil | Per-point | No |
| Wind speed (m/s) | Open-Meteo Forecast | Real-time global | No |
| Wind direction | Open-Meteo Forecast | 16-point compass | No |
| Annual rainfall (mm/yr) | Open-Meteo Climate — ERA5 | 30-yr normals | No |
| Soil texture (USDA class) | SoilGrids REST v2 (ISRIC) | 250 m global | No |
| Clay / Sand / Silt % | SoilGrids REST v2 | 0–5 cm depth | No |
| Soil pH | SoilGrids REST v2 | 0–5 cm depth | No |
| Organic carbon (g/kg) | SoilGrids REST v2 | 0–5 cm depth | No |
| Bulk density (g/cm³) | SoilGrids REST v2 | 0–5 cm depth | No |
| NDVI (vegetation index) | NASA POWER API | Daily satellite | No |
| Solar radiation (kWh/m²/day) | NASA POWER API | Daily global | No |
| River discharge (m³/s) | Open-Meteo GloFAS (EU Copernicus) | 90-day forecast | No |
| GloFAS flood index (0–1) | Open-Meteo GloFAS | Derived | No |
| Distance to water (m) | OSM Overpass API | 5 km radius | No |
| Sun hours/day | NOAA astronomical formula | Exact (no I/O) | No |
| Plot boundary polygon | OSM Overpass — cadastral | Real parcel data | No |

---

## 6. Flood Risk & Buildability Formulas

### Flood Risk — Blended Topo + GloFAS Model

```
flood_risk = 0.70 × topo_model + 0.30 × glofas_index   [when GloFAS available]

topo_model = 0.42 × elev_risk
           + 0.20 × slope_risk
           + 0.16 × rain_risk
           + 0.13 × clay_risk
           + 0.09 × water_risk

where:
  elev_risk  = max(0, 1 − elevation / 80)
  slope_risk = max(0, 1 − slope / 12)
  rain_risk  = clip((rainfall − 300) / 2700, 0, 1)
  clay_risk  = clay_pct / 100
  water_risk = max(0, 1 − dist_water / 400)
```

### Buildability Score (Physics Model)

```
score = 100.0
  − flood_risk × 38
  − min(slope, 35) × 0.85
  − 50   if USDA class is Heavy Clay (≥55%) or Peat/Mud
  − (clay_pct − 35) × 0.4   [progressive penalty for clay > 35%]
  − 5    if soil_ph < 5.0 or > 8.5
  − 8    if bulk_density < 1.0 g/cm³
  − 4    if bulk_density > 1.8 g/cm³
  + ndvi × 8
  + min(sun_hours, 14) × 1.2
  − min(wind_ms, 15) × 0.5
  − 20   if elevation < 3 m
  − 10   if elevation < 10 m
  − 5    if elevation > 800 m
  − 10   if elevation > 1200 m

Clamped to [1, 99].
```

### Buildability Status Thresholds

| Score | Status | Description |
|---|---|---|
| ≥ 80 | EXCELLENT | Highly suitable |
| 60–79 | GOOD | Suitable with standard construction |
| 40–59 | FAIR | Engineering interventions required |
| 30–39 | POOR | High-risk site |
| < 30 | NOT BUILDABLE | Unsuitable |

---

## 7. Technology Stack

### Frontend
| Component | Technology |
|---|---|
| Framework | Next.js 14 (App Router) |
| Language | TypeScript |
| UI | React 18, Tailwind CSS, Framer Motion |
| State | Zustand |
| 3D | React Three Fiber, Drei, Three.js r167 |
| Maps | React-Leaflet 4, Leaflet GeoSearch |
| HTTP | Axios + JWT interceptor |

### Backend
| Component | Technology |
|---|---|
| Framework | FastAPI 0.111+ |
| Server | Uvicorn ASGI |
| Concurrency | Python AsyncIO + run_in_executor |
| Auth | JWT (python-jose) + bcrypt |
| ORM | SQLAlchemy 2.0 async |
| Validation | Pydantic v2 |
| Real-time | Starlette SSE (EventSourceResponse) |
| HTTP Client | httpx (async, per-API timeouts) |

### AI / ML
| Model | Framework | Purpose |
|---|---|---|
| DeepLabV3 + ResNet-50 | PyTorch / Torchvision | Satellite land-cover segmentation |
| YOLOv8n | Ultralytics | Tree canopy detection |
| Physics flood model | Pure Python | Blended topo + GloFAS scoring |
| Physics buildability | Pure Python | Real soil + env scoring |
| MLP (6→64→128→64→1) | PyTorch (optional) | Supplemental buildability regression |
| XGBoost | XGBoost (optional) | Supplemental flood regression |
| Genetic Algorithm | Pure Python | Floor plan spatial optimisation |

### Infrastructure
| Component | Technology |
|---|---|
| Database (dev) | SQLite + aiosqlite |
| Database (prod) | PostgreSQL 16 + PostGIS 3.4 |
| Containerisation | Docker + Docker Compose |

---

## 8. Project Structure

```
ECO-3D/
├── frontend/
│   ├── app/
│   │   ├── page.tsx                     ← Landing / home page
│   │   ├── map/page.tsx                 ← Leaflet map + plot selection
│   │   ├── analysis/[id]/page.tsx       ← 5-panel real-data dashboard
│   │   ├── floorplan/[id]/page.tsx      ← GA floor plan + 2D canvas viewer
│   │   ├── model3d/[id]/page.tsx        ← Three.js open-top 3D viewer
│   │   ├── report/[id]/page.tsx         ← Regulatory PDF report
│   │   ├── login/page.tsx
│   │   ├── signup/page.tsx
│   │   ├── insights/page.tsx
│   │   ├── registry/page.tsx
│   │   ├── docs/page.tsx
│   │   ├── product/page.tsx
│   │   └── solutions/page.tsx
│   ├── components/
│   │   ├── MapComponent.tsx             ← Leaflet wrapper component
│   │   └── Notifications.tsx            ← SSE notification feed
│   ├── lib/
│   │   └── api.ts                       ← Axios client + typed API calls
│   ├── store/
│   │   └── useEco3DStore.ts             ← Zustand global state
│   ├── next.config.js
│   ├── tailwind.config.js
│   └── package.json
│
├── backend/
│   ├── main.py                          ← FastAPI app + CORS + lifespan
│   ├── config.py                        ← Settings (DATABASE_URL, SECRET_KEY …)
│   ├── requirements.txt
│   ├── ai/
│   │   ├── segmentation/
│   │   │   ├── segmenter.py             ← DeepLabV3 inference + tile fetch
│   │   │   └── model.py                 ← Model loader wrapper
│   │   ├── detection/
│   │   │   ├── tree_detector.py         ← YOLOv8n inference + geo-projection
│   │   │   └── model.py
│   │   ├── floorplan/
│   │   │   ├── genetic.py               ← GA chromosome / fitness / evolution
│   │   │   └── genetic_optimizer.py     ← High-level GA orchestrator
│   │   ├── flood/
│   │   │   ├── flood_model.py           ← XGBoost flood risk (optional)
│   │   │   └── model.py
│   │   ├── buildability/
│   │   │   ├── buildability_model.py    ← PyTorch MLP buildability (optional)
│   │   │   └── model.py
│   │   ├── environmental/
│   │   │   └── feature_extractor.py
│   │   └── features/
│   │       └── extractor.py
│   ├── services/
│   │   ├── real_env_data.py             ← 7 real API fetches + physics formulas
│   │   ├── analysis_pipeline.py         ← 5-layer orchestrator
│   │   ├── floorplan_service.py         ← Floor plan business logic
│   │   ├── plot_boundary.py             ← OSM cadastral boundary detection
│   │   └── legal_verification.py        ← Zoning / flood zone checks
│   ├── routes/
│   │   ├── analysis.py                  ← POST /analyze-plot
│   │   ├── floorplan.py                 ← POST /generate-floorplan
│   │   ├── boundary.py                  ← GET /plot-boundary
│   │   ├── plots.py                     ← GET/POST /plots
│   │   ├── report.py                    ← GET /report/{id}
│   │   ├── auth.py                      ← POST /auth/signup, /auth/login
│   │   ├── notifications.py             ← GET /notifications/stream (SSE)
│   │   └── land_records.py
│   ├── models/
│   │   ├── schemas.py                   ← Pydantic v2 request/response models
│   │   └── db_models.py
│   └── database/
│       ├── connection.py                ← SQLAlchemy engine + init_db()
│       ├── models.py                    ← ORM table definitions
│       └── session.py                   ← Async session factory
│
├── scripts/
│   ├── generate_synthetic_data.py       ← Training data generator
│   ├── train_flood_model.py             ← XGBoost training script
│   ├── train_buildability_model.py      ← PyTorch MLP training script
│   ├── train_segmentation_model.py      ← Segmentation fine-tuning scaffold
│   ├── evaluate_models.py               ← Model evaluation suite
│   └── requirements_training.txt
│
├── data/
│   ├── flood_training.csv               ← 2000-sample synthetic flood dataset
│   ├── buildability_training.csv        ← 3000-sample buildability dataset
│   └── segmentation_labels.csv
│
├── .env.example
├── README.md
├── SETUP.md
├── FIXES.md
└── ARCHITECTURE.md
```

---

## 9. Installation — Quick Start

### Prerequisites

| Tool | Minimum Version |
|---|---|
| Python | 3.11+ |
| Node.js | 18+ |
| npm | 9+ |
| Git | any |
| Docker | 24+ (optional) |

### Backend

```bash
git clone https://github.com/your-org/eco-3d.git
cd eco-3d/backend

python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp ../.env.example .env
# Edit .env — set SECRET_KEY to: $(openssl rand -hex 32)

uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend

```bash
cd frontend
npm install
echo "NEXT_PUBLIC_API_URL=http://localhost:8000" > .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## 10. Usage Guide

### Step 1 — Map (`/map`)
Full-screen Leaflet + Mapbox satellite map. Click any point to auto-detect its cadastral parcel boundary via OSM Overpass. A panel shows boundary coordinates and area. Click **Analyse Plot** to begin.

### Step 2 — Analysis (`/analysis/[id]`)
The 5-panel real-data dashboard displays:
- **Plot Scores** — Buildability (0–100) and Flood Risk (0–100%)
- **Topography** — Elevation (m), Slope (°), Distance to water (m)
- **Climate** — ERA5 rainfall, Open-Meteo wind, NOAA sun hours, NASA solar, NASA NDVI
- **Soil Profile** — USDA texture, Clay/Sand/Silt %, pH, Organic carbon, Bulk density
- **River Flood** — GloFAS discharge (m³/s), flood index

### Step 3 — Floor Plan (`/floorplan/[id]`)
2D SVG floor plan generated by the genetic algorithm. Displays fitness score, sunlight score, ventilation score, tree preservation, and optimal building orientation.

### Step 4 — 3D Model (`/model3d/[id]`)
Interactive Three.js open-top 3D model. Walls extruded to 3.2 m. Camera presets: Isometric, Top-Down, Interior. Edit mode for material/texture customisation.

### Step 5 — Report (`/report/[id]`)
Full regulatory report with all real-time data, compliance citations, and development recommendations.

---

## 11. API Reference

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/auth/signup` | — | Create account |
| POST | `/auth/login` | — | Get JWT token |
| GET | `/auth/me` | Bearer | Current user profile |
| POST | `/analyze-plot` | Bearer | Full 5-layer analysis |
| POST | `/generate-floorplan` | Bearer | GA floor plan generation |
| GET | `/plot-boundary` | — | OSM cadastral boundary + area |
| GET | `/legal-verify` | — | Zoning, flood zone, seismic data |
| GET | `/plots` | Bearer | User's saved plots |
| GET | `/report/{plot_id}` | Bearer | Full regulatory report |
| GET | `/notifications/stream` | Bearer | SSE real-time progress |
| GET | `/health` | — | `{"status":"ok","version":"2.0.0"}` |

---

## 12. Database Schema

```sql
CREATE TABLE users (
    id          VARCHAR(36) PRIMARY KEY,   -- UUID string (SQLite) / UUID (PostgreSQL)
    email       VARCHAR(255) UNIQUE NOT NULL,
    password    VARCHAR(255) NOT NULL,
    name        VARCHAR(255),
    created_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE analyses (
    id                  VARCHAR(36) PRIMARY KEY,
    plot_id             VARCHAR(64) NOT NULL,
    segmentation_mask   JSONB,
    tree_coordinates    JSONB,
    ndvi                FLOAT,
    slope               FLOAT,
    elevation           FLOAT,
    rainfall_mm         FLOAT,
    soil_type           VARCHAR(64),
    wind_direction      VARCHAR(16),
    sun_exposure_hours  FLOAT,
    flood_probability   FLOAT,
    buildability_score  FLOAT,
    raw_features        JSONB,    -- all 20 extended env fields
    created_at          TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_analyses_plot_id     ON analyses(plot_id);
CREATE INDEX idx_analyses_buildability ON analyses(buildability_score);
CREATE INDEX idx_analyses_flood       ON analyses(flood_probability);

CREATE TABLE floorplans (
    id          VARCHAR(36) PRIMARY KEY,
    plot_id     VARCHAR(64),
    rooms       JSONB,
    created_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE notifications (
    id          VARCHAR(36) PRIMARY KEY,
    user_id     VARCHAR(36),
    message     TEXT,
    read        BOOLEAN DEFAULT FALSE,
    created_at  TIMESTAMP DEFAULT NOW()
);
```

---

## 13. Environment Variables

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | SQLAlchemy connection string | `sqlite+aiosqlite:///./eco3d.db` |
| `SECRET_KEY` | JWT signing secret (required) | — |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | JWT TTL | `1440` (24 h) |
| `MAPBOX_TOKEN` | Satellite tile quality upgrade | optional |
| `WEIGHTS_DIR` | ML model weights directory | `training/weights` |

> All seven real-time environmental APIs are **free and require no API key**.

---

## 14. AnalysisResponse Field Reference

```json
{
  "plot_id": "PLOT9931X76267",
  "segmentation": {
    "vegetation": 0.42, "water": 0.08, "urban": 0.25,
    "bare_soil": 0.15, "road": 0.10
  },
  "tree_coordinates": [
    { "lat": 9.9312, "lon": 76.2673, "confidence": 0.89 }
  ],
  "environmental": {
    "elevation": 14.2,       "slope": 2.1,
    "ndvi": 0.612,           "rainfall_mm": 2840.5,
    "soil_type": "Clay Loam","wind_direction": "SW",
    "sun_exposure_hours": 11.8,
    "wind_ms": 3.4,          "solar_radiation_kwh": 5.82,
    "distance_to_water_m": 340.0,
    "clay_pct": 29.4,        "sand_pct": 38.1,  "silt_pct": 32.5,
    "soil_ph": 6.2,          "organic_carbon": 18.4,
    "bulk_density": 1.28,    "soil_buildable": true,
    "soil_source": "SoilGrids v2 (ISRIC/WUR) — 250m global",
    "river_discharge_peak_m3s": 42.1,
    "river_discharge_mean_m3s": 18.7,
    "glofas_flood_index": 0.22,
    "flood_source": "Open-Meteo GloFAS (EU Copernicus) — 90-day forecast"
  },
  "flood_probability": 0.341,
  "buildability_score": 68.4,
  "status": "GOOD",
  "score_references": [
    "FEMA Hazard Mitigation Standards",
    "LEED BD+C v4 Sustainable Sites",
    "ASHRAE Standard 55",
    "SoilGrids v2 (ISRIC/WUR)",
    "Open-Meteo GloFAS (EU Copernicus)",
    "NASA POWER API"
  ]
}
```

---

## 15. Dependencies

### Backend (`backend/requirements.txt`)

```
fastapi>=0.111.0          uvicorn[standard]>=0.29.0
sqlalchemy[asyncio]>=2.0  aiosqlite>=0.20.0
asyncpg>=0.29.0           pydantic>=2.7.0
pydantic-settings>=2.3.0  python-dotenv>=1.0.0
httpx>=0.27.0             pillow>=10.0.0
numpy>=1.26.0

# ML (optional — all have physics fallbacks)
torch>=2.0.0              torchvision>=0.15.0
xgboost>=2.0.0            scikit-learn>=1.4.0
ultralytics>=8.0.0
```

### Frontend (`frontend/package.json`)

```
next@14.2.5               react@^18
react-dom@^18             typescript@^5
@react-three/fiber@^8     @react-three/drei@^9
three@^0.167.1            zustand@^4.5.2
react-leaflet@^4.2.1      leaflet@^1.9.4
leaflet-geosearch@^4.2.2  axios@^1.7.2
framer-motion@^11         tailwindcss@^3.4.1
```

---

## 16. Future Improvements

- **HouseDiffusion / Graph2Plan integration** — Replace the genetic algorithm with a diffusion-based generative model for more architecturally coherent layouts.
- **Wind CFD simulation** — Replace the compass-direction heuristic with OpenFOAM-derived airflow vectors for more accurate cross-ventilation scoring.
- **Real satellite imagery segmentation** — Fine-tune DeepLabV3 on a labelled dataset of aerial/satellite images rather than relying on OSM map tiles.
- **Redis caching** — Cache API responses (soil data, 24 hr TTL; ERA5 rainfall, 7 day TTL) to reduce external API dependency and latency.
- **Real-time collaboration** — Multi-user editing of 3D floor plans via WebSocket channels.
- **PostGIS spatial queries** — Leverage PostGIS for efficient within-polygon and nearest-feature queries as the dataset scales.
- **Mobile app (React Native)** — Port the map selection and analysis dashboard to native mobile.
- **Custom ML fine-tuning** — Provide Jupyter notebooks for fine-tuning the segmentation and tree detection models on domain-specific datasets.

---

*ECO-3D Studio v2.1 — Sustainable Intelligence from Geographic Coordinates*
