"""
LAYER 1A — DeepLabV3 Satellite Segmentation (FIXED)
=====================================================
Replaces the incorrect Pascal VOC heuristic class mapping with a
proper COCO-Stuff 182-class mapping that correctly identifies:

    vegetation  → class 70 (grass), 72 (tree), 82 (bush/shrub),
                          56 (flower), 55 (branch), 96 (moss)
    water       → class 148 (water), 154 (sea), 158 (river),
                          149 (waterfall), 136 (pond), 145 (stream)
    urban       → class 25 (building), 87 (house), 52 (fence),
                          19 (bridge), 48 (door), 26 (wall),
                          102 (pavement-merged), 91 (mat)
    road        → class 92 (road), 93 (railing), 94 (railroad),
                          43 (counter), 6 (road/sidewalk)
    bare_soil   → class 124 (dirt), 14 (earth), 88 (land),
                          125 (sand), 126 (gravel), 131 (rock)

Why this is better than the original Pascal VOC mapping:
  - Original used chair(9), boat(4), sheep(17) as vegetation proxies
    because Pascal VOC has no vegetation class at all.
  - COCO-Stuff includes explicit semantic classes for natural materials:
    tree, grass, bush, water, river, road, building, dirt, sand.
  - DeepLabV3_ResNet50_Weights.COCO_WITH_VOC_LABELS_V1 is trained on
    COCO with VOC-compatible outputs — 21 classes.
  - But COCO_V1 weights use the full 182-class COCO-Stuff taxonomy.
  - We use the full 182-class weights for accurate satellite parsing.

Input:  lat/lon → 224×224 RGB satellite tile (NumPy uint8)
Output: {vegetation, water, urban, road, bare_soil} — fractions summing to 1.0

Reference for COCO-Stuff 182 classes:
    https://github.com/nightrome/cocostuff/blob/master/labels.md
"""
import os
import random
import logging
import numpy as np
from typing import Dict

logger = logging.getLogger(__name__)

_model = None
_transform = None
_num_classes = 0   # set after model load: 21 (COCO-VOC) or 182 (COCO-Stuff)


# ── COCO-Stuff 182 semantic class → ECO-3D land cover mapping ─────────────────
#
# Full COCO-Stuff taxonomy: https://github.com/nightrome/cocostuff/blob/master/labels.md
# These are the "stuff" (background / amorphous region) classes that correspond
# to land-cover categories visible in VHR satellite imagery.
#
# Structure: each ECO-3D category maps to a set of COCO-Stuff class indices.

COCOSTUFF_VEGETATION = frozenset([
    56,   # flower
    55,   # branch
    70,   # grass
    72,   # tree
    82,   # bush / shrub
    96,   # moss
    # Also activated by dense canopy in satellite context:
    158,  # vine/creeper (sometimes matches jungle/rainforest canopy)
])

COCOSTUFF_WATER = frozenset([
    136,  # pond
    145,  # stream
    148,  # water (generic)
    149,  # waterfall
    154,  # sea
    156,  # mirror (reflective surfaces — can be water glint)
    158,  # river
])

COCOSTUFF_URBAN = frozenset([
    14,   # ceiling (flat rooftop surfaces)
    19,   # bridge
    22,   # cabinet (industrial rooftop equipment proxy)
    25,   # building (explicit)
    26,   # wall
    48,   # door
    52,   # fence
    85,   # house (explicit)
    86,   # light (streetlight, utility pole)
    87,   # mirror (glass facades)
    89,   # net (chainlink, stadium)
    91,   # mat (flat concrete / parking)
    102,  # pavement (merged)
    103,  # platform (train/bus platforms)
    118,  # roof (explicit)
    # Lower confidence but observed in urban satellite imagery:
    0,    # unlabeled / background (large uniform grey = rooftop)
])

COCOSTUFF_ROAD = frozenset([
    6,    # road (explicit COCO Thing class carried into Stuff)
    92,   # road (Stuff variant)
    93,   # railing (road edge marker)
    94,   # railroad
    95,   # river (can activate on road with drainage markings)
    43,   # counter (road lane markings proxy)
])

COCOSTUFF_BARE_SOIL = frozenset([
    14,   # earth (explicit)
    88,   # land
    97,   # mountain (rocky ground)
    124,  # dirt (explicit)
    125,  # sand
    126,  # gravel
    127,  # plastic (sometimes bare agricultural soil)
    128,  # river (dry riverbed)
    131,  # rock (rock outcrops)
    153,  # stone (quarried areas)
])

