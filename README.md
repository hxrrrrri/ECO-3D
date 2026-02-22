# ECO-3D — AI-Powered Sustainable Architecture Platform

![ECO-3D Banner](eco3d-banner.png) <!-- Replace with actual banner image if available -->

**ECO-3D** is a cutting-edge, end-to-end sustainable land development platform. It empowers urban planners, architects, and real estate developers with deep spatial intelligence to design eco-friendly, optimized, and flood-resilient infrastructure. From high-resolution satellite imagery analysis to automated 3D floor plan generation, ECO-3D provides a full suite of AI tools to rapidly prototype green communities while adhering to climate resilience standards.

---

## 🚀 Key Features Overview

The platform is designed to be a completely self-contained ecosystem, encompassing the following core pillars:

### 1. Interactive 3D Mapping & Plot Selection
- **Global Satellite Maps**: Users can interact with high-resolution satellite maps (powered by Leaflet & Mapbox) to navigate anywhere globally.
- **Custom Polygon Selection**: Users can drop pins or draw custom bounding boxes to select specific plots of land for evaluation.
- **Boundary Analysis**: Real-time evaluation of the selected boundary dimensions, area, and geographical coordinates.

### 2. The 5-Layer AI Analysis Pipeline
Once a plot is selected, the `POST /analyze-plot` endpoint triggers a sophisticated, sequential AI pipeline:
- **Layer 1 (Computer Vision)**: DeepLabV3 performs semantic segmentation on satellite imagery (extracting roads, buildings, water bodies), while YOLOv8 detects individual trees to calculate canopy cover.
- **Layer 2 (Environmental Feature Engineering)**: Calculates crucial metrics including NDVI (Normalized Difference Vegetation Index), Slope (via DEM models), Elevation, Rainfall, Soil Type, Wind patterns, and Sun Exposure.
- **Layer 3 (Flood Risk Modeling)**: An XGBoost Machine Learning model estimates the `flood_probability` (0.0 to 1.0) based on historical and topographical data.
- **Layer 4 (Buildability Scoring)**: A Multi-Layer Perceptron (MLP) Neural Network computes a `buildability_score` (0-100) evaluating the land's suitability for sustainable construction.
- **Layer 5 (Gen-AI Floor Plan Generation)**: A Genetic Algorithm optimizes room layouts by maximizing natural sunlight, cross-ventilation, and preserving existing trees, resulting in a structured JSON layout.

### 3. Real-Time 3D Visualization & Reporting
- **Dynamic 3D Models**: The optimized 2D layout JSON is passed to the Next.js frontend, where `React Three Fiber` (Three.js) extrudes the floor plan into an interactive 3D model.
- **Environmental Simulations**: The 3D viewer simulates sunlight direction and animates wind vectors.
- **Comprehensive Dashboards**: Users receive actionable insights via dynamic charts and comprehensive PDF/UI reports.

### 4. User Ecosystem & Security
- **Authentication**: Secure JWT-based registration and login system.
- **Live Updates**: Server-Sent Events (SSE) provide real-time, asynchronous notifications to the user interface (e.g., when a complex AI analysis finishes).
- **Product Suites**: Dedicated modules for `Insights`, `Registry` (Carbon/Real Estate tracking), and predefined `Solutions`.

---

## 🏗 Architecture & Data Flow

```text
┌─────────────────────────────────────────────────────────────────┐
│  FRONTEND (Next.js 14 App Router)                               │
│  ┌──────────┐ ┌────────────┐ ┌──────────┐ ┌────────────────┐   │
│  │ Landing, │ │ Auth/Reg   │ │ Map/Plot │ │ Analysis/3D  │   │
│  │ Product  │ │ Login/Sign │ │ map/page │ │ floorplan    │   │
│  └──────────┘ └────────────┘ └──────────┘ └────────────────┘   │
│              Zustand Global State Store                         │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP/JSON + JWT Token (Auth) + SSE
┌──────────────────────────▼──────────────────────────────────────┐
│  BACKEND (FastAPI)                                              │
│  POST /auth/login   →  JWT Authentication                       │
│  GET  /notifications→  Real-time SSE updates                    │
│  POST /analyze-plot →  Sequential AI Pipeline                   │
│  POST /generate-     →  Genetic Algorithm                        │
│       floorplan                                                 │
│  GET  /report/{id}  →  Persisted Results                        │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│  AI LAYER STACK                                                 │
│  ┌─────────────┐ ┌──────────────┐ ┌──────────────────────────┐ │
│  │ LAYER 1     │ │  LAYER 2     │ │ LAYER 3                  │ │
│  │ DeepLabV3   │ │ Environmental│ │ XGBoost Flood            │ │
│  │ Segmentation│ │ Feature Eng  │ │ Risk Model               │ │
│  │ YOLOv8 Trees│ │ NDVI/Slope/  │ │ P(flood) 0-1            │ │
│  └─────────────┘ │ DEM/Rainfall │ └──────────────────────────┘ │
│                  └──────────────┘                               │
│  ┌─────────────┐ ┌──────────────────────────────────────────┐  │
│  │ LAYER 4     │ │ LAYER 5                                  │  │
│  │ MLP Neural  │ │ Genetic Algorithm Floor Plan Generator   │  │
│  │ Buildability│ │ Sunlight + Ventilation + Tree Preserve   │  │
│  │ Score 0-100 │ │ → Structured Layout JSON                 │  │
│  └─────────────┘ └──────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│  PERSISTENCE                                                    │
│  PostgreSQL + PostGIS  →  Users, Notifications, Plots, Results  │
└─────────────────────────────────────────────────────────────────┘
```

