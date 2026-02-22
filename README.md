# ECO-3D Studio — AI-Generative Architecture Platform

> **End-to-end sustainable land development intelligence** — from a map click to a fully rendered interactive 3D floor plan, driven entirely by **real-time satellite and API-sourced environmental data**.

---

## What is ECO-3D?

ECO-3D transforms a geographic coordinate into a comprehensive sustainable development assessment in seconds. It fetches live data from seven public APIs simultaneously — SRTM elevation, ISRIC SoilGrids soil properties, NASA POWER satellite vegetation index, EU Copernicus GloFAS river discharge, ERA5 30-year climate normals, Open-Meteo real-time wind, and OSM water features — then runs a five-layer AI pipeline to produce a flood risk score, buildability assessment, optimised floor plan, and interactive WebGL 3D model.

Every external API call has a deterministic physics-based fallback. The system never returns HTTP 500.

---

## Table of Contents

1. [Real-Time Data Sources](#1-real-time-data-sources)
2. [System Architecture](#2-system-architecture)
3. [Five-Layer AI Pipeline](#3-five-layer-ai-pipeline)
4. [Flood Risk & Buildability Formulas](#4-flood-risk--buildability-formulas)
5. [Feature Walkthrough](#5-feature-walkthrough)
6. [Technology Stack](#6-technology-stack)
7. [API Reference](#7-api-reference)
8. [AnalysisResponse Field Reference](#8-analysisresponse-field-reference)
9. [Database Schema](#9-database-schema)
10. [Project Structure](#10-project-structure)
11. [Environment Variables](#11-environment-variables)
12. [Quick Start](#12-quick-start)

---

## 1. Real-Time Data Sources

All environmental data is fetched live on every analysis request. No synthetic data is used for real plots — fallbacks activate only when an API is unreachable.

| Data | API / Source | Resolution | Key needed? |
|---|---|---|---|
| Elevation (m) | Open-Elevation — SRTM | 30 m global | No |
| Slope (°) | 5-point DEM stencil on above | Per-point | No |
| Wind speed (m/s) | Open-Meteo Forecast | Real-time, global | No |
| Wind direction | Open-Meteo Forecast | 16-point compass | No |
| Annual rainfall (mm/yr) | Open-Meteo Climate — ERA5 | 30-yr normals 1991–2020 | No |
| **Soil texture class (USDA)** | **SoilGrids REST v2 — ISRIC/WUR** | **250 m global** | No |
| **Clay / Sand / Silt %** | SoilGrids REST v2 | 0–5 cm depth, mean | No |
| **Soil pH** | SoilGrids REST v2 | 0–5 cm depth | No |
| **Organic carbon (g/kg)** | SoilGrids REST v2 | 0–5 cm depth | No |
| **Bulk density (g/cm³)** | SoilGrids REST v2 | 0–5 cm depth | No |
| **NDVI (vegetation index)** | **NASA POWER API** | Daily satellite, 1-yr window | No |
| **Solar radiation (kWh/m²/day)** | NASA POWER API | Daily, global | No |
| **River discharge (m³/s)** | **Open-Meteo GloFAS — EU Copernicus** | **90-day forecast** | No |
| GloFAS flood index (0–1) | Open-Meteo GloFAS | Derived from discharge | No |
| Distance to water body (m) | OSM Overpass API | 5 km search radius | No |
| Sun hours/day | NOAA astronomical formula | Exact, no I/O | No |
| Plot boundary polygon | OSM Overpass — cadastral | Real parcel data | No |
| Land use / zoning | OSM Overpass + Nominatim | Local | No |

---

## 2. System Architecture

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
│            Zustand: JWT · plot · AnalysisResponse · FloorPlan      │
└─────────────────────────────────────┬───────────────────────────────┘
                      HTTP/JSON + JWT Bearer + SSE
┌─────────────────────────────────────▼───────────────────────────────┐
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
│    Layer 4  compute_buildability() (soil pH, BD, clay, NDVI …)    │
│    SQLAlchemy async → persist raw_features JSONB                   │
│    SSE EventSourceResponse → browser progress stream               │
│                                                                     │
│  POST /generate-floorplan → Genetic Algorithm (80 gen, pop 60)     │
└──────────────────┬──────────────────┬───────────────────────────────┘
                   │                  │
     ┌─────────────▼───┐    ┌─────────▼──────────────────────────┐
     │  EXTERNAL APIs  │    │  DATABASE                          │
     │  Open-Elevation │    │  SQLite (dev) / PostgreSQL (prod)  │
     │  Open-Meteo     │    │  users · plots · analyses          │
     │  ERA5 Climate   │    │  floorplans · notifications        │
     │  SoilGrids ISRIC│    │  raw_features JSONB (all 20 env   │
     │  NASA POWER     │    │  fields stored per analysis)      │
     │  GloFAS         │    └────────────────────────────────────┘
     │  OSM Overpass   │
     └─────────────────┘
```

---

## 3. Five-Layer AI Pipeline

### Layer 1A — Semantic Segmentation (DeepLabV3 + ResNet-50)
`backend/ai/segmentation/segmenter.py`

DeepLabV3 with ResNet-50 backbone performs pixel-wise semantic segmentation on a satellite tile fetched at zoom 18 (~0.6 m/px), resized to 512×512 and normalised with ImageNet statistics. Atrous Spatial Pyramid Pooling (dilation rates: 1, 6, 12, 18) captures multi-scale land cover without resolution loss. Six output classes: `vegetation`, `bare_land`, `water`, `urban`, `agriculture`, `forest`. Output: per-class area percentage dict.

### Layer 1B — Tree Canopy Detection (YOLOv8n)
`backend/ai/detection/tree_detector.py`

YOLOv8 nano (conf=0.35, IoU=0.45) detects individual tree bounding boxes on the same tile. Pixel centres are reverse-projected to lat/lon using Mercator tile mathematics. Canopy radius estimated from bbox width × tile width in metres. Trees with radius > 5 m are flagged **protected** and passed to the Genetic Algorithm as exclusion constraints.

### Layer 2 — Real-Time Environmental Feature Engineering
`backend/services/real_env_data.py` (v2.1 — fully rewritten)

Seven concurrent async API calls via `asyncio.gather()`. Each call wrapped in independent try/except with deterministic fallback so no single API failure blocks the pipeline.

| Function | API | Key output fields |
|---|---|---|
| `fetch_elevation_slope()` | Open-Elevation (5-pt SRTM) | elevation (m), slope (°) |
| `fetch_wind()` | Open-Meteo Forecast | speed (m/s), direction (16-pt compass) |
| `fetch_rainfall()` | Open-Meteo ERA5 Climate | annual mm (30-yr normal) |
| `fetch_soil_data()` | **SoilGrids REST v2 ISRIC** | clay/sand/silt %, pH, organic carbon g/kg, bulk density g/cm³, USDA texture class |
| `fetch_ndvi_and_solar()` | **NASA POWER API** | NDVI proxy (0–0.9), solar kWh/m²/day |
| `fetch_flood_discharge()` | **Open-Meteo GloFAS** | peak/mean discharge m³/s, flood index (0–1) |
| `fetch_distance_to_water()` | OSM Overpass | metres to nearest river/lake/wetland |

**SoilGrids unit conversions applied:** clay/sand/silt in g/kg ÷ 10 = %; phh2o ÷ 10 = pH; soc dg/kg ÷ 10 = g/kg organic carbon; bdod cg/cm³ ÷ 100 = g/cm³ bulk density. USDA Texture Triangle classification converts clay/sand/silt percentages into a human-readable texture name and binary buildability flag.

**NASA POWER NDVI proxy:** `FPAR = (avg_PAR × 0.45) / (avg_SW × 0.48)` → `NDVI ≈ FPAR × 0.72 + 0.05`, computed from 365 days of daily shortwave (ALLSKY_SFC_SW_DWN) and PAR (CLRSKY_SFC_PAR_TOT) observations.

**GloFAS flood index mapping:** peak 90-day discharge → index: <5 m³/s → 0.05, <20 → 0.12, <50 → 0.22, <150 → 0.38, <500 → 0.58, <2000 → 0.75, ≥2000 → 0.90.

### Layer 3 — Flood Risk (Blended Topo + GloFAS)
`backend/services/real_env_data.py → compute_flood_risk()`

Composite probability ∈ [0.01, 0.97]. When GloFAS river data is available: `flood = 0.70 × topo_model + 0.30 × glofas_index`. Without GloFAS (dry inland areas): full 6-component topo model. See [Section 4](#4-flood-risk--buildability-formulas) for formulas.

### Layer 4 — Buildability Score (Real-Data Physics + Optional MLP)
`backend/services/real_env_data.py → compute_buildability()`

Composite score ∈ [1, 99] incorporating six real SoilGrids properties (USDA class, clay %, pH, bulk density, organic carbon), NDVI vegetation stability, wind load, solar access, and elevation zone penalties. Optional PyTorch MLP (6→64→128→64→1, 17 217 params) supplements the physics model when weights are present.

### Layer 5 — Genetic Algorithm Floor Plan
`backend/ai/floorplan/genetic.py`

Population: 60, Generations: 80, Mutation rate: 0.20, Elite fraction: 33%.
Fitness: `0.35 × f_sunlight + 0.25 × f_ventilation + 0.25 × f_structural + 0.15 × f_tree`.
Real wind direction from Open-Meteo is fed into the ventilation score, targeting NW–SE cross-ventilation axis (315°) for maximum natural airflow.

---

## 4. Flood Risk & Buildability Formulas

### Flood Risk — Blended Model

```
When GloFAS river discharge is available:

  flood_risk = 0.70 × topo_model + 0.30 × glofas_index

  topo_model = 0.42 × elev_risk          [elevation < 80 m = high risk]
             + 0.20 × slope_risk         [slope < 12° = flat = pools water]
             + 0.16 × rain_risk          [rainfall from ERA5 30-yr normal]
             + 0.13 × clay_risk          [clay fraction from SoilGrids]
             + 0.09 × water_risk         [OSM distance to river/lake]

  where:
    elev_risk  = max(0, 1 − elevation / 80)
    slope_risk = max(0, 1 − slope / 12)
    rain_risk  = clip((rainfall − 300) / 2700,  0, 1)
    clay_risk  = clay_pct / 100              (0 to 1)
    water_risk = max(0, 1 − dist_water / 400)

Without GloFAS (dry / inland locations):
  Uses 6-component topo model including an extra low-elevation penalty
  for sites below 30 m above sea level.
```

### Buildability Score

```
score = 100.0

  # Flood and terrain (dominant penalties)
  − flood_risk × 38
  − min(slope, 35) × 0.85

  # Soil buildability (from SoilGrids real data)
  − 50   if USDA texture = Heavy Clay (≥55%) or Peat/Mud
  − (clay_pct − 35) × 0.4   progressive penalty for clay > 35%
  − 5    if soil_ph < 5.0 or > 8.5  (corrosive to concrete)
  − 8    if bulk_density < 1.0 g/cm³ (loose / volcanic / peat)
  − 4    if bulk_density > 1.8 g/cm³ (hard compacted rock)

  # Positive environmental factors
  + ndvi × 8            (vegetation = root-bound, stable soil)
  + min(sun_hours, 14) × 1.2   (passive solar access bonus)
  − min(wind_ms, 15) × 0.5     (structural wind load penalty)

  # Elevation zone adjustments
  − 20   if elevation < 3 m   (tidal / storm surge zone)
  − 10   if elevation < 10 m  (coastal flood zone)
  − 5    if elevation > 800 m (high altitude access cost)
  − 10   if elevation > 1200 m (extreme altitude)

Clamped to [1, 99].
```

### Buildability Status Thresholds

| Score | Status | Meaning |
|---|---|---|
| ≥ 80 | EXCELLENT | Highly suitable — minimal environmental constraints |
| 60–79 | GOOD | Suitable with standard construction practices |
| 40–59 | FAIR | Marginally suitable — engineering interventions required |
| 30–39 | POOR | High-risk — major investment required |
| < 30 or soil not buildable | NOT BUILDABLE | Unsuitable under current standards |

---

## 5. Feature Walkthrough

### `/map` — Plot Selection
Full-screen Leaflet + Mapbox satellite map. Click any point or draw a polygon. OSM Overpass queries cadastral boundaries (parcel ways ≤ 10 000 m²) in priority order: cadastral tags → smallest containing way → Nominatim reverse geocode → synthetic oriented rectangle.

### `/analysis/[id]` — Real-Data Dashboard (5 Panels)
**Plot Scores** — Buildability (0–100) and Flood Risk (0–100%)  
**Topography** — Elevation (m), Slope (°), Distance to water (m from OSM)  
**Climate** — ERA5 rainfall (mm/yr), Open-Meteo wind speed + direction, NOAA sun hours/day, NASA POWER solar radiation (kWh/m²/day), NASA POWER NDVI  
**Soil Profile — SoilGrids v2 (ISRIC/WUR)** — USDA texture class, Clay %, Sand %, Silt %, pH, Organic carbon (g/kg), Bulk density (g/cm³), Buildability flag  
**River Flood — GloFAS (EU Copernicus)** — Peak discharge (m³/s), Mean discharge (m³/s), GloFAS flood index (%), data source label

### `/floorplan/[id]` — Genetic Algorithm Floor Plan
2D SVG floor plan with real wind direction feeding the ventilation fitness score. Displays fitness score, sunlight score, ventilation score, tree preservation count, and optimal building orientation.

### `/model3d/[id]` — Three.js 3D Viewer
Floor plan extruded to 3D (wall height 3.2 m), open-top for interior inspection. Real solar radiation from NASA POWER drives sun animation brightness. Real wind direction from Open-Meteo drives wind arrow overlay. Camera presets: Isometric, Top-Down, Interior.

### `/report/[id]` — Regulatory Report
Full report with all real-time data and regulatory citations: FEMA Hazard Mitigation Standards, LEED BD+C v4 Sustainable Sites, ASHRAE 55, SoilGrids ISRIC, GloFAS EU Copernicus, NASA POWER.

---

## 6. Technology Stack

### Frontend
| Component | Technology |
|---|---|
| Framework | Next.js 14 (App Router) |
| Language | TypeScript |
| UI | React 18, Tailwind CSS, Framer Motion |
| State | Zustand |
| 3D | React Three Fiber, Drei, Three.js r128 |
| Maps | React-Leaflet, Mapbox GL |
| HTTP | Axios + JWT interceptor |

### Backend
| Component | Technology |
|---|---|
| Framework | FastAPI 0.110+ |
| Server | Uvicorn ASGI |
| Concurrency | Python AsyncIO + `run_in_executor` |
| Auth | JWT (python-jose) + bcrypt |
| ORM | SQLAlchemy 2.0 async |
| Validation | Pydantic v2 |
| Real-time | Starlette SSE |
| HTTP Client | httpx (async, per-API timeouts) |

### AI / ML
| Model | Framework | Purpose |
|---|---|---|
| DeepLabV3 + ResNet-50 | PyTorch / Torchvision | Satellite segmentation |
| YOLOv8n | Ultralytics | Tree detection |
| Physics flood model | Pure Python | Blended topo + GloFAS |
| Physics buildability | Pure Python | Real soil + env scoring |
| MLP (6→64→128→64→1) | PyTorch (optional) | Supplemental buildability |
| Genetic Algorithm | Pure Python | Floor plan optimisation |

### Infrastructure
| Component | Technology |
|---|---|
| Database (dev) | SQLite + aiosqlite |
| Database (prod) | PostgreSQL 16 + PostGIS 3.4 |
| Containers | Docker + Docker Compose |

---

## 7. API Reference

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/auth/signup` | — | Create account |
| POST | `/auth/login` | — | Get JWT token |
| GET | `/auth/me` | Bearer | Current user |
| POST | `/analyze-plot` | Bearer | Full 5-layer analysis with real data |
| POST | `/generate-floorplan` | Bearer | GA floor plan generation |
| GET | `/plot-boundary` | — | OSM cadastral boundary + area |
| GET | `/legal-verify` | — | Zoning, flood zone, seismic |
| GET | `/plots` | Bearer | User's saved plots |
| GET | `/report/{plot_id}` | Bearer | Full regulatory report |
| GET | `/notifications/stream` | Bearer | SSE real-time progress |
| GET | `/health` | — | `{status:"ok", version:"2.1.0"}` |

---

## 8. AnalysisResponse Field Reference

```json
{
  "plot_id": "AE-9921",
  "segmentation": {
    "vegetation": 0.42, "water": 0.08, "urban": 0.25,
    "bare_soil": 0.15, "road": 0.10
  },
  "tree_coordinates": [
    { "lat": 9.9312, "lon": 76.2673, "confidence": 0.89 }
  ],
  "environmental": {
    "elevation": 14.2,
    "slope": 2.1,
    "ndvi": 0.612,
    "rainfall_mm": 2840.5,
    "soil_type": "Clay Loam",
    "wind_direction": "SW",
    "sun_exposure_hours": 11.8,
    "wind_ms": 3.4,
    "solar_radiation_kwh": 5.82,
    "distance_to_water_m": 340.0,
    "clay_pct": 29.4,
    "sand_pct": 38.1,
    "silt_pct": 32.5,
    "soil_ph": 6.2,
    "organic_carbon": 18.4,
    "bulk_density": 1.28,
    "soil_buildable": true,
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

## 9. Database Schema

```sql
CREATE TABLE analyses (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plot_id                   VARCHAR(64) NOT NULL,
    segmentation_mask         JSONB,
    tree_coordinates          JSONB,
    -- Core fields (indexed columns)
    ndvi                      FLOAT,
    slope                     FLOAT,
    elevation                 FLOAT,
    rainfall_mm               FLOAT,
    soil_type                 VARCHAR(64),
    wind_direction            VARCHAR(16),
    sun_exposure_hours        FLOAT,
    flood_probability         FLOAT,
    buildability_score        FLOAT,
    -- Extended real-time fields (all stored in JSONB)
    -- wind_ms, solar_radiation_kwh, distance_to_water_m,
    -- clay_pct, sand_pct, silt_pct, soil_ph, organic_carbon, bulk_density,
    -- soil_buildable, soil_source,
    -- river_discharge_peak_m3s, river_discharge_mean_m3s,
    -- glofas_flood_index, flood_source
    raw_features              JSONB,
    created_at                TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_analyses_plot_id ON analyses(plot_id);
CREATE INDEX idx_analyses_buildability ON analyses(buildability_score);
CREATE INDEX idx_analyses_flood ON analyses(flood_probability);
```

---

## 10. Project Structure

```
ECO-3D/
├── frontend/
│   └── app/
│       ├── analysis/[id]/page.tsx  ← 5-panel real-data dashboard (v2.1)
│       ├── model3d/[id]/page.tsx   ← Open-top 3D, real wind/sun overlays
│       ├── floorplan/[id]/page.tsx
│       ├── map/page.tsx
│       └── report/[id]/page.tsx
│
├── backend/
│   ├── services/
│   │   ├── real_env_data.py       ← REWRITTEN v2.1 — 7 real APIs
│   │   ├── analysis_pipeline.py   ← Updated — all 20 env fields
│   │   └── plot_boundary.py       ← OSM cadastral detection
│   ├── models/
│   │   └── schemas.py             ← EnvironmentalFeatures (20 fields)
│   ├── routes/
│   │   ├── analysis.py
│   │   ├── floorplan.py
│   │   └── boundary.py
│   └── ai/
│       ├── segmentation/segmenter.py
│       ├── detection/tree_detector.py
│       ├── flood/flood_model.py
│       ├── buildability/buildability_model.py
│       └── floorplan/genetic.py
│
└── scripts/
    ├── train_flood_model.py
    └── train_buildability_model.py
```

---

## 11. Environment Variables

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | SQLAlchemy connection string | `sqlite+aiosqlite:///./eco3d.db` |
| `SECRET_KEY` | JWT signing secret | required (`openssl rand -hex 32`) |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | JWT TTL | `1440` (24 h) |
| `MAPBOX_TOKEN` | Satellite tile quality upgrade | optional |
| `WEIGHTS_DIR` | ML model weights directory | `training/weights` |

> All seven real-time environmental data APIs require **no API key** and are free.

---

## 12. Quick Start

Full instructions: **[SETUP.md](./SETUP.md)**

```bash
# Backend
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp ../.env.example .env          # set SECRET_KEY
uvicorn main:app --reload --port 8000

# Frontend  (new terminal)
cd frontend && npm install
echo "NEXT_PUBLIC_API_URL=http://localhost:8000" > .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) → sign up → click any plot on the map → all 7 real-time API fetches begin immediately. Results stream to the browser via SSE as each layer completes.
