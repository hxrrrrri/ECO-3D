# ECO-3D Studio — Bug Fixes, Runtime Issues & Applied Improvements

This document catalogs every confirmed bug, potential runtime error, dependency issue, and improvement discovered through code analysis and iterative development of ECO-3D Studio v2.1.

---

## Critical Bug Fixes (Production-Breaking)

---

### Fix 1 — Database Models: PostgreSQL UUID on SQLite

**File:** `backend/database/models.py`
**Severity:** CRITICAL — application crashes on first DB operation in dev

**Root Cause:**
The original models imported `from sqlalchemy.dialects.postgresql import UUID` and used it as the primary key type for **all tables**. This PostgreSQL-specific dialect type crashes completely on SQLite (the default development database), causing a 500 error the moment any database operation is attempted — including `/analyze-plot`, `/auth/signup`, and `/auth/login`.

**Fix Applied:**
Replaced with a conditional UUID strategy:
- **SQLite** (dev default): uses `String(36)` columns with `str(uuid.uuid4())` Python defaults
- **PostgreSQL** (production): keeps the native `UUID` type from the postgresql dialect

```python
# Before (broken on SQLite)
from sqlalchemy.dialects.postgresql import UUID
id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

# After (works on both)
import os
DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite")
if "postgresql" in DATABASE_URL:
    from sqlalchemy.dialects.postgresql import UUID
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
else:
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
```

This is a zero-logic-change fix — the data stored is identical; only the column declaration adapts to the database engine.

---

### Fix 2 — Plot ID Format Creates Broken URL Routes

**File:** `frontend/store/useEco3DStore.ts`
**Severity:** CRITICAL — URL routing fails for most of the world's coordinates

**Root Cause:**
Plot IDs were generated using:
```typescript
`PLOT-${Math.floor(lat * 1000)}-${Math.floor(lon * 1000)}`
```

For locations with negative coordinates (any location in the western hemisphere, southern hemisphere, or both — meaning most of the globe outside the NE quadrant), this produces IDs like `PLOT-9825--769` (double-dash) or `PLOT--3310--769`. These malformed IDs caused:
- URL routing failures at `/analysis/PLOT--3310--769`
- Next.js dynamic route parsing errors (`[id]` parameter broken)
- API calls to the backend with invalid plot ID strings

**Fix Applied:**
```typescript
// Before
currentPlotId: `PLOT-${Math.floor(lat * 1000)}-${Math.floor(lon * 1000)}`

// After — uses Math.abs() and 'X' separator
currentPlotId: `PLOT${Math.abs(Math.floor(lat * 1000))}X${Math.abs(Math.floor(lon * 1000))}`
```

---

### Fix 3 — Hardcoded `localhost:8000` in Map Page

**File:** `frontend/app/map/page.tsx`
**Severity:** HIGH — breaks all non-localhost deployments

**Root Cause:**
The plot boundary fetch was hardcoded:
```typescript
const resp = await fetch(`http://localhost:8000/plot-boundary?lat=${lat}&lon=${lon}`);
```

This hard failure mode breaks any deployment to staging, production, or Docker environments where the backend is not at `localhost:8000`.

**Fix Applied:**
```typescript
const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const resp = await fetch(`${apiBase}/plot-boundary?lat=${lat}&lon=${lon}`);
```

---

### Fix 4 — Database Init: Missing Model Imports

**File:** `backend/database/connection.py`
**Severity:** HIGH — `users` and `notifications` tables never created

**Root Cause:**
`init_db()` only imported `PlotRecord`, `AnalysisRecord`, `FloorPlanRecord` but not `User` and `Notification`. SQLAlchemy's `create_all()` only creates tables for imported models. This meant:
- The `users` table was never created → 500 on every `/auth/signup` or `/auth/login`
- The `notifications` table was never created → 500 on SSE stream endpoint

**Fix Applied:**
Added `User` and `Notification` to the imports in `init_db()`:
```python
from database.models import PlotRecord, AnalysisRecord, FloorPlanRecord, User, Notification
```

---

### Fix 5 — Notifications Route: SQLAlchemy OR Condition + UUID Crash

**File:** `backend/routes/notifications.py`
**Severity:** HIGH — 500 on SSE notification stream

**Root Cause:**
The query used Python's `|` bitwise operator for OR conditions, which does not work correctly in SQLAlchemy 2.0 async with SQLite. Additionally, `uuid.UUID(user_id)` would raise a `ValueError` if `user_id` was not a valid UUID string (e.g., during development with string IDs).

**Fix Applied:**
- Changed to `sqlalchemy.or_()` for OR conditions
- Wrapped `uuid.UUID(user_id)` in try/except to handle non-UUID string IDs

---

### Fix 6 — Pydantic v2 Compatibility: NotificationResponse datetime Serialization

**File:** `backend/models/schemas.py`
**Severity:** HIGH — validation error on all notification responses

**Root Cause:**
`NotificationResponse` declared `created_at: str` but received a Python `datetime` object from SQLAlchemy ORM. In Pydantic v2 (required ≥ 2.7.0), this raises a validation error rather than silently coercing.

**Fix Applied:**
```python
from pydantic import field_serializer
from typing import Any