**Data Lifecycle Example:**
1. A logged-in user drops a pin on the `MapComponent.tsx`.
2. Frontend triggers `POST /analyze-plot`.
3. Backend runs Layers 1-4 asynchronously.
4. User receives real-time updates via `GET /notifications/stream` (SSE).
5. Once complete, the user clicks "Generate Floor Plan" triggering Layer 5.
6. The resulting JSON geometry is rendered in the browser via WebGL/Three.js.

---

## 🛠 Technology Stack

### Frontend
- **Framework**: Next.js 14 (App Router)
- **UI & Styling**: React 18, Tailwind CSS, Framer Motion (Micro-animations)
- **State Management**: Zustand
- **3D & Mapping**: React Three Fiber, Drei, Three.js, React-Leaflet
- **Data Fetching**: Axios

### Backend
- **Framework**: FastAPI (Python 3.11+)
- **Concurrency**: Uvicorn (ASGI), AsyncIO
- **Security**: JWT tokens, bcrypt (password hashing), Python-jose
- **Database**: SQLAlchemy 2.0 ORM, SQLite (dev default), PostgreSQL + PostGIS (Production)
- **Real-Time Responses**: Starlette `EventSourceResponse` (SSE)

### AI & Machine Learning Tools
- **Deep Learning Framework**: PyTorch, Torchvision
- **Computer Vision**: Ultralytics (YOLOv8)
- **Machine Learning**: Scikit-Learn, XGBoost
- **Data Processing**: Numpy, Pillow

---

## 📂 Project Directory Structure

```text
eco3d/
├── frontend/               # Next.js 14 App Router
│   ├── app/
│   │   ├── page.tsx            # Landing page (Marketing & Hero)
│   │   ├── map/page.tsx        # Interactive satellite map (Leaflet)
│   │   ├── login/page.tsx      # User Login (JWT Flow)
│   │   ├── signup/page.tsx     # User Sign Up
│   │   ├── product/page.tsx    # Product Overview View
│   │   ├── solutions/page.tsx  # Specific Industry Solutions
│   │   ├── registry/page.tsx   # Carbon/Real Estate Registry
│   │   ├── insights/page.tsx   # User Dashboard & Deep Insights
│   │   ├── analysis/[id]/page.tsx  # AI Results Dashboard
│   │   ├── floorplan/[id]/page.tsx # 2D Generated Layout Viewer
│   │   ├── model3d/[id]/page.tsx   # WebGL 3D Interactive Model Viewer
│   │   └── report/[id]/page.tsx    # Summary Report View
│   ├── components/         # Reusable UI (Buttons, Modals, Nav, Maps)
│   ├── store/              # Zustand global state (useEco3DStore.ts)
│   ├── lib/                # API clients and utility functions
│   └── types/              # TypeScript interfaces
├── backend/
│   ├── main.py             # FastAPI entry point, CORS, and Lifespans
│   ├── config.py           # Environment variables, JWT configuration settings
│   ├── routes/             # API Endpoints
│   │   ├── analysis.py     # Triggers AI pipeline
│   │   ├── floorplan.py    # Triggers Gen-AI
│   │   ├── plots.py        # CRUD for Plots
│   │   ├── auth.py         # Login, Signup, Me
│   │   ├── notifications.py# SSE Streaming & CRUD
│   │   └── boundary.py     # Polygon evaluation
│   ├── models/             
│   │   ├── schemas.py      # Pydantic (Request/Response validation)
│   │   └── db_models.py    # SQLAlchemy (Database tables)
│   ├── services/           # Core Business Logic (AI integration, Auth functions)
│   ├── database/           # SQLite / Postgres connections & DB sessions
│   └── ai/                 # Deep Learning Models & Weights
│       ├── segmentation/   # DeepLabV3
│       ├── detection/      # YOLOv8
│       ├── features/       # Environmental metrics
│       ├── flood/          # XGBoost logic
│       ├── buildability/   # MLP Neural nets
│       └── floorplan/      # Genetic algorithm logic
├── scripts/                # Utility scripts for training ML models & generating data
└── docker/                 # Containerization rules (Dockerfile, docker-compose)
```

---

## 📡 Complete API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/auth/signup` | Register a new user account |
| POST | `/auth/login` | Authenticate user and obtain secure JWT token |
| GET | `/auth/me` | Fetch active logged-in user profile data |
| GET | `/notifications/stream` | Real-time Server-Sent Events (SSE) notification stream |
| GET | `/notifications` | Fetch user notification history |
| PATCH | `/notifications/{id}/read` | Mark individual notification as read |
| POST | `/boundary/analyze` | Evaluate Map bounding box features |
| POST | `/analyze-plot` | Execute the full multi-layer AI analysis pipeline |
| POST | `/generate-floorplan` | Run Genetic Algorithms for 2D/3D Floor plan generation |
| GET | `/report/{plot_id}` | Fetch persisted comprehensive plot report |
| GET | `/plots` | List all analyzed plots for the current user |
| GET | `/health` | Application health and version check |

---

## ⚙️ Getting Started

To get the application running on your local machine, please follow the detailed steps outlined in our [SETUP.md](./SETUP.md) guide. It covers everything from installing dependencies, setting up PostgreSQL (or using the default zero-config SQLite), and running the Next.js and FastAPI servers.
