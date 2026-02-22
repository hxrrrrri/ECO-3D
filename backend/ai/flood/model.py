"""
LAYER 3 — XGBoost Flood Risk Model
Input:  elevation, slope, NDVI, rainfall_mm, soil_type, distance_to_water
Output: flood_probability (0.0 – 1.0)
"""
import os
import pickle
import numpy as np

WEIGHTS_PATH = os.path.join(os.path.dirname(__file__), "weights", "flood_model.pkl")

_flood_model = None
_scaler = None

SOIL_ENCODING = {
    "clay": 0, "silt": 1, "sandy_clay": 2, "loam": 3,
    "sand": 4, "gravel": 5, "rock": 6, "peat": 7,
}


def get_flood_model():
    global _flood_model, _scaler
    if _flood_model is not None:
        return _flood_model
    os.makedirs(os.path.dirname(WEIGHTS_PATH), exist_ok=True)
    if os.path.exists(WEIGHTS_PATH):
        with open(WEIGHTS_PATH, "rb") as f:
            bundle = pickle.load(f)
            _flood_model = bundle["model"]
            _scaler = bundle.get("scaler")
        print("[Flood] XGBoost model loaded from disk.")
    else:
        print("[Flood] No trained model found. Training on synthetic data now...")
        _train_and_save()
    return _flood_model


def _train_and_save():
    """Train XGBoost on synthetic data and persist."""
    global _flood_model, _scaler
    import xgboost as xgb
    from sklearn.preprocessing import StandardScaler

    rng = np.random.default_rng(42)
    n = 5000

    elevation = rng.uniform(0, 500, n)
    slope = rng.uniform(0, 30, n)
    ndvi = rng.uniform(0, 1, n)
    rainfall = rng.uniform(200, 3000, n)
    soil = rng.integers(0, 8, n).astype(float)
    dist_water = rng.uniform(0, 2000, n)

    # Physics-informed synthetic labels
    risk = (
        0.5 / (1 + elevation / 50) +
        0.2 * (1 / (1 + slope / 5)) +
        0.1 * (1 - ndvi) +
        0.15 * (rainfall / 3000) +
        0.05 * (1 / (1 + dist_water / 200))
    )
    risk = np.clip(risk + rng.normal(0, 0.05, n), 0, 1)

    X = np.column_stack([elevation, slope, ndvi, rainfall, soil, dist_water])
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    model = xgb.XGBRegressor(
        n_estimators=200, max_depth=6, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8, random_state=42, verbosity=0
    )
    model.fit(X_scaled, risk)

    with open(WEIGHTS_PATH, "wb") as f:
        pickle.dump({"model": model, "scaler": scaler}, f)

    _flood_model = model
    _scaler = scaler
    print("[Flood] XGBoost trained and saved.")


def predict_flood_probability(features: dict) -> float:
    model = get_flood_model()
    soil_enc = SOIL_ENCODING.get(str(features.get("soil_type", "loam")).lower(), 3)
    X = np.array([[
        features.get("elevation", 100),
        features.get("slope", 5),
        features.get("ndvi", 0.5),
        features.get("rainfall_mm", 800),
        soil_enc,
        features.get("distance_to_water", 500),
    ]])
    if _scaler:
        X = _scaler.transform(X)
    prob = float(model.predict(X)[0])
    return round(max(0.0, min(1.0, prob)), 4)