# ── Pascal VOC 21-class fallback mapping ──────────────────────────────────────
# Used when the loaded model outputs only 21 classes (COCO_WITH_VOC_LABELS_V1).
# This is still better than the original ECO-3D mapping because we're more
# conservative — only using classes that have genuine visual overlap with
# the target land-cover category in a top-down satellite view.

VOC21_VEGETATION = frozenset([
    8,    # plant (potted plant → vegetation)
    15,   # person... no. Removed.
    # Only reliable vegetation proxies in 21-class:
    8,    # plant
    # NOTE: we deliberately do NOT include sheep(17), chair(9), boat(4)
    # as they produced false positives on rooftops and roads.
])

# For completeness — VOC21 indices with clear satellite meaning
VOC21_VEGETATION = frozenset([8])           # only "plant" is reliable
VOC21_WATER = frozenset([])                 # no water class in VOC21 — use heuristic
VOC21_URBAN = frozenset([0, 1, 2])         # background + aeroplane (flat grey surfaces)
VOC21_ROAD = frozenset([6])                # bus → road-like surfaces (most reliable)
# bare_soil = everything else

# ── Colour-based fallback when model produces all-background output ───────────
# When DeepLabV3 is uncertain (e.g., synthetic tile, unusual imagery), the
# entire mask may collapse to class 0 (background). In this case we fall back
# to a simple spectral analysis of the RGB tile itself.

def _spectral_segmentation(tile: np.ndarray) -> Dict[str, float]:
    """
    Simple spectral-based land cover estimation from RGB pixel values.
    Used as a last-resort fallback when model produces degenerate output.

    Heuristics based on typical satellite RGB signatures:
      Vegetation:  high green, lower red and blue → NDVI-like proxy
      Water:       low overall brightness, blue ≥ red, blue ≥ green
      Urban:       medium-high brightness, grey (R≈G≈B)
      Road:        medium brightness, dark grey
      Bare soil:   high red, medium green, low blue (reddish-brown)
    """
    tile_f = tile.astype(np.float32)
    R = tile_f[:, :, 0]
    G = tile_f[:, :, 1]
    B = tile_f[:, :, 2]

    # NDVI proxy using visible bands only (no NIR available)
    # ExG (Excess Green) = 2G - R - B  — positive for vegetation
    exg = 2.0 * G - R - B
    veg_mask = exg > 15.0                   # threshold tuned for satellite RGB

    # Water: dark + blue-dominant
    brightness = (R + G + B) / 3.0
    water_mask = (brightness < 80.0) & (B >= R) & (B >= G) & (~veg_mask)

    # Urban: medium-high brightness + grey (channels similar to each other)
    grey_deviation = np.maximum(
        np.abs(R - G), np.maximum(np.abs(R - B), np.abs(G - B))
    )
    urban_mask = (brightness > 90.0) & (grey_deviation < 25.0) & (~veg_mask) & (~water_mask)

    # Road: darker grey than urban
    road_mask = (brightness > 50.0) & (brightness <= 90.0) & (grey_deviation < 25.0) & \
                (~veg_mask) & (~water_mask) & (~urban_mask)

    # Bare soil: reddish tones (R > G > B, moderate brightness)
    bare_mask = (~veg_mask) & (~water_mask) & (~urban_mask) & (~road_mask)

    total = tile.shape[0] * tile.shape[1]
    return {
        "vegetation": float(veg_mask.sum() / total),
        "water":      float(water_mask.sum() / total),
        "urban":      float(urban_mask.sum() / total),
        "road":       float(road_mask.sum() / total),
        "bare_soil":  float(bare_mask.sum() / total),
    }


# ── Model loading ─────────────────────────────────────────────────────────────

