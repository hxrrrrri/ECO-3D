"""
LAYER 1A — DeepLabV3 Satellite Segmentation
Input:  lat/lon → fetched satellite tile (224x224 RGB)
Output: land classification mask as percentage dict
"""
import os
import random
import numpy as np
from typing import Dict

_model = None
_transform = None


def get_segmentation_model():
    global _model, _transform
    if _model is not None:
        return _model
    try:
        import torch
        import torchvision.transforms as T
        from torchvision.models.segmentation import deeplabv3_resnet50, DeepLabV3_ResNet50_Weights
        weights = DeepLabV3_ResNet50_Weights.DEFAULT
        _model = deeplabv3_resnet50(weights=weights)
        _model.eval()
        _transform = T.Compose([
            T.ToTensor(),
            T.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
        ])
        print("[Segmentation] DeepLabV3 loaded.")
    except Exception as e:
        print(f"[Segmentation] Load failed ({e}), using synthetic mode.")
        _model = "SYNTHETIC"
    return _model


def fetch_satellite_tile(lat: float, lon: float) -> np.ndarray:
    """Fetch satellite tile or return synthetic fallback."""
    mapbox_token = os.getenv("MAPBOX_TOKEN")
    if mapbox_token:
        import requests
        from PIL import Image
        import io
        url = (
            f"https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/"
            f"{lon},{lat},15,0/224x224?access_token={mapbox_token}"
        )
        try:
            resp = requests.get(url, timeout=10)
            img = Image.open(io.BytesIO(resp.content)).convert("RGB")
            return np.array(img)
        except Exception:
            pass
    rng = np.random.default_rng(int(abs(lat * 1000) + abs(lon * 1000)))
    tile = rng.integers(60, 200, (224, 224, 3), dtype=np.uint8)
    tile[:, :, 1] = np.clip(tile[:, :, 1] + 50, 0, 255)
    return tile


def run_segmentation(lat: float, lon: float) -> Dict[str, float]:
    model = get_segmentation_model()
    tile = fetch_satellite_tile(lat, lon)
    if model == "SYNTHETIC" or model is None:
        return _synthetic_segmentation(lat, lon)
    try:
        import torch
        from PIL import Image
        img = Image.fromarray(tile)
        tensor = _transform(img).unsqueeze(0)
        with torch.no_grad():
            output = model(tensor)["out"]
            mask = output.argmax(1).squeeze().numpy()
        total = mask.size
        veg_mask = np.isin(mask, [9, 4, 17, 66, 72])
        water_mask = np.isin(mask, [21, 60])
        urban_mask = np.isin(mask, [0, 1, 2, 25])
        road_mask = np.isin(mask, [6, 11])
        bare_mask = ~(veg_mask | water_mask | urban_mask | road_mask)
        return {
            "vegetation": float(veg_mask.sum() / total),
            "water": float(water_mask.sum() / total),
            "urban": float(urban_mask.sum() / total),
            "road": float(road_mask.sum() / total),
            "bare_soil": float(bare_mask.sum() / total),
        }
    except Exception as e:
        print(f"[Segmentation] Inference error: {e}")
        return _synthetic_segmentation(lat, lon)


def _synthetic_segmentation(lat: float, lon: float) -> Dict[str, float]:
    seed = int((abs(lat) * 137.3 + abs(lon) * 89.7) % 1000)
    rng = random.Random(seed)
    veg = rng.uniform(0.3, 0.7)
    water = rng.uniform(0.0, 0.15)
    urban = rng.uniform(0.05, 0.3)
    road = rng.uniform(0.02, 0.1)
    bare = max(0.0, 1.0 - veg - water - urban - road)
    total = veg + water + urban + road + bare
    return {k: round(v / total, 3) for k, v in
            [("vegetation", veg), ("water", water), ("urban", urban), ("road", road), ("bare_soil", bare)]}
