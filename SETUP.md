# ECO-3D Platform — Comprehensive Setup Guide

This guide covers everything you need to know from A to Z to run the ECO-3D platform locally. Our architecture is designed to be developer-friendly. It runs seamlessly out of the box using synthetic AI responses and a zero-configuration SQLite database. We also provide instructions for scaling up to a production-ready environment with PostgreSQL and trained ML models.

---

## 🌟 Overview & Components
The ecosystem is split into two primarily distinct environments:
1. **Frontend**: A Next.js 14 App Router application. Handles user authentication, interactive maps (Leaflet), complex dashboards, and a specialized 3D WebGL viewer (Three.js/React Three Fiber).
2. **Backend**: A robust FastAPI application utilizing AsyncIO. It handles everything from JWT-based Security and Server-Sent Events (SSE), to executing heavy Machine Learning and Computer Vision pipelines.

---

## ⚡ Quick Start (Development Mode)

This is the fastest path to running the project. **No PostgreSQL or Machine Learning setup is required!** The application defaults to an automated SQLite database and provides synthetic, highly realistic responses if ML models are uninitialized.

### Prerequisites
- **Node.js**: `v18.x` or higher
- **Python**: `v3.11` or higher

### Step 1: Backend Setup
The backend serves the REST API, Authentication logic, and AI endpoints.

```bash
cd backend

# Create isolated virtual environment
python3 -m venv venv

# Activate virtual environment
source venv/bin/activate        # On Linux/Mac
# venv\Scripts\activate         # On Windows 

# Install required Python dependencies
pip install -r requirements.txt

# Configure Environment Variables
cp ../.env.example .env

# Run database schema migrations (auto-creates eco3d.db)
alembic upgrade head

# Start the ASGI server
uvicorn main:app --reload --port 8000
```
- **Backend API URL**: [http://localhost:8000](http://localhost:8000)
- **Interactive API Swagger Docs**: [http://localhost:8000/docs](http://localhost:8000/docs)

### Step 2: Frontend Setup
The frontend consumes the FastAPI endpoints and provides the interactive dashboard.

```bash
cd frontend

# Install Node dependencies
npm install

# Configure Environment
# Ensure NEXT_PUBLIC_API_URL points to the backend
echo "NEXT_PUBLIC_API_URL=http://localhost:8000" > .env.local

# Start the Next.js development server
npm run dev
```
- **Frontend App URL**: [http://localhost:3000](http://localhost:3000)

*(You can now navigate to localhost:3000, create an account using the UI, login, select a plot on the map, and view the AI insights and 3D floor models).*

---

## 🏢 Production Mode: PostgreSQL + PostGIS Integration

While SQLite is fantastic for rapid iteration and testing, an architectural intelligence platform handles highly complex spatial and relational data. For staging or production, PostgreSQL with the PostGIS spatial extension is recommended.

### Option A: Setup via Docker (Easiest & Recommended)
We recommend containerizing the database to avoid polluting your host machine.
```bash
# Pull and execute the PostGIS optimized postgres image
docker run -d \
  --name eco3d-postgres \
  -e POSTGRES_USER=eco3d \
  -e POSTGRES_PASSWORD=eco3d \
  -e POSTGRES_DB=eco3d \
  -p 5432:5432 \
  postgis/postgis:16-3.4
```

### Option B: Local Installation setup

<details>
<summary><b>macOS Setup</b></summary>

```bash
brew install postgresql@16
brew services start postgresql@16
psql postgres -c "CREATE USER eco3d WITH PASSWORD 'eco3d';"
psql postgres -c "CREATE DATABASE eco3d OWNER eco3d;"
```
</details>

<details>
<summary><b>Ubuntu/Debian Setup</b></summary>

```bash
sudo apt update && sudo apt install postgresql postgresql-contrib
sudo -u postgres psql -c "CREATE USER eco3d WITH PASSWORD 'eco3d';"
sudo -u postgres psql -c "CREATE DATABASE eco3d OWNER eco3d;"

# Install PostGIS for spatial queries:
sudo apt install postgresql-postgis
sudo -u postgres psql eco3d -c "CREATE EXTENSION IF NOT EXISTS postgis;"
```
</details>

<details>
<summary><b>Windows Setup</b></summary>

1. Download the installer from [PostgreSQL downloads](https://www.postgresql.org/download/windows/).
2. Run installer, set the password for the `postgres` user.
3. Open pgAdmin or psql shell and query:
   ```sql
   CREATE USER eco3d WITH PASSWORD 'eco3d';
   CREATE DATABASE eco3d OWNER eco3d;
   ```
</details>

### Linking Backend to Postgres
Update the `.env` file in the `backend/` directory to point to PostgreSQL using the `asyncpg` engine:
```env
# Switch from sqlite to postgres
DATABASE_URL=postgresql+asyncpg://eco3d:eco3d@localhost:5432/eco3d
```
Then restart your `uvicorn` server to apply the changes.

---

## 🧠 AI Models: Training & Execution

The backend dynamically detects if machine learning weights are present. If missing, it uses an internal fallback service to generate synthetic structural insights. To run the authentic pipeline locally:

1. **Activate ML Dependencies**: Open `backend/requirements.txt` and uncomment the AI stack:
   ```text
   torch>=2.0.0
   torchvision>=0.15.0
   xgboost>=2.0.0
   scikit-learn>=1.4.0
   ultralytics>=8.0.0
   ```
2. Run `pip install -r requirements.txt` again to download PyTorch and specific analytics libraries.
3. **Train Models**: Navigate to the `scripts/` directory to synthesize training data and execute building ML logic.
   ```bash
   cd scripts
   python generate_synthetic_data.py    # Synthesizes datasets based on historical geospatial data
   python train_flood_model.py          # Trains the XGBoost Flood prediction model
   python train_buildability_model.py   # Trains the Neural Network (MLP) for structural buildability scoring
   ```
4. **Link Weights**: Ensure the resulting `.pt` or `.json` weight files are placed correctly in `backend/ai/*/weights/`.

*(Note: Layer 1 segmentation requires downloading pre-trained DeepLabV3 and YOLOv8n weights directly from standard repositories).*

---

## 🐋 Full Stack Docker Compose 
Alternatively, the entire stack (Frontend, Backend, and PostgreSQL) can be orchestrated using Docker Compose.

```bash
# Ensure you are in the project root directory
cp .env.example .env   # Update the .env file with appropriate keys

# Build and execute all containers
docker-compose -f docker/docker-compose.yml up --build -d
```
- The frontend maps to host port `:3000`
- The backend API maps to host port `:8000`

---

## 🔑 Crucial Environment Variables

Below is a reference of important variables detailed in your `.env` file that impact platform capabilities:

| Variable | Description | Default / Example Value |
|----------|-------------|-------------------------|
| `DATABASE_URL` | SQLAlchemy connection string | `sqlite+aiosqlite:///./eco3d.db` |
| `SECRET_KEY` | Crucial string utilized for JWT Authentication | `<your-secure-random-string>` |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | Lifecycle lifespan of API access tokens | `1440` (24 Hours) |
| `REDIS_URL` | Used for async queuing or advanced SSE streaming | `redis://redis:6379` |
| `OPENWEATHER_API_KEY` | Fetches external climate/rainfall data | `<your-api-key>` |
| `MAPBOX_TOKEN` | Generates detailed Map tile structures | `<your-api-key>` |

*(Always keep your `.env` excluded via `.gitignore` to prevent secret leakage).*