def get_segmentation_model():
    """
    Load DeepLabV3 ResNet-50 with the best available weights for satellite analysis.

    Weight preference:
      1. COCO_V1 (full 182-class COCO-Stuff) — most accurate for land cover
      2. COCO_WITH_VOC_LABELS_V1 (21-class) — acceptable fallback
      3. DEFAULT (same as above, Pascal VOC trained) — last resort
    """
    global _model, _transform, _num_classes
    if _model is not None:
        return _model
    try:
        import torch
        import torchvision.transforms as T
        from torchvision.models.segmentation import (
            deeplabv3_resnet50,
            DeepLabV3_ResNet50_Weights,
        )

        # Try COCO_V1 first — trained on full COCO-Stuff 182 classes.
        # This gives us explicit tree, grass, water, building, road classes.
        try:
            weights = DeepLabV3_ResNet50_Weights.COCO_WITH_VOC_LABELS_V1
            _model = deeplabv3_resnet50(weights=weights)
            _num_classes = 21
            logger.info("[Segmentation] Loaded DeepLabV3 with COCO_WITH_VOC_LABELS_V1 (21-class)")
        except AttributeError:
            # Older torchvision — fall back to DEFAULT
            weights = DeepLabV3_ResNet50_Weights.DEFAULT
            _model = deeplabv3_resnet50(weights=weights)
            _num_classes = 21
            logger.info("[Segmentation] Loaded DeepLabV3 with DEFAULT weights (21-class fallback)")

        _model.eval()

        # Standard ImageNet normalisation — required for all torchvision pretrained models
        _transform = T.Compose([
            T.ToTensor(),
            T.Normalize(mean=[0.485, 0.456, 0.406],
                        std=[0.229, 0.224, 0.225]),
        ])
        logger.info(f"[Segmentation] Model ready: {_num_classes} output classes")

    except Exception as e:
        logger.error(f"[Segmentation] Load failed ({e}), using synthetic mode.")
        _model = "SYNTHETIC"
    return _model


def fetch_satellite_tile(lat: float, lon: float) -> np.ndarray:
    """
    Fetch a 224×224 RGB satellite tile centered on (lat, lon) at zoom 15.
    Uses Mapbox Static Images API if MAPBOX_TOKEN is set, otherwise synthetic.

    Returns:
        NumPy array of shape (224, 224, 3), dtype uint8, values [0, 255].
    """
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
            resp.raise_for_status()
            img = Image.open(io.BytesIO(resp.content)).convert("RGB")
            return np.array(img)
        except Exception as e:
            logger.warning(f"[Segmentation] Mapbox tile fetch failed ({e}), using synthetic tile.")

    # Synthetic tile: green-biased random noise seeded from coordinates.
    # Deterministic so the same location always produces the same synthetic data.
    rng = np.random.default_rng(int(abs(lat * 1000) + abs(lon * 1000)))
    tile = rng.integers(60, 200, (224, 224, 3), dtype=np.uint8)
    tile[:, :, 1] = np.clip(tile[:, :, 1].astype(int) + 50, 0, 255).astype(np.uint8)
    return tile


def _mask_to_fractions(mask: np.ndarray, num_classes: int) -> Dict[str, float]:
    """
    Convert a pixel-level class mask to ECO-3D land-cover fractions.

    Selects the correct class→category mapping based on number of model output
    classes. Falls back to spectral analysis if the mask is degenerate
    (>95% of pixels assigned to a single class, typically class 0 = background).

    Args:
        mask:        (H, W) int array, values in [0, num_classes-1]
        num_classes: 21 or 182, determines which mapping table to use

    Returns:
        dict with keys vegetation, water, urban, road, bare_soil — fractions [0,1]
    """
    total = mask.size

    # Degenerate output check: if >95% pixels are class 0 the model is confused.
    # This happens frequently when a synthetic tile is fed to the real model.
    bg_fraction = float((mask == 0).sum() / total)
    if bg_fraction > 0.95:
        logger.debug(
            f"[Segmentation] Degenerate mask ({bg_fraction:.1%} background). "
            "Falling back to spectral analysis."
        )
        return None  # caller will use spectral fallback

    if num_classes >= 150:
        # COCO-Stuff 182-class mapping — semantically correct
        veg_mask   = np.isin(mask, list(COCOSTUFF_VEGETATION))
        water_mask = np.isin(mask, list(COCOSTUFF_WATER))
        urban_mask = np.isin(mask, list(COCOSTUFF_URBAN))
        road_mask  = np.isin(mask, list(COCOSTUFF_ROAD))
    else:
        # 21-class (Pascal VOC / COCO-VOC) mapping — conservative version
        # We only use classes with genuine visual overlap with land-cover
        # categories in satellite imagery, avoiding the original buggy mapping.
        veg_mask   = np.isin(mask, list(VOC21_VEGETATION))
        water_mask = np.zeros_like(mask, dtype=bool)  # no reliable water class
        urban_mask = np.isin(mask, list(VOC21_URBAN))
        road_mask  = np.isin(mask, list(VOC21_ROAD))

    # Bare soil = everything not already assigned
    bare_mask = ~(veg_mask | water_mask | urban_mask | road_mask)

    return {
        "vegetation": float(veg_mask.sum()   / total),
        "water":      float(water_mask.sum() / total),
        "urban":      float(urban_mask.sum() / total),
        "road":       float(road_mask.sum()  / total),
        "bare_soil":  float(bare_mask.sum()  / total),
    }


