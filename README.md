# ECO-3D Studio — AI-Generative Architecture Platform

> **End-to-End Sustainable Land Development Intelligence** — from satellite pixel to interactive 3D floor plan, powered by a 5-layer AI pipeline.

---

## Table of Contents

1. [What is ECO-3D?](#what-is-eco-3d)
2. [Live Feature Walkthrough](#live-feature-walkthrough)
3. [System Architecture](#system-architecture)
4. [The 5-Layer AI Pipeline](#the-5-layer-ai-pipeline)
5. [Data Flow — End to End](#data-flow--end-to-end)
6. [Technology Stack](#technology-stack)
7. [Project Directory Structure](#project-directory-structure)
8. [Complete API Reference](#complete-api-reference)
9. [Database Schema](#database-schema)
10. [Environment Variables](#environment-variables)
11. [Getting Started](#getting-started)
12. [Contributing](#contributing)

---

## What is ECO-3D?

ECO-3D is a full-stack, AI-powered sustainable architecture and land development intelligence platform. It enables architects, urban planners, real estate developers, and municipal authorities to:

- **Evaluate any plot of land on Earth** for flood risk, buildability, soil stability, and environmental suitability — in seconds.
- **Auto-generate optimized floor plans** using a Genetic Algorithm that maximizes sunlight access, cross-ventilation, and tree preservation.
- **Visualize results as interactive 3D models** rendered in real-time WebGL directly in the browser via React Three Fiber and Three.js.
- **Export BIM-compatible data** and comprehensive PDF reports for professional use.

The platform is built for **zero-downtime resilience**: every AI layer has a physics-based synthetic fallback, so the system never returns a 500 error, even without ML model weights installed.

---

## Live Feature Walkthrough

### 1. Interactive Global Map & Plot Selection
Navigate to `/map` to open a full-screen Leaflet + Mapbox satellite map. Users can drop a pin or draw a custom polygon over any location on Earth. The boundary analyzer immediately computes plot area, centroid coordinates, and perimeter.

### 2. Five-Layer AI Analysis
Clicking **Analyze Plot** fires `POST /analyze-plot`, which triggers the full 5-layer pipeline (see below). Real-time progress updates are streamed back to the browser via **Server-Sent Events (SSE)** on `GET /notifications/stream` — no polling, no page refresh.

### 3. Analysis Dashboard (`/analysis/[id]`)
After the pipeline completes, the dashboard displays:
- **Segmentation Map** — land cover breakdown (vegetation %, water %, urban %, bare soil %, roads %)
- **Tree Map** — geo-referenced detected trees with confidence scores
- **Environmental Data Cards** — NDVI, Elevation, Slope, Rainfall, Soil Type, Wind Direction, Sun Exposure
- **Flood Risk Gauge** — probability 0.0–1.0 with Low / Medium / High / Critical classification
- **Buildability Score** — 0–100 composite index with EXCELLENT / GOOD / FAIR / POOR / NOT BUILDABLE status
- **Regulatory References** — automatic citations from FEMA, LEED BD+C v4, ASHRAE 55

### 4. Floor Plan Generator (`/floorplan/[id]`)
One-click genetic algorithm generation produces a **2D SVG floor plan** with:
- Room-by-room layout optimized for solar orientation, cross-ventilation, and structural balance
- Fitness score, generation count, sunlight score, ventilation score
- Tree preservation count and optimal building orientation (degrees)

### 5. 3D Model Viewer (`/model3d/[id]`)
The generated floor plan JSON is extruded into a live 3D model using Three.js / React Three Fiber:
- **Isometric, Top-Down, and Interior** camera presets
- **Sun simulation** — animated solar sphere showing real-world sun direction
- **Wind visualization** — animated arrow vectors showing prevailing wind
- **Room color legend** — Living, Kitchen, Bedroom, Bathroom, Garage, Utility
- **Import/Export BIM** controls for interoperability

### 6. Environmental Data Module (`/environment/[id]`)
Deep-dive charts for all environmental metrics including time-series rainfall, wind rose diagrams, and NDVI history.

### 7. Report Generator (`/report/[id]`)
One-click professional PDF/UI summary report suitable for regulatory submission, investor decks, or municipal planning applications.

### 8. Supporting Modules
- `/insights` — user analytics dashboard with historical plot comparisons
- `/registry` — carbon credit and real estate registry tracking
- `/solutions` — predefined industry solution templates (Residential, Commercial, Industrial, Green Infrastructure)

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  BROWSER — Next.js 14 App Router (React 18)                                 │
│                                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐  │
│  │  /map    │  │/analysis │  │/floorplan│  │ /model3d │  │   /report   │  │
│  │ Leaflet  │  │ Charts   │  │ SVG View │  │ Three.js │  │  PDF Export │  │
│  │ MapBox   │  │ Gauges   │  │ GA Stats │  │ WebGL    │  │  Summary    │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬──────┘  │
│       │              │              │              │               │         │
│  ┌────▼──────────────▼──────────────▼──────────────▼───────────────▼──────┐ │
│  │            Zustand Global State Store (useEco3DStore.ts)               │ │
│  │         JWT Token · Plot Data · Analysis Results · Floor Plans        │ │
│  └──────────────────────────────────┬─────────────────────────────────────┘ │
└─────────────────────────────────────┼───────────────────────────────────────┘
                                      │  HTTP/JSON + JWT Bearer + SSE
                                      │
┌─────────────────────────────────────▼───────────────────────────────────────┐
│  FASTAPI BACKEND  (Python 3.11, Uvicorn ASGI)                               │
│                                                                             │
│  /auth/signup · /auth/login · /auth/me          ← JWT Auth (bcrypt + jose) │
│  /notifications/stream                          ← SSE Real-time Updates    │
│  /boundary/analyze                              ← Plot geometry evaluation  │
│  POST /analyze-plot                             ← 5-Layer AI Orchestrator  │
│  POST /generate-floorplan                       ← Genetic Algorithm        │
│  GET  /report/{id}                              ← Report retrieval         │
│  GET  /plots                                    ← User plot history        │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Analysis Pipeline  (services/analysis_pipeline.py)                 │   │
│  │                                                                     │   │
│  │  asyncio.gather( Layer1_Seg, Layer2_Trees, Layer3_EnvFeatures )     │   │
│  │       ↓                                                             │   │
│  │  Layer4_FloodXGBoost( env_features ) → flood_probability            │   │
│  │       ↓                                                             │   │
│  │  Layer5_BuildabilityMLP( flood, env ) → buildability_score          │   │
│  │       ↓                                                             │   │
│  │  DB persist → AnalysisRecord (SQLAlchemy)                           │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
        ┌─────────────────────────────┼────────────────────────────────┐
        │                             │                                │
┌───────▼──────┐          ┌───────────▼──────────┐        ┌───────────▼──────┐
│  AI MODELS   │          │  EXTERNAL APIs        │        │  DATABASE        │
│              │          │                       │        │                  │
│ DeepLabV3    │          │ Open-Elevation API    │        │ SQLite (dev)     │
│ (PyTorch)    │          │ OpenWeatherMap API    │        │ PostgreSQL+      │
│              │          │ OpenStreetMap Tiles   │        │ PostGIS (prod)   │
│ YOLOv8n      │          │ Copernicus/Sentinel-2 │        │                  │
│ (Ultralytics)│          │ (Future: NDVI bands)  │        │ Tables:          │
│              │          └───────────────────────┘        │  users           │
│ XGBoost      │                                           │  plots           │
│ (n=200 trees)│                                           │  analyses        │
│              │                                           │  floorplans      │
│ MLP (PyTorch)│                                           │  notifications   │
│ 6→64→128→    │                                           │                  │
│ 64→1 layers  │                                           └──────────────────┘
│              │
│ Genetic Alg  │
│ Pop=60,Gen=80│
└──────────────┘
```

---

## The 5-Layer AI Pipeline

### Layer 1A — Semantic Segmentation (DeepLabV3 + ResNet-50)

**File:** `backend/ai/segmentation/segmenter.py`

DeepLabV3 with a ResNet-50 backbone performs pixel-wise semantic segmentation on satellite imagery fetched from OpenStreetMap tile servers. The model classifies each pixel into one of six land-cover categories: `vegetation`, `bare_land`, `water`, `urban`, `agriculture`, `forest`.

The output is a per-class percentage distribution (e.g., `vegetation: 0.42, urban: 0.18`) that feeds directly into the environmental feature engineering stage and is displayed on the Analysis Dashboard.

In production: custom weights fine-tuned on Copernicus Land Service and ESA WorldCover datasets. In development: the pretrained COCO/ImageNet backbone is used with a COCO→ECO-3D class remapping heuristic, plus a realistic synthetic fallback.

### Layer 1B — Tree Detection (YOLOv8n)

**File:** `backend/ai/detection/tree_detector.py`

YOLOv8 nano performs object detection on the same satellite tile to identify individual tree canopy bounding boxes. Pixel coordinates are reverse-projected to geo-coordinates (lat/lon) using Mercator tile math. Trees with bounding-box width > 5m are automatically flagged as **protected**.

Detection outputs include: tree ID, geo-coordinates, estimated canopy radius (meters), pixel bounding box, and confidence score (threshold: 0.35 IoU: 0.45). These coordinates are passed to the Genetic Algorithm to enforce tree preservation exclusion zones.

### Layer 2 — Environmental Feature Engineering

**File:** `backend/ai/features/extractor.py`

Computes 7 primary environmental features from the plot coordinates:

| Feature | Source | Method |
|---|---|---|
| NDVI | Sentinel-2 (prod) / Synthetic | (NIR - Red) / (NIR + Red); latitude-calibrated |
| Elevation (m) | Open-Elevation API | REST API with 3-point DEM lookup |
| Slope (%) | Open-Elevation API | Rise-over-run from 3 adjacent DEM points |
| Rainfall (mm/yr) | OpenWeatherMap API | 1h rain × 8760 extrapolation |
| Soil Type | Heuristic | Lat-band lookup table (tropical clay / arid sand / temperate loam) |
| Wind Direction | Climatological model | Hadley cell / Ferrel cell latitude-band assignment |
| Sun Exposure (h/day) | Astronomical formula | Declination angle + hour angle from Julian date & latitude |

All features have deterministic synthetic fallbacks seeded by `(lat, lon)` hash for reproducibility.

### Layer 3 — Flood Risk Model (XGBoost Regressor)

**File:** `backend/ai/flood/flood_model.py`

An XGBoost Gradient Boosted Trees regressor predicts `flood_probability ∈ [0.0, 1.0]` from 6 features:

```
Input features: [elevation, slope_pct, ndvi, rainfall_mm, soil_stability, distance_to_water_m]

XGBoost config:
  n_estimators    = 200
  max_depth       = 6
  learning_rate   = 0.05
  subsample       = 0.8
  colsample_bytree= 0.8
  objective       = reg:squarederror
```

**Training data:** 2,000 synthetic samples generated with physics-based flood probability equations (documented in `generate_synthetic_data.py`). The physics model weights: elevation (40%), slope flatness (15%), vegetation (15%), rainfall (10%), distance to water (10%), soil clay content (10%).

Risk level classification thresholds: Low < 0.30 ≤ Medium < 0.60 ≤ High < 0.80 ≤ Critical.

### Layer 4 — Buildability Score (MLP Neural Network)

**File:** `backend/ai/buildability/buildability_model.py`

A PyTorch Multi-Layer Perceptron regresses a `buildability_score ∈ [0, 100]` from 6 normalized inputs:

```
Architecture: Linear(6→64) → ReLU → Dropout(0.1)
              Linear(64→128) → ReLU → Dropout(0.1)
              Linear(128→64) → ReLU
              Linear(64→1)

Training: Adam optimizer, lr=1e-3, weight_decay=1e-4, MSELoss, 200 epochs
Dataset: 3,000 synthetic samples
```

Input features (all normalized 0–1): `flood_probability`, `slope/45`, `clay_pct/60`, `vegetation_density (NDVI)`, `wind_speed/15`, `sun_hours/12`.

Score interpretation: EXCELLENT (≥80), GOOD (≥60), FAIR (≥40), POOR (≥30), NOT BUILDABLE (<30 or soil fails).

Standards alignment: FEMA Hazard Mitigation, LEED BD+C v4 Sustainable Sites, ASHRAE 55.

### Layer 5 — Genetic Algorithm Floor Plan Generator

**File:** `backend/ai/floorplan/genetic.py`

A custom Genetic Algorithm (GA) optimizes room layout across 80 generations with a population of 60 chromosomes.

**Chromosome:** A complete candidate floor plan — a list of room objects `{type, x, y, w, h, floor, orientation}` plus a building rotation angle.

**Fitness Function (composite, weighted sum):**
```
fitness = 0.35 × sunlight_score
        + 0.25 × ventilation_score
        + 0.25 × structural_score
        + 0.15 × tree_preservation_score

sunlight_score:    Living/kitchen rooms positioned in southern half of plot (lower y ratio)
ventilation_score: Building orientation aligned to NW-SE axis (315° target for cross-ventilation)
structural_score:  1.0 minus overlap ratio (penalizes rooms that intersect)
tree_score:        Static 0.8 (tree exclusion zones integrated in future version)
```

**Evolution operators:**
- **Selection:** Top 33% elites survive each generation
- **Crossover:** Single-point room array crossover; orientation averaged between parents
- **Mutation:** Random position nudge ±1m (rate=0.2), size adjustment ±0.5m (rate=0.1), orientation rotation ±30° (rate=0.2)

Output: Room layout JSON → Pydantic `FloorPlanResponse` → stored in `floorplans` table → rendered as 3D model.

### Layer 6 — 3D Rendering Engine (Three.js / React Three Fiber)

**File:** `frontend/app/model3d/[id]/page.tsx`

The floor plan JSON is consumed client-side and extruded into a full 3D scene:
- **Outer perimeter walls** (4 sides, `FH = 3.2m` height) with foundation slab
- **Interior partition walls** derived from room boundaries
- **Window meshes** (glass material, transparency 0.45) on exterior walls
- **Door openings** with dimensional cutouts
- **Room-type furniture** — procedurally generated 3D furniture per room type (sofa, dining table, bed, toilet, etc.)
- **Sun sphere** — animated orbital sphere indicating real wind/sun direction
- **Wind arrows** — cone geometry arrows animating in prevailing wind direction
- **Ground plane** — tiered lawn with grid overlay

Camera modes: Isometric (default), Top-Down (orthographic), Interior (close-up first-person).

---

## Data Flow — End to End

```
User selects plot on map
        │
        ▼
POST /analyze-plot { plot_id, lat, lon, polygon }
        │
        ├──────────── asyncio.gather() ────────────────┐
        │                                              │
  Layer 1A: DeepLabV3              Layer 1B: YOLOv8   Layer 2: Env Features
  Satellite tile → segment        Satellite tile →    Elevation API +
  class distribution dict         tree bbox list      Weather API +
                                  + geo-coords        Astronomical calc
        │                              │                    │
        └──────────────────────────────┴────────────────────┘
                                       │
                               Layer 3: XGBoost
                         env_features → flood_probability
                                       │
                               Layer 4: MLP
                     flood + env → buildability_score (0-100)
                                       │
                          SQLAlchemy DB persist
                          (plots + analyses tables)
                                       │
                          SSE notification pushed
                          to browser: "Analysis complete"
                                       │
              AnalysisResponse JSON → /analysis/[id] page renders
                                       │
                    User clicks "Generate Floor Plan"
                                       │
                    POST /generate-floorplan { plot_id, area, floors }
                                       │
                            Layer 5: Genetic Algorithm
                          60 chromosomes × 80 generations
                          fitness = sunlight + ventilation
                                    + structural + tree
                                       │
                          Best chromosome → Room[] JSON
                          Stored → floorplans table
                                       │
                   FloorPlanResponse → /floorplan/[id] (2D SVG view)
                                   AND → /model3d/[id] (Three.js 3D)
                                       │
                   User views open-top 3D model, switches camera
                   modes, toggles sun/wind overlays, exports BIM
```

---

## Technology Stack

### Frontend
| Component | Technology |
|---|---|
| Framework | Next.js 14 (App Router) |
| UI Library | React 18 |
| Styling | Tailwind CSS |
| Animations | Framer Motion |
| State Management | Zustand |
| 3D Rendering | React Three Fiber + Drei + Three.js (r128) |
| Mapping | React-Leaflet + Mapbox GL |
| HTTP Client | Axios |
| Language | TypeScript |

### Backend
| Component | Technology |
|---|---|
| Framework | FastAPI 0.110+ |
| ASGI Server | Uvicorn |
| Concurrency | Python AsyncIO + run_in_executor |
| Authentication | JWT (python-jose) + bcrypt |
| ORM | SQLAlchemy 2.0 (async) |
| Validation | Pydantic v2 |
| Real-Time | Starlette SSE (EventSourceResponse) |
| HTTP Client | httpx (async) |

### AI / ML
| Model | Framework | Purpose |
|---|---|---|
| DeepLabV3 + ResNet-50 | PyTorch / Torchvision | Satellite semantic segmentation |
| YOLOv8n | Ultralytics | Tree canopy object detection |
| XGBoost Regressor | XGBoost 2.0 | Flood risk probability |
| MLP (6→64→128→64→1) | PyTorch | Buildability scoring |
| Genetic Algorithm | Pure Python | Floor plan optimization |

### Infrastructure
| Component | Technology |
|---|---|
| Database (dev) | SQLite + aiosqlite |
| Database (prod) | PostgreSQL 16 + PostGIS 3.4 |
| Containerization | Docker + Docker Compose |
| External Data | Open-Elevation API, OpenWeatherMap API, OSM Tiles |

---

## Project Directory Structure

```
ECO-3D/
├── frontend/
│   ├── app/
│   │   ├── page.tsx                    # Landing / marketing hero
│   │   ├── layout.tsx                  # Root layout, global fonts
│   │   ├── globals.css                 # Tailwind base styles
│   │   ├── map/page.tsx                # Leaflet satellite map + plot selection
│   │   ├── login/page.tsx              # JWT login form
│   │   ├── signup/page.tsx             # User registration
│   │   ├── product/page.tsx            # Product overview
│   │   ├── solutions/page.tsx          # Industry solution templates
│   │   ├── registry/page.tsx           # Carbon & real estate registry
│   │   ├── insights/page.tsx           # User analytics dashboard
│   │   ├── analysis/[id]/page.tsx      # AI analysis results dashboard
│   │   ├── environment/[id]/page.tsx   # Environmental data deep dive
│   │   ├── floorplan/[id]/page.tsx     # 2D floor plan SVG viewer
│   │   ├── model3d/[id]/page.tsx       # Three.js 3D model viewer ← (modified)
│   │   └── report/[id]/page.tsx        # Summary report view
│   ├── components/
│   │   ├── MapComponent.tsx            # Leaflet map with polygon drawing
│   │   └── Notifications.tsx           # SSE notification bell
│   ├── store/
│   │   └── useEco3DStore.ts            # Zustand global state
│   ├── lib/
│   │   └── api.ts                      # Axios API client + interceptors
│   ├── next.config.js
│   ├── tailwind.config.js
│   └── package.json
│
├── backend/
│   ├── main.py                         # FastAPI app, CORS, lifespan, routers
│   ├── config.py                       # Environment variable loading
│   ├── routes/
│   │   ├── analysis.py                 # POST /analyze-plot
│   │   ├── floorplan.py                # POST /generate-floorplan
│   │   ├── plots.py                    # GET /plots, GET /plots/{id}
│   │   ├── report.py                   # GET /report/{id}
│   │   ├── boundary.py                 # POST /boundary/analyze
│   │   ├── auth.py                     # POST /auth/signup, /login, GET /me
│   │   └── notifications.py            # SSE stream + notification CRUD
│   ├── models/
│   │   ├── schemas.py                  # Pydantic request/response models
│   │   └── db_models.py                # SQLAlchemy ORM table definitions
│   ├── services/
│   │   ├── analysis_pipeline.py        # 5-layer orchestrator (crash-proof)
│   │   ├── floorplan_service.py        # GA invocation + DB persistence
│   │   ├── real_env_data.py            # External API aggregator
│   │   ├── legal_verification.py       # Regulatory compliance checks
│   │   └── plot_boundary.py            # GeoJSON polygon utilities
│   ├── database/
│   │   ├── connection.py               # SQLAlchemy engine + session factory
│   │   ├── session.py                  # AsyncSession dependency
│   │   └── models.py                   # ORM model re-export
│   ├── ai/
│   │   ├── segmentation/
│   │   │   ├── segmenter.py            # DeepLabV3 inference + tile fetch
│   │   │   └── model.py                # Entry point wrapper
│   │   ├── detection/
│   │   │   ├── tree_detector.py        # YOLOv8 inference + geo-projection
│   │   │   └── model.py                # Entry point wrapper
│   │   ├── features/
│   │   │   └── extractor.py            # Environmental feature computation
│   │   ├── flood/
│   │   │   ├── flood_model.py          # XGBoost model + training
│   │   │   └── model.py                # Entry point wrapper
│   │   ├── buildability/
│   │   │   ├── buildability_model.py   # PyTorch MLP + training
│   │   │   └── model.py                # Entry point wrapper
│   │   └── floorplan/
│   │       ├── genetic.py              # Full GA implementation
│   │       └── genetic_optimizer.py    # Optimizer entry point
│   └── requirements.txt
│
├── scripts/
│   ├── generate_synthetic_data.py      # Synthetic dataset generator
│   ├── train_flood_model.py            # XGBoost training script
│   ├── train_buildability_model.py     # MLP training script
│   ├── train_segmentation_model.py     # DeepLabV3 fine-tuning script
│   └── evaluate_models.py              # Model evaluation & metrics
│
├── data/
│   ├── buildability_training.csv       # 3000 buildability samples
│   ├── flood_training.csv              # 2000 flood risk samples
│   └── segmentation_labels.csv         # Segmentation class map
│
├── .env.example
├── README.md                           ← this file
└── SETUP.md
```

---

## Complete API Reference

### Authentication

| Method | Endpoint | Request Body | Response |
|---|---|---|---|
| POST | `/auth/signup` | `{email, password, full_name}` | `{user, token}` |
| POST | `/auth/login` | `{email, password}` | `{access_token, token_type}` |
| GET | `/auth/me` | — (Bearer token) | `UserResponse` |

### Analysis

| Method | Endpoint | Request Body | Response |
|---|---|---|---|
| POST | `/analyze-plot` | `{plot_id, lat, lon, polygon?}` | `AnalysisResponse` |
| POST | `/generate-floorplan` | `{plot_id, plot_area_sqm, num_floors, style, preserve_trees}` | `FloorPlanResponse` |
| POST | `/boundary/analyze` | `{polygon: [[lon,lat],...]}` | Boundary stats |

### Data Retrieval

| Method | Endpoint | Response |
|---|---|---|
| GET | `/plots` | List of user's PlotRecords |
| GET | `/plots/{plot_id}` | Single PlotRecord + AnalysisRecord |
| GET | `/report/{plot_id}` | Full analysis + floor plan composite |

### Notifications

| Method | Endpoint | Description |
|---|---|---|
| GET | `/notifications/stream` | SSE event stream (text/event-stream) |
| GET | `/notifications` | Notification history list |
| PATCH | `/notifications/{id}/read` | Mark notification as read |

### System

| Method | Endpoint | Response |
|---|---|---|
| GET | `/health` | `{status: "ok", version: "2.0.0"}` |

---

## Database Schema

```sql
-- Users
CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name   VARCHAR(255),
    created_at  TIMESTAMP DEFAULT NOW()
);

-- Plots (geographic records)
CREATE TABLE plots (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plot_id     VARCHAR(64) UNIQUE NOT NULL,
    lat         FLOAT NOT NULL,
    lon         FLOAT NOT NULL,
    polygon     JSONB,           -- GeoJSON [[lon,lat],...]
    created_at  TIMESTAMP DEFAULT NOW()
);

-- AI Analysis Results
CREATE TABLE analyses (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plot_id             VARCHAR(64) NOT NULL,
    segmentation_mask   JSONB,   -- {vegetation, water, urban, bare_soil, road}
    tree_coordinates    JSONB,   -- [{lat, lon, confidence, bbox}]
    ndvi                FLOAT,
    slope               FLOAT,
    elevation           FLOAT,
    rainfall_mm         FLOAT,
    soil_type           VARCHAR(64),
    wind_direction      VARCHAR(16),
    sun_exposure_hours  FLOAT,
    flood_probability   FLOAT,
    buildability_score  FLOAT,
    raw_features        JSONB,
    created_at          TIMESTAMP DEFAULT NOW()
);

-- Generated Floor Plans
CREATE TABLE floorplans (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plot_id         VARCHAR(64) NOT NULL,
    layout_json     JSONB NOT NULL,   -- Room[] array
    fitness_score   FLOAT,
    generation_count FLOAT,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- Real-Time Notifications
CREATE TABLE notifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES users(id),
    title       VARCHAR(255) NOT NULL,
    message     TEXT NOT NULL,
    type        VARCHAR(50) DEFAULT 'info',
    is_read     BOOLEAN DEFAULT FALSE,
    created_at  TIMESTAMP DEFAULT NOW()
);
```

---

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | SQLAlchemy connection string | `sqlite+aiosqlite:///./eco3d.db` |
| `SECRET_KEY` | JWT signing secret | *(required — generate with `openssl rand -hex 32`)* |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | JWT token TTL | `1440` (24h) |
| `OPENWEATHER_API_KEY` | Annual rainfall data | *(optional — synthetic fallback)* |
| `MAPBOX_TOKEN` | Satellite map tiles | *(optional — OSM fallback)* |
| `REDIS_URL` | Advanced SSE / task queuing | `redis://redis:6379` |
| `WEIGHTS_DIR` | ML model weights directory | `training/weights` |

---

## Getting Started

See **[SETUP.md](./SETUP.md)** for complete installation instructions covering:
- Local development (SQLite, no ML weights required)
- Full ML pipeline setup with PyTorch, XGBoost, Ultralytics
- PostgreSQL + PostGIS production setup
- Docker Compose full-stack deployment

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature-name`
3. Write tests for new AI layers or API endpoints
4. Run linting: `cd frontend && npm run lint` / `cd backend && ruff check .`
5. Open a Pull Request with a clear description of the change

**Key conventions:**
- All new AI layers must implement a physics-based synthetic fallback
- Pydantic v2 schemas for all request/response bodies
- Async-first: all route handlers and DB operations use `async/await`
- Environment-agnostic: code must run on SQLite and PostgreSQL without modification

---

*ECO-3D — Building the future, sustainably, one plot at a time.*
