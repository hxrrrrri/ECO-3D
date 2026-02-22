"""
Layer 4: Buildability Neural Model (MLP Regression)
Inputs: flood_prob, slope, soil_stability, vegetation_density, wind_exposure, sun_exposure
Output: buildability score 0–100
"""
import numpy as np
import logging
from pathlib import Path
import os

logger = logging.getLogger(__name__)

WEIGHTS_DIR = Path(os.environ.get("WEIGHTS_DIR", "training/weights"))
MODEL_PATH = WEIGHTS_DIR / "buildability_mlp.pkl"


class BuildabilityModel:
    def __init__(self):
        self.model = None
        self.scaler = None
        self._load_or_train()

    def _encode(
        self,
        flood_prob: float,
        slope_pct: float,
        clay_pct: float,
        vegetation_density: float,
        wind_speed_ms: float,
        sun_exposure_hours: float,
    ) -> np.ndarray:
        # Normalize: soil stability from clay pct
        soil_stability = min(1.0, clay_pct / 60)
        # Normalize wind exposure (higher = worse for lightweight structures)
        wind_exposure = min(1.0, wind_speed_ms / 15)
        sun_score = min(1.0, sun_exposure_hours / 12)

        return np.array([[
            flood_prob,
            min(1.0, slope_pct / 45),
            soil_stability,
            vegetation_density,
            wind_exposure,
            sun_score,
        ]], dtype=np.float32)

    def _generate_dataset(self, n: int = 3000):
        """Generate synthetic buildability training data."""
        np.random.seed(99)
        X, y = [], []

        for _ in range(n):
            flood_prob = np.random.uniform(0, 1)
            slope = np.random.uniform(0, 45)
            clay_pct = np.random.uniform(5, 80)
            veg_density = np.random.uniform(0, 1)
            wind = np.random.uniform(0, 15)
            sun = np.random.uniform(3, 14)

            # Buildability physics
            score = (
                100
                - 35 * flood_prob              # flood risk strongly reduces score
                - 20 * (slope / 45)           # slope penalty
                - 10 * (1 - clay_pct / 60)   # low stability penalty
                + 5 * veg_density             # green areas are good
                - 8 * (wind / 15)             # high wind slight penalty
                + 8 * (sun / 12)              # sun exposure bonus
                + np.random.normal(0, 3)
            )
            score = float(np.clip(score, 0, 100))
            X.append([flood_prob, slope / 45, clay_pct / 60, veg_density, wind / 15, sun / 12])
            y.append(score)

        return np.array(X, dtype=np.float32), np.array(y, dtype=np.float32)

    def _load_or_train(self):
        """Load or train PyTorch MLP."""
        try:
            import torch
            import torch.nn as nn

            WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)

            class MLP(nn.Module):
                def __init__(self):
                    super().__init__()
                    self.net = nn.Sequential(
                        nn.Linear(6, 64), nn.ReLU(), nn.Dropout(0.1),
                        nn.Linear(64, 128), nn.ReLU(), nn.Dropout(0.1),
                        nn.Linear(128, 64), nn.ReLU(),
                        nn.Linear(64, 1),
                    )
                def forward(self, x): return self.net(x)

            self._MLP = MLP

            if MODEL_PATH.exists():
                logger.info(f"Loading MLP buildability model from {MODEL_PATH}")
                self.model = MLP()
                self.model.load_state_dict(torch.load(MODEL_PATH, map_location="cpu"))
                self.model.eval()
            else:
                logger.info("Training MLP buildability model...")
                X, y = self._generate_dataset(3000)
                self.model = self._train_mlp(MLP, X, y, torch)
                torch.save(self.model.state_dict(), MODEL_PATH)
                logger.info(f"MLP buildability model saved to {MODEL_PATH}")

        except ImportError:
            logger.warning("PyTorch not installed. BuildabilityModel will use formula.")
            self.model = None

    def _train_mlp(self, MLP, X, y, torch):
        import torch.nn as nn
        model = MLP()
        optimizer = torch.optim.Adam(model.parameters(), lr=1e-3, weight_decay=1e-4)
        criterion = nn.MSELoss()

        X_t = torch.tensor(X)
        y_t = torch.tensor(y).unsqueeze(1)

        model.train()
        for epoch in range(200):
            optimizer.zero_grad()
            pred = model(X_t)
            loss = criterion(pred, y_t)
            loss.backward()
            optimizer.step()
            if epoch % 50 == 0:
                logger.info(f"  Epoch {epoch}: loss={loss.item():.3f}")

        model.eval()
        return model

    def predict(
        self,
        flood_prob: float,
        slope_pct: float,
        clay_pct: float,
        vegetation_density: float,
        wind_speed_ms: float,
        sun_exposure_hours: float,
    ) -> float:
        if self.model is not None:
            try:
                import torch
                X = self._encode(flood_prob, slope_pct, clay_pct, vegetation_density, wind_speed_ms, sun_exposure_hours)
                with torch.no_grad():
                    score = self.model(torch.tensor(X)).item()
                return round(float(np.clip(score, 0, 100)), 1)
            except Exception as e:
                logger.warning(f"MLP prediction failed: {e}. Using formula.")

        return round(float(np.clip(
            100
            - 35 * flood_prob
            - 20 * (slope_pct / 45)
            - 10 * (1 - clay_pct / 60)
            + 5 * vegetation_density
            - 8 * (wind_speed_ms / 15)
            + 8 * (sun_exposure_hours / 12),
            0, 100
        )), 1)
