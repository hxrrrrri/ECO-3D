# ECO-3D — Complete Setup Guide (A to Z)

> This guide takes you from zero to a fully running ECO-3D instance. Follow **Section 1** for a zero-config 5-minute quickstart, then proceed to later sections to unlock full AI capabilities and production deployment.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Quick Start — No ML Required](#2-quick-start--no-ml-required)
3. [Backend Configuration](#3-backend-configuration)
4. [Frontend Configuration](#4-frontend-configuration)
5. [ML Model Setup (Full AI Pipeline)](#5-ml-model-setup-full-ai-pipeline)
6. [PostgreSQL + PostGIS (Production Database)](#6-postgresql--postgis-production-database)
7. [Docker Compose — Full Stack](#7-docker-compose--full-stack)
8. [External API Keys](#8-external-api-keys)
9. [Running in Production (Systemd / PM2)](#9-running-in-production-systemd--pm2)
10. [Troubleshooting](#10-troubleshooting)
11. [Development Tips](#11-development-tips)

---

## 1. Prerequisites

### Minimum (Quick Start)
| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 18.x | [nodejs.org](https://nodejs.org) |
| Python | ≥ 3.11 | [python.org](https://python.org) |
| pip | ≥ 23.x | Bundled with Python |
| git | Any | For cloning |

### Full ML Pipeline (Optional)
| Tool | Purpose |
|---|---|
| CUDA-capable GPU | Dramatically speeds up DeepLabV3 and YOLOv8 inference |
| CUDA ≥ 11.8 | Required for GPU-accelerated PyTorch |
| 8GB+ RAM | XGBoost training + PyTorch inference |

### Production Extras
| Tool | Purpose |
|---|---|
| Docker ≥ 24 | Container orchestration |
| Docker Compose ≥ 2.x | Multi-service orchestration |
| PostgreSQL 16 + PostGIS 3.4 | Production-grade spatial database |

---

## 2. Quick Start — No ML Required

The backend auto-detects missing ML weights and uses **physics-based synthetic fallbacks** for every AI layer. The application is fully functional — analysis results, floor plans, and 3D models all work without any ML installation.

### Step 1: Clone the Repository

```bash
git clone https://github.com/your-org/eco3d.git
cd eco3d
```

### Step 2: Backend Setup

```bash
cd backend

# Create isolated virtual environment
python3 -m venv venv

# Activate virtual environment
source venv/bin/activate          # Linux / macOS
# venv\Scripts\activate.bat       # Windows CMD
# venv\Scripts\Activate.ps1       # Windows PowerShell

# Install Python dependencies (core only, no ML libs)
pip install -r requirements.txt

# Copy environment configuration
cp ../.env.example .env

# The database auto-creates (SQLite). No migration command needed.
# Start the backend server
uvicorn main:app --reload --port 8000
```

**Verify:** Open [http://localhost:8000/docs](http://localhost:8000/docs) — you should see the Swagger UI with all API endpoints.

**Verify:** `curl http://localhost:8000/health` → `{"status":"ok","version":"2.0.0"}`

### Step 3: Frontend Setup

Open a **new terminal**:

```bash
cd frontend

# Install Node dependencies (~2 minutes first time)
npm install

# Point frontend at the local backend
echo "NEXT_PUBLIC_API_URL=http://localhost:8000" > .env.local

# Start the development server
npm run dev
```

**Verify:** Open [http://localhost:3000](http://localhost:3000) — the ECO-3D landing page should appear.

### Step 4: Create an Account and Test

1. Navigate to [http://localhost:3000/signup](http://localhost:3000/signup)
2. Create an account with any email/password
3. Log in at [http://localhost:3000/login](http://localhost:3000/login)
4. Navigate to [http://localhost:3000/map](http://localhost:3000/map)
5. Click anywhere on the map to place a plot marker
6. Click **Analyze Plot** — the 5-layer pipeline runs (using synthetic fallbacks)
7. View results in the Analysis, Floor Plan, and 3D Model tabs

> **Expected time to first result:** ~3–8 seconds (synthetic mode)

---

## 3. Backend Configuration

### The `.env` File

Copy `.env.example` to `backend/.env` and customize:

```env
# ── Database ──────────────────────────────────────────────────────────────────
# Development (zero config — auto-creates eco3d.db in backend/)
DATABASE_URL=sqlite+aiosqlite:///./eco3d.db

# Production (PostgreSQL with PostGIS)
# DATABASE_URL=postgresql+asyncpg://eco3d:eco3d@localhost:5432/eco3d

# ── Security ──────────────────────────────────────────────────────────────────
# Generate with: python3 -c "import secrets; print(secrets.token_hex(32))"
SECRET_KEY=your-super-secret-key-replace-this-in-production

# JWT token lifetime in minutes (1440 = 24 hours)
ACCESS_TOKEN_EXPIRE_MINUTES=1440

# ── External APIs (all optional — synthetic fallback when missing) ─────────────
OPENWEATHER_API_KEY=your_openweathermap_api_key
MAPBOX_TOKEN=your_mapbox_token

# ── Redis (optional — advanced SSE / Celery task queue) ───────────────────────
REDIS_URL=redis://localhost:6379

# ── ML Weights Directory ──────────────────────────────────────────────────────
# Where trained model .pkl and .pth files are stored
WEIGHTS_DIR=training/weights
```

### Key Backend Files

| File | Purpose |
|---|---|
| `main.py` | FastAPI app initialization, CORS, router registration |
| `config.py` | Loads `.env` via `python-dotenv` |
| `database/connection.py` | SQLAlchemy async engine factory (SQLite ↔ PostgreSQL) |
| `database/session.py` | `get_db()` FastAPI dependency for request-scoped sessions |
| `services/analysis_pipeline.py` | 5-layer AI orchestrator with full crash isolation |

### Running Backend in Different Modes

```bash
# Development (auto-reload on code changes)
uvicorn main:app --reload --port 8000

# Development with verbose logging
uvicorn main:app --reload --port 8000 --log-level debug

# Production (4 workers, no reload)
uvicorn main:app --host 0.0.0.0 --port 8000 --workers 4

# With Gunicorn process manager (recommended for production)
pip install gunicorn
gunicorn main:app -w 4 -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:8000
```

---

## 4. Frontend Configuration

### Environment Variables

The frontend reads a single required variable:

```bash
# frontend/.env.local
NEXT_PUBLIC_API_URL=http://localhost:8000     # Development
# NEXT_PUBLIC_API_URL=https://api.yourdomain.com  # Production
```

### Key Frontend Scripts

```bash
npm run dev        # Start development server (hot reload, port 3000)
npm run build      # Production build (outputs to .next/)
npm run start      # Serve the production build
npm run lint       # ESLint check
```

### Next.js Configuration (`next.config.js`)

Image domains for satellite tiles and remote assets are pre-configured. If you add a custom CDN or Mapbox domain, add it to `images.domains`.

---

## 5. ML Model Setup (Full AI Pipeline)

Skip this section if you are satisfied with synthetic fallbacks. Follow these steps to enable the authentic ML pipeline.

### Step 1: Install ML Dependencies

In `backend/requirements.txt`, the ML packages are listed. Install them:

```bash
cd backend
source venv/bin/activate

# Install full ML stack (~2-4GB download including PyTorch)
pip install torch>=2.0.0 torchvision>=0.15.0 torchaudio --index-url https://download.pytorch.org/whl/cu118
# OR CPU-only (smaller):
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu

pip install xgboost>=2.0.0 scikit-learn>=1.4.0 ultralytics>=8.0.0 pillow requests
```

### Step 2: Generate Training Data

```bash
cd scripts
python generate_synthetic_data.py
```

This generates `data/flood_training.csv` (2,000 rows) and `data/buildability_training.csv` (3,000 rows) using physics-based simulation equations.

### Step 3: Train the XGBoost Flood Model

```bash
python train_flood_model.py
```

Training takes ~30 seconds on CPU. Saves weights to `backend/training/weights/flood_xgboost.pkl`.

Expected output:
```
Training XGBoost Flood Risk model on 2000 samples...
  Features: elevation, slope, ndvi, rainfall_mm, soil_stability, distance_to_water
  n_estimators=200, max_depth=6, learning_rate=0.05
Training complete. RMSE: 0.042, R²: 0.94
Saved: backend/training/weights/flood_xgboost.pkl
```

### Step 4: Train the MLP Buildability Model

```bash
python train_buildability_model.py
```

Training takes ~60 seconds on CPU (200 epochs). Saves to `backend/training/weights/buildability_mlp.pkl`.

Expected output:
```
Training MLP Buildability model on 3000 samples...
  Architecture: Linear(6→64)→ReLU→Dropout→Linear(64→128)→ReLU→Dropout→Linear(128→64)→ReLU→Linear(64→1)
  Optimizer: Adam, lr=1e-3, weight_decay=1e-4, MSELoss
  Epoch 0: loss=412.3
  Epoch 50: loss=89.1
  Epoch 100: loss=45.2
  Epoch 150: loss=31.8
  Epoch 200: loss=28.4
Training complete. MAE: 4.2, R²: 0.91
Saved: backend/training/weights/buildability_mlp.pkl
```

### Step 5: Download Pre-trained Computer Vision Weights

```bash
# YOLOv8n base weights (auto-downloaded by ultralytics on first run)
# OR download manually:
wget https://github.com/ultralytics/assets/releases/download/v0.0.0/yolov8n.pt -O backend/yolov8n.pt

# DeepLabV3+ResNet50 weights (auto-downloaded by torchvision on first use)
# The model auto-downloads on first call to SatelliteSegmenter._load_model()
```

> **Note:** Fine-tuned tree-specific YOLOv8 weights (`yolov8_trees.pt`) require a custom dataset (e.g., iTree dataset, Mapillary Vistas). The base `yolov8n.pt` is used with proxy class mapping until fine-tuning is performed.

### Step 6: Set the Weights Directory

Ensure `WEIGHTS_DIR` in your `.env` points to the correct location:

```env
WEIGHTS_DIR=training/weights
```

**After this setup:** Restart the backend server. The startup logs should show:
```
Loading XGBoost flood model from training/weights/flood_xgboost.pkl
Loading MLP buildability model from training/weights/buildability_mlp.pkl
Loading YOLOv8 tree weights / Loading DeepLabV3 weights
ECO-3D backend ready
```

### Model Evaluation

```bash
cd scripts
python evaluate_models.py
```

Outputs confusion matrices, RMSE, R², and feature importance charts for both trained models.

---

## 6. PostgreSQL + PostGIS (Production Database)

### Option A: Docker (Recommended)

```bash
docker run -d \
  --name eco3d-postgres \
  -e POSTGRES_USER=eco3d \
  -e POSTGRES_PASSWORD=eco3d \
  -e POSTGRES_DB=eco3d \
  -p 5432:5432 \
  -v eco3d_pgdata:/var/lib/postgresql/data \
  postgis/postgis:16-3.4
```

Wait 10 seconds, then verify:
```bash
docker exec -it eco3d-postgres psql -U eco3d -c "SELECT PostGIS_Version();"
```

### Option B: Native Linux (Ubuntu/Debian)

```bash
sudo apt update && sudo apt install -y postgresql-16 postgresql-16-postgis-3

sudo -u postgres psql << 'EOF'
CREATE USER eco3d WITH PASSWORD 'eco3d';
CREATE DATABASE eco3d OWNER eco3d;
\c eco3d
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
EOF
```

### Option C: macOS with Homebrew

```bash
brew install postgresql@16
brew services start postgresql@16
brew install postgis

psql postgres << 'EOF'
CREATE USER eco3d WITH PASSWORD 'eco3d';
CREATE DATABASE eco3d OWNER eco3d;
\c eco3d
CREATE EXTENSION IF NOT EXISTS postgis;
EOF
```

### Option D: Windows

1. Download [PostgreSQL 16 installer](https://www.postgresql.org/download/windows/)
2. During installation, note the port (default: 5432) and superuser password
3. Open pgAdmin → Create user `eco3d`, database `eco3d`
4. Open Query Tool on `eco3d` database and run:
   ```sql
   CREATE EXTENSION IF NOT EXISTS postgis;
   CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
   ```

### Link Backend to PostgreSQL

Update `backend/.env`:
```env
DATABASE_URL=postgresql+asyncpg://eco3d:eco3d@localhost:5432/eco3d
```

Also install the async PostgreSQL driver:
```bash
pip install asyncpg psycopg2-binary
```

Restart the backend — tables are auto-created via SQLAlchemy `create_all` on startup.

---

## 7. Docker Compose — Full Stack

The entire application (Frontend, Backend, PostgreSQL) runs with a single command:

```bash
# From project root
cp .env.example .env
# Edit .env with your SECRET_KEY and any API keys

docker-compose -f docker/docker-compose.yml up --build -d
```

| Service | Port | URL |
|---|---|---|
| Frontend (Next.js) | 3000 | http://localhost:3000 |
| Backend (FastAPI) | 8000 | http://localhost:8000 |
| PostgreSQL | 5432 | postgresql://eco3d:eco3d@localhost:5432/eco3d |

To view logs:
```bash
docker-compose -f docker/docker-compose.yml logs -f backend
docker-compose -f docker/docker-compose.yml logs -f frontend
```

To stop:
```bash
docker-compose -f docker/docker-compose.yml down
# To also delete database volume:
docker-compose -f docker/docker-compose.yml down -v
```

---

## 8. External API Keys

All external APIs are optional. Synthetic fallbacks activate automatically when keys are absent.

### OpenWeatherMap (Rainfall Data)

1. Register at [openweathermap.org/api](https://openweathermap.org/api)
2. Generate a free API key (Free tier: 1,000 calls/day)
3. Set in `.env`: `OPENWEATHER_API_KEY=your_key_here`

**Impact:** Without this key, annual rainfall is estimated from latitude-band climatological averages (±300mm accuracy).

### Mapbox (Satellite Tiles)

1. Register at [mapbox.com](https://account.mapbox.com/auth/signup/)
2. Create a public token with `styles:tiles` scope
3. Set in `.env`: `MAPBOX_TOKEN=pk.eyJ1Ijoixxxxxxx...`
4. In `frontend/.env.local`: `NEXT_PUBLIC_MAPBOX_TOKEN=pk.eyJ1Ijoixxxxxxx...`

**Impact:** Without this token, OpenStreetMap standard tiles are used (no satellite imagery). The AI pipeline continues to function identically.

### Open-Elevation API

Used automatically (no key required) at `https://api.open-elevation.com`. Rate-limited at ~100 req/min. For high-volume production use, consider self-hosting the [Open-Elevation server](https://github.com/Jorl17/open-elevation).

---

## 9. Running in Production (Systemd / PM2)

### Backend — Systemd Service

```bash
sudo nano /etc/systemd/system/eco3d-backend.service
```

```ini
[Unit]
Description=ECO-3D FastAPI Backend
After=network.target postgresql.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/eco3d/backend
Environment="PATH=/opt/eco3d/backend/venv/bin"
EnvironmentFile=/opt/eco3d/backend/.env
ExecStart=/opt/eco3d/backend/venv/bin/gunicorn main:app \
    -w 4 -k uvicorn.workers.UvicornWorker \
    --bind 0.0.0.0:8000 \
    --timeout 120 \
    --access-logfile /var/log/eco3d/backend.log
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable eco3d-backend
sudo systemctl start eco3d-backend
sudo systemctl status eco3d-backend
```

### Frontend — PM2

```bash
npm install -g pm2
cd /opt/eco3d/frontend
npm run build
pm2 start npm --name "eco3d-frontend" -- start
pm2 save
pm2 startup   # Follow the printed command to enable on boot
```

### Nginx Reverse Proxy

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    # Frontend
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    # Backend API
    location /api/ {
        rewrite ^/api/(.*) /$1 break;
        proxy_pass http://localhost:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # SSE support — disable buffering for /notifications/stream
        location /api/notifications/stream {
            proxy_pass http://localhost:8000/notifications/stream;
            proxy_buffering off;
            proxy_cache off;
            proxy_read_timeout 86400s;
        }
    }
}
```

---

## 10. Troubleshooting

### Backend won't start: "ModuleNotFoundError"

```bash
cd backend
source venv/bin/activate
pip install -r requirements.txt
```

Ensure you are inside the virtual environment (`(venv)` prefix in terminal).

### "CORS error" in browser console

The backend has `allow_origins=["*"]` by default (development mode). If you've restricted this in production, add your frontend domain to `CORSMiddleware` in `main.py`.

### "SQLite does not support..." error

Some SQLAlchemy operations (e.g., `ALTER TABLE`) are limited in SQLite. For development, delete `eco3d.db` to reset:
```bash
rm backend/eco3d.db
# Tables auto-recreate on next server start
```

### 3D model not visible / black screen

- Ensure WebGL is enabled in your browser (most modern browsers enable it by default)
- Disable browser hardware acceleration blockers or extensions
- Check browser console for Three.js errors

### XGBoost or PyTorch ImportError

These libraries are not installed by default. To install:
```bash
pip install xgboost torch torchvision
```
Or remove them from requirements and let the synthetic fallback handle it.

### SSE stream disconnects immediately

Ensure Nginx (if used) has `proxy_buffering off` for the `/notifications/stream` endpoint. Also check that the backend is running and the JWT token in `localStorage` is valid.

### YOLOv8 / Ultralytics "model file not found"

```bash
# Download the base YOLOv8n weights manually
wget https://github.com/ultralytics/assets/releases/download/v0.0.0/yolov8n.pt
mv yolov8n.pt backend/yolov8n.pt
```

---

## 11. Development Tips

### Useful Backend Commands

```bash
# Inspect the SQLite database
sqlite3 backend/eco3d.db ".tables"
sqlite3 backend/eco3d.db "SELECT * FROM users;"
sqlite3 backend/eco3d.db "SELECT plot_id, buildability_score FROM analyses;"

# Test the analysis endpoint directly
curl -X POST http://localhost:8000/analyze-plot \
  -H "Content-Type: application/json" \
  -d '{"plot_id":"TEST-001","lat":9.9312,"lon":76.2673}'

# Generate a floor plan
curl -X POST http://localhost:8000/generate-floorplan \
  -H "Content-Type: application/json" \
  -d '{"plot_id":"TEST-001","plot_area_sqm":500,"num_floors":1}'
```

### VS Code Extensions Recommended

- Python (Microsoft)
- Pylance
- ESLint
- Tailwind CSS IntelliSense
- Prisma (for schema visualization if migrating to Prisma ORM)
- REST Client (for `.http` file testing)

### Adding a New Room Type to the Floor Plan

1. Add a new entry to `ROOM_TEMPLATES["sustainable"]` in `backend/ai/floorplan/genetic.py`
2. Add a corresponding color entry to the `ACCENTS` dict in `frontend/app/model3d/[id]/page.tsx`
3. Add a furniture render function following the existing pattern (e.g., `renderBedroom`)

### Running Unit Tests

```bash
# Backend (pytest)
cd backend
pip install pytest pytest-asyncio httpx
pytest tests/ -v

# Frontend
cd frontend
npm run test
```

---

*For further questions, open an issue on the repository or consult the inline code documentation throughout `backend/ai/` and `frontend/app/`.*