class NotificationResponse(BaseModel):
    id: Any
    created_at: Any

    @field_serializer("created_at")
    def serialize_created_at(self, v):
        return v.isoformat() if hasattr(v, "isoformat") else str(v)
```

---

### Fix 7 — Pydantic v2 Compatibility: UserResponse Config

**File:** `backend/models/schemas.py`
**Severity:** MEDIUM — deprecation warning / potential v2 failure

**Root Cause:**
Used the Pydantic v1 inner `Config` class style:
```python
class Config:
    from_attributes = True
```
This pattern is deprecated in Pydantic v2 and may raise warnings or fail depending on version.

**Fix Applied:**
```python
model_config = {"from_attributes": True}
```
Also added `@field_serializer("id")` for proper UUID→string serialization.

---

### Fix 8 — Analysis Pipeline: JSON Serialization of numpy Types

**File:** `backend/services/analysis_pipeline.py`
**Severity:** MEDIUM — database persist failures for analyses with ML model output

**Root Cause:**
The `raw_features` JSONB field could contain `numpy.float32` or `numpy.int64` types returned by the ML models. Python's built-in `json.dumps()` cannot serialize numpy scalars, causing DB persist failures.

**Fix Applied:**
Added explicit `float()` casting for all numeric values before storing in `raw_features`:
```python
raw_features = {k: float(v) if isinstance(v, (int, float)) else v
                for k, v in env_data.items()}
```

---

## 3D Viewer Fixes

---

### Fix 9 — Three.js Raycasting Null Crash on Unmounted Meshes

**File:** `frontend/app/model3d/[id]/page.tsx`
**Severity:** HIGH — 3D viewer crashes on component unmount / hot reload

**Root Cause:**
Three.js raycasting was running on mesh objects whose internal geometry state was null after unmounting, causing `Cannot read properties of null` errors.

**Fix Applied:**
Introduced `NOOP_RAYCAST` pattern — non-interactive meshes have their raycast disabled at the module level:
```typescript
const NOOP_RAYCAST = () => {};
const REAL_RAYCAST = THREE.Mesh.prototype.raycast;

