"""
LAYER 4 — MLP Neural Network Buildability Model
Input:  flood_probability, slope, soil_stability, vegetation_density,
        wind_exposure, sun_exposure
Output: buildability_score (0 – 100)
"""
import os
import pickle
import numpy as np

WEIGHTS_PATH = os.path.join(os.path.dirname(__file__), "weights", "buildability_model.pkl")
_build_model = None
_scaler = None


def get_buildability_model():
    global _build_model, _scaler
    if _build_model is not None:
        return _build_model
    os.makedirs(os.path.dirname(WEIGHTS_PATH), exist_ok=True)
    if os.path.exists(WEIGHTS_PATH):
        with open(WEIGHTS_PATH, "rb") as f:
            bundle = pickle.load(f)
            _build_model = bundle["model"]
            _scaler = bundle.get("scaler")
        print("[Buildability] MLP model loaded from disk.")
    else:
        print("[Buildability] No trained model found. Training on synthetic data now...")
        _train_and_save()
    return _build_model


def _train_and_save():
    global _build_model, _scaler
    from sklearn.neural_network import MLPRegressor
    from sklearn.preprocessing import StandardScaler

    rng = np.random.default_rng(99)
    n = 5000

    flood_prob = rng.uniform(0, 1, n)
    slope = rng.uniform(0, 30, n)
    soil_stability = rng.uniform(0, 1, n)
    veg_density = rng.uniform(0, 1, n)
    wind_exposure = rng.uniform(0, 1, n)
    sun_exposure = rng.uniform(2, 10, n)

    # Physics-informed score (0-100)
    score = (
        30 * (1 - flood_prob) +
        20 * (1 - slope / 30) +
        20 * soil_stability +
        10 * (1 - veg_density * 0.3) +
        10 * (1 - wind_exposure) +
        10 * (sun_exposure / 10)
    )
    score = np.clip(score + rng.normal(0, 3, n), 0, 100)

    X = np.column_stack([flood_prob, slope, soil_stability, veg_density, wind_exposure, sun_exposure])
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    model = MLPRegressor(
        hidden_layer_sizes=(64, 32, 16),
        activation="relu",
        max_iter=500,
        random_state=42,
        early_stopping=True,
        verbose=False,
    )
    model.fit(X_scaled, score)

    with open(WEIGHTS_PATH, "wb") as f:
        pickle.dump({"model": model, "scaler": scaler}, f)

    _build_model = model
    _scaler = scaler
    print("[Buildability] MLP trained and saved.")


def predict_buildability_score(features: dict) -> float:
    model = get_buildability_model()
    X = np.array([[
        features.get("flood_probability", 0.1),
        features.get("slope", 5),
        features.get("soil_stability", 0.7),
        features.get("vegetation_density", 0.5),
        features.get("wind_exposure", 0.5),
        features.get("sun_exposure", 6),
    ]])
    if _scaler:
        X = _scaler.transform(X)
    score = float(model.predict(X)[0])
    return round(max(0.0, min(100.0, score)), 2)