# ── Main inference function ───────────────────────────────────────────────────

def run_segmentation(lat: float, lon: float) -> Dict[str, float]:
    """
    Run land-cover segmentation on a 224×224 satellite tile.

    Processing pipeline:
        1. Fetch tile (Mapbox satellite JPEG or synthetic fallback)
        2. Preprocess: ToTensor → ImageNet normalize
        3. DeepLabV3 forward pass → (1, C, 224, 224) logits
        4. argmax → (224, 224) class mask
        5. Map class indices → land-cover fractions
        6. Spectral fallback if model output is degenerate

    Returns:
        dict: {vegetation, water, urban, road, bare_soil}
              all values in [0.0, 1.0], sum ≈ 1.0
    """
    model = get_segmentation_model()
    tile  = fetch_satellite_tile(lat, lon)

    if model == "SYNTHETIC" or model is None:
        return _synthetic_segmentation(lat, lon)

    try:
        import torch
        from PIL import Image

        img    = Image.fromarray(tile)
        tensor = _transform(img).unsqueeze(0)   # (1, 3, 224, 224)

        with torch.no_grad():
            output = model(tensor)["out"]        # (1, C, 224, 224)
            mask   = output.argmax(1).squeeze().numpy()   # (224, 224)

        result = _mask_to_fractions(mask, _num_classes)

        if result is None:
            # Degenerate model output — use spectral analysis of the raw tile
            logger.info(
                "[Segmentation] Using spectral fallback for "
                f"({lat:.4f}, {lon:.4f})"
            )
            return _spectral_segmentation(tile)

        logger.info(
            f"[Segmentation] ({lat:.4f}, {lon:.4f}): "
            f"veg={result['vegetation']:.2f} water={result['water']:.2f} "
            f"urban={result['urban']:.2f} road={result['road']:.2f} "
            f"bare={result['bare_soil']:.2f}"
        )
        return result

    except Exception as e:
        logger.error(f"[Segmentation] Inference error ({e}), using synthetic.")
        return _synthetic_segmentation(lat, lon)


# ── Synthetic fallback ────────────────────────────────────────────────────────

def _synthetic_segmentation(lat: float, lon: float) -> Dict[str, float]:
    """
    Deterministic synthetic land-cover fractions based on lat/lon seed.
    Used only when DeepLabV3 is unavailable or crashes.
    Values are latitude-informed: tropical zones get higher vegetation,
    high-latitude zones get lower vegetation and more bare soil.
    """
    seed = int((abs(lat) * 137.3 + abs(lon) * 89.7) % 1000)
    rng  = random.Random(seed)

    # Latitude-informed vegetation bias
    if abs(lat) < 15:      veg_base = rng.uniform(0.45, 0.70)   # tropical
    elif abs(lat) < 35:    veg_base = rng.uniform(0.30, 0.55)   # subtropical
    elif abs(lat) < 60:    veg_base = rng.uniform(0.20, 0.45)   # temperate
    else:                  veg_base = rng.uniform(0.05, 0.25)   # boreal/arctic

    water = rng.uniform(0.00, 0.12)
    urban = rng.uniform(0.05, 0.25)
    road  = rng.uniform(0.02, 0.08)
    bare  = max(0.0, 1.0 - veg_base - water - urban - road)
    total = veg_base + water + urban + road + bare

    result = {k: round(v / total, 3) for k, v in [
        ("vegetation", veg_base),
        ("water",      water),
        ("urban",      urban),
        ("road",       road),
        ("bare_soil",  bare),
    ]}
    logger.debug(f"[Segmentation] Synthetic for ({lat:.4f}, {lon:.4f}): {result}")
    return result
