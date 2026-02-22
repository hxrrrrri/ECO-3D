# ECO-3D Bug Fixes — What Was Broken & How It Was Fixed

## Root Cause of "500 / 00 Error" When Analyzing a Plot

### Fix 1: Database Models — PostgreSQL UUID on SQLite (CRITICAL)
**File:** `backend/database/models.py`

**Problem:** The models imported `from sqlalchemy.dialects.postgresql import UUID` and used it as the primary key type for ALL tables. This PostgreSQL-specific type **crashes completely on SQLite** (the default dev database), causing a 500 error the moment any database operation was attempted — including `/analyze-plot`.

**Fix:** Replaced with a conditional UUID strategy:
- **SQLite** (dev default): uses `String(36)` columns with `str(uuid.uuid4())` defaults — universally compatible
- **PostgreSQL** (production): keeps the native `UUID` type from the postgresql dialect

This is a zero-logic-change fix — the data stored is identical, only the column declaration adapts to the engine.

---

### Fix 2: Plot ID Format Creates Broken URLs
**File:** `frontend/store/useEco3DStore.ts`

**Problem:** Plot IDs were generated as:
```
PLOT-${Math.floor(lat * 1000)}-${Math.floor(lon * 1000)}
```
For locations with negative coordinates (most of the world outside the NE quadrant), this produced IDs like `PLOT-9825--769` (double-dash) or `PLOT--3310--769`. These broken IDs caused:
- URL routing failures when navigating to `/analysis/PLOT--3310--769`
- Next.js dynamic route parsing errors

**Fix:** Changed to use `Math.abs()` and a separator that can't produce double-dashes:
```
PLOT${Math.abs(Math.floor(lat * 1000))}X${Math.abs(Math.floor(lon * 1000))}
```

---

### Fix 3: Hardcoded `localhost:8000` in Map Page
**File:** `frontend/app/map/page.tsx`

**Problem:** The plot-boundary fetch was hardcoded to `http://localhost:8000` instead of reading from the `NEXT_PUBLIC_API_URL` environment variable. This breaks any non-localhost deployment.

**Fix:** Now reads from env var with localhost as fallback:
```typescript
const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const resp = await fetch(`${apiBase}/plot-boundary?lat=${lat}&lon=${lon}`);
```

---

### Fix 4: Notifications Route — UUID Comparison with NULL
**File:** `backend/routes/notifications.py`

**Problem:** The SQLAlchemy query used Python's `|` operator for OR conditions with UUID types, which doesn't work correctly in async SQLAlchemy 2.0+ with SQLite. Also, `uuid.UUID(user_id)` would crash if `user_id` was an invalid UUID string.

**Fix:** 
- Changed to use `sqlalchemy.or_()` for OR conditions
- Wrapped `uuid.UUID(user_id)` in try/except

---

### Fix 5: NotificationResponse Schema — datetime Serialization
**File:** `backend/models/schemas.py`

**Problem:** The `NotificationResponse` Pydantic model declared `created_at: str` but received a Python `datetime` object from SQLAlchemy ORM. In Pydantic v2 (which this project uses per the `>=2.7.0` requirement), this causes a validation error.

**Fix:** Changed the schema to accept `Any` for `created_at` and added a `@field_serializer` that converts `datetime` objects to ISO strings automatically. Same fix applied to `id` (UUID → string serialization).

---

### Fix 6: UserResponse Config — Pydantic v2 Compatibility
**File:** `backend/models/schemas.py`

**Problem:** Used `class Config: from_attributes = True` (Pydantic v1 style) and `id: str` but receives a UUID object. In Pydantic v2, the inner `Config` class is deprecated.

**Fix:** Changed to `model_config = {"from_attributes": True}` and added `@field_serializer("id")` for proper UUID→string conversion.

---

### Fix 7: Database Init — Missing Model Imports
**File:** `backend/database/connection.py`

**Problem:** `init_db()` only imported `PlotRecord`, `AnalysisRecord`, `FloorPlanRecord` but not `User` and `Notification`. This meant the `users` and `notifications` tables were never created, causing 500 errors on auth and notification endpoints.

**Fix:** Added `User` and `Notification` to the imports in `init_db()`.

---

### Fix 8: Analysis Pipeline — JSON Serialization of env_data
**File:** `backend/services/analysis_pipeline.py`

**Problem:** The `raw_features` field could contain numpy floats or other non-JSON-serializable types from the ML models, causing DB persist failures.

**Fix:** Added explicit float casting for all numeric values before storing in `raw_features`.

---

### Fix 9: Environment Files Added
**Files added:**
- `frontend/.env.local` — sets `NEXT_PUBLIC_API_URL=http://localhost:8000`
- `backend/.env` — sets SQLite URL and dev environment

---

## How to Run

### Backend
```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend  
```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000

### Full workflow:
1. Open the map
2. Click anywhere on the map
3. Wait for boundary detection (~2s)
4. Click "Analyse Plot"
5. Analysis runs (~5-10s including real API calls)
6. Redirects to the Blueprint Generator
7. Navigate to 3D Model or Report from there