// On decorative meshes:
<mesh onPointerOver={undefined} ref={ref => { if (ref) ref.raycast = NOOP_RAYCAST; }}>
```
Interactive meshes explicitly restore `REAL_RAYCAST`.

---

### Fix 10 — Window Glass Material Cross-Contaminates Wall Color

**File:** `frontend/app/model3d/[id]/page.tsx`
**Severity:** MEDIUM — visual bug: all windows appear in wall color

**Root Cause:**
Window glass and wall mesh shared the same `THREE.MeshStandardMaterial` reference. Updating wall color mutated the shared material, which also changed the window glass appearance.

**Fix Applied:**
Separated window glass into its own `THREE.MeshPhysicalMaterial` with `transparent: true`, `opacity: 0.35`, `roughness: 0.05`, `metalness: 0.1`. The `WindowPane` component uses `THREE.DoubleSide` for exterior visibility.

---

### Fix 11 — Procedural Texture System

**File:** `frontend/app/model3d/[id]/page.tsx`
**Severity:** ENHANCEMENT — surface materials lacked realism

**Problem:**
Walls appeared as flat colors with no surface detail.

**Fix Applied:**
Implemented a fully procedural canvas-based texture system:
- `_noise2d(x, y)` — smooth value noise via bilinear interpolation of pseudo-random hash values
- `_fbm(x, y, oct)` — fractional Brownian motion (multi-octave layered noise) for organic variation
- `_buildHeightfield(sz, fn)` — builds a Float32Array heightfield from a noise function
- `_heightToNormal(h, sz, strength)` — converts heightfield to a `THREE.CanvasTexture` normal map using finite-difference gradient approximation

Available texture types: `brick`, `concrete`, `wood`, `plaster`, `marble`, `tile`.

---

## Floor Plan Fixes

---

### Fix 12 — Room Area Limits Not Enforced

**File:** `frontend/app/analysis/[id]/page.tsx` and `backend/services/floorplan_service.py`
**Severity:** MEDIUM — unrealistic floor plans generated for small plots

**Problem:**
The floor plan generator was assigning the same number of rooms (7 rooms) regardless of plot area, resulting in impossible layouts for small plots (< 60 m²).

**Fix Applied:**
Implemented `computeRoomLimits(area)` function that scales room configuration to plot area:

| Plot Area | Bedrooms | Bathrooms | Notes |
|---|---|---|---|
| < 60 m² | 1 | 1 | Studio configuration |
| < 100 m² | 2 | 1 | Compact home |
| < 150 m² | 3 | 2 | + Office, dining, utility |
| < 250 m² | 4 | 2 | + Garage |
| < 400 m² | 5 | 3 | + Extra office |
| ≥ 400 m² | 6 | 4 | Full villa configuration |

---

### Fix 13 — Plot Shape Polygon Support

**File:** `frontend/app/analysis/[id]/page.tsx`
**Severity:** ENHANCEMENT

**Added:**
`makePlotPolygon(shape, area)` function generating correct boundary polygons for each supported shape: square, rectangle, L-shape, T-shape, U-shape, irregular.

`pointInPoly(px, py, poly)` implements the ray-casting algorithm for efficient point-in-polygon testing, used to constrain room placement within the actual plot boundary.

---

## Backend API / Service Fixes

---

### Fix 14 — SoilGrids Unit Conversion Errors

**File:** `backend/services/real_env_data.py`
**Severity:** HIGH — incorrect soil values used in buildability computation

**Root Cause:**
SoilGrids v2 REST API returns values in non-standard units:
- Clay/Sand/Silt: g/kg (not %)
- pH: ×10 encoding (e.g., 62 = pH 6.2)
- Organic carbon: dg/kg (not g/kg)
- Bulk density: cg/cm³ (not g/cm³)

Without proper conversions, clay_pct = 294 instead of 29.4 %, causing the buildability heavy clay penalty to fire incorrectly on all soils.

**Fix Applied:**
```python
clay_pct  = raw_clay  / 10     # g/kg → %
soil_ph   = raw_phh2o / 10     # ×10 encoding → pH
org_carbon = raw_soc  / 10     # dg/kg → g/kg
bulk_den   = raw_bdod / 100    # cg/cm³ → g/cm³
```

---

### Fix 15 — GloFAS Flood Index: Non-Linear Discharge Mapping

**File:** `backend/services/real_env_data.py`
**Severity:** MEDIUM — linear mapping underweighted low-discharge flood risk

**Root Cause:**
Peak river discharge (m³/s) was being divided by a constant to derive a 0–1 index. This linear mapping failed to capture the logarithmic relationship between discharge and flood risk (a 50 m³/s river does not pose 5× more risk than a 10 m³/s stream).

**Fix Applied:**
Threshold-based mapping reflecting logarithmic hydrological risk:

| Peak Discharge | GloFAS Flood Index |
|---|---|
| < 5 m³/s | 0.05 |
| < 20 m³/s | 0.12 |
| < 50 m³/s | 0.22 |
| < 150 m³/s | 0.38 |
| < 500 m³/s | 0.58 |
| < 2000 m³/s | 0.75 |
| ≥ 2000 m³/s | 0.90 |

---

### Fix 16 — OSM Overpass: Neighborhood Polygon vs Individual Parcel

**File:** `backend/services/plot_boundary.py`
**Severity:** HIGH — wrong boundary polygon returned for most queries

**Root Cause:**
The Overpass query was returning the smallest containing administrative area (ward / neighbourhood), producing multi-hectare polygons instead of individual cadastral parcels.

**Fix Applied:**
Rewrote the query strategy with cascading priority:
1. Cadastral-tagged ways (`boundary=cadastral`, `landuse=*`)
2. Smallest containing way ≤ 10,000 m²
3. Nominatim reverse geocode fallback
4. Synthetic oriented rectangle based on estimated plot area

---

### Fix 17 — Map Search Navigates Without Auto-Selecting Plot

**File:** `frontend/app/map/page.tsx`
**Severity:** UX improvement

**Problem:**
Searching for a location via the map search bar would auto-select the first detected plot boundary, confusing users who wanted to browse before selecting.

**Fix Applied:**
Modified the search handler to pan/zoom the map to the searched location without triggering boundary detection or plot selection. Boundary detection only fires on explicit user click.

---

## Known Remaining Issues & Recommended Improvements

1. **CORS wildcard in production** — `allow_origins=["*"]` is acceptable in development but should be restricted to specific frontend origin(s) in production.

2. **SQLite write lock under load** — SQLite does not support concurrent writes efficiently. Production deployments must use PostgreSQL.

3. **DeepLabV3 COCO→ECO class remapping** — The current 6-class ECO mapping from COCO 21 classes is approximate. Proper fine-tuning on satellite imagery is required for production accuracy.

4. **YOLOv8 base model, not fine-tuned** — The tree detector uses the base YOLOv8n COCO model, which was not trained on aerial tree imagery. Fine-tuning on a dataset such as the Urban Tree Canopy dataset is recommended.

5. **NASA POWER fill values** — The `-999` fill value filter is applied but extreme latitudes (>60°N or >60°S) may still produce anomalous NDVI estimates due to low solar irradiance.

6. **Genetic algorithm tree exclusion is a placeholder** — The `0.15 * 0.8` tree score in `Chromosome.fitness()` is currently a static constant. It should compute the actual overlap between room footprints and protected tree bounding boxes.

7. **No request-level caching** — All 7 API calls fire on every `/analyze-plot` request with no caching. Adding Redis with per-API TTL would dramatically reduce latency for repeat coordinates.

8. **JWT token not rotated** — Tokens expire after 1440 minutes (24 hr) but there is no refresh token mechanism. Production systems should implement token rotation.

9. **Front-end localStorage not used** — Analysis results are stored only in Zustand (in-memory). If the user refreshes the browser, the state is lost and they must re-run the analysis. Persisting the `analysis` object to `localStorage` or fetching it from the database by plot ID would improve the UX.
