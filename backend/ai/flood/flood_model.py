"""
Layer 3: Flood Risk Model using XGBoost
Inputs: elevation, slope, ndvi, rainfall, soil, distance_to_water
Output: probability (0.0–1.0) + risk_level label
"""
import numpy as np
import logging
import pickle
from pathlib import Path
import os

logger = logging.getLogger(__name__)

WEIGHTS_DIR = Path(os.environ.get("WEIGHTS_DIR", "training/weights"))
MODEL_PATH = WEIGHTS_DIR / "flood_xgboost.pkl"

SOIL_STABILITY = {
    "Sandy Loam": 0.4, "Clay": 0.8, "Loam": 0.6, "Silt Loam": 0.5,
    "sandy": 0.3, "clay": 0.9, "loam": 0.6, "silt": 0.5,
}

RISK_THRESHOLDS = {
    "Low": 0.3,
    "Medium": 0.6,
    "High": 0.8,
}


def _probability_to_risk(prob: float) -> str:
    if prob < RISK_THRESHOLDS["Low"]:
        return "Low"
    elif prob < RISK_THRESHOLDS["Medium"]:
        return "Medium"
    elif prob < RISK_THRESHOLDS["High"]:
        return "High"
    return "Critical"


class FloodRiskModel:
    def __init__(self):
        self.model = None
        self._load_or_train()

    def _encode_features(
        self,
        elevation: float,
        slope_pct: float,
        ndvi: float,
        rainfall_mm: float,
        soil_type: str,
        distance_to_water_m: float,
    ) -> np.ndarray:
        soil_stability = SOIL_STABILITY.get(soil_type, 0.5)
        return np.array([[
            elevation,
            slope_pct,
            ndvi,
            rainfall_mm,
            soil_stability,
            distance_to_water_m,
        ]], dtype=np.float32)

    def _generate_synthetic_dataset(self, n_samples: int = 2000):
        """Generate synthetic training data with realistic flood physics."""
        np.random.seed(42)
        X = []
        y = []

        for _ in range(n_samples):
            elev = np.random.uniform(0, 500)
            slope = np.random.uniform(0, 40)
            ndvi = np.random.uniform(-0.1, 0.9)
            rainfall = np.random.uniform(100, 3000)
            soil = np.random.uniform(0.2, 0.9)
            dist_water = np.random.uniform(10, 5000)

            # Physics-based probability
            flood_prob = (
                0.4 * max(0, 1 - elev / 100)        # low elevation = higher risk
                + 0.15 * max(0, 1 - slope / 30)     # flat land = higher risk
                + 0.1 * max(0, (rainfall - 500) / 2500)  # high rainfall
                + 0.15 * max(0, 1 - ndvi)           # bare land = higher risk
                + 0.1 * max(0, 1 - dist_water / 500)  # close to water
                + 0.1 * soil                         # high clay = poor drainage
            )
            flood_prob = float(np.clip(flood_prob + np.random.normal(0, 0.05), 0, 1))

            X.append([elev, slope, ndvi, rainfall, soil, dist_water])
            y.append(flood_prob)

        return np.array(X, dtype=np.float32), np.array(y, dtype=np.float32)

    def _load_or_train(self):
        """Load saved model or train from scratch."""
        try:
            import xgboost as xgb

            WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)

            if MODEL_PATH.exists():
                logger.info(f"Loading XGBoost flood model from {MODEL_PATH}")
                with open(MODEL_PATH, "rb") as f:
                    self.model = pickle.load(f)
            else:
                logger.info("Training XGBoost flood model on synthetic dataset...")
                X, y = self._generate_synthetic_dataset(2000)
                self.model = xgb.XGBRegressor(
                    n_estimators=200,
                    max_depth=6,
                    learning_rate=0.05,
                    subsample=0.8,
                    colsample_bytree=0.8,
                    objective="reg:squarederror",
                    random_state=42,
                )
                self.model.fit(X, y, eval_set=[(X, y)], verbose=False)
                with open(MODEL_PATH, "wb") as f:
                    pickle.dump(self.model, f)
                logger.info(f"XGBoost flood model saved to {MODEL_PATH}")

        except ImportError:
            logger.warning("XGBoost not installed. FloodRiskModel will use physics formula.")
            self.model = None

    def predict(
        self,
        elevation: float,
        slope_pct: float,
        ndvi: float,
        rainfall_mm: float,
        soil_type: str,
        distance_to_water_m: float,
    ) -> dict:
        """Predict flood probability."""
        if self.model is not None:
            try:
                X = self._encode_features(elevation, slope_pct, ndvi, rainfall_mm, soil_type, distance_to_water_m)
                prob = float(np.clip(self.model.predict(X)[0], 0, 1))
            except Exception as e:
                logger.warning(f"XGBoost prediction failed: {e}. Using formula.")
                prob = self._formula_predict(elevation, slope_pct, ndvi, rainfall_mm, soil_type, distance_to_water_m)
        else:
            prob = self._formula_predict(elevation, slope_pct, ndvi, rainfall_mm, soil_type, distance_to_water_m)

        return {
            "probability": round(prob, 3),
            "risk_level": _probability_to_risk(prob),
            "distance_to_water_m": round(distance_to_water_m, 0),
        }

    def _formula_predict(self, elevation, slope_pct, ndvi, rainfall_mm, soil_type, distance_to_water_m) -> float:
        soil_stability = SOIL_STABILITY.get(soil_type, 0.5)
        prob = (
            0.4 * max(0, 1 - elevation / 100)
            + 0.15 * max(0, 1 - slope_pct / 30)
            + 0.1 * max(0, (rainfall_mm - 500) / 2500)
            + 0.15 * max(0, 1 - ndvi)
            + 0.1 * max(0, 1 - distance_to_water_m / 500)
            + 0.1 * soil_stability
        )
        return float(np.clip(prob, 0, 1))
