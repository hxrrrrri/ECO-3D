"""
generate_synthetic_data.py
──────────────────────────
Generates realistic synthetic training datasets for all ECO-3D AI models.
Saves CSV files to  eco3d/data/  that the training scripts then consume.

Run from the project root:
    python scripts/generate_synthetic_data.py

Outputs:
    data/flood_training.csv          (2 000 samples)
    data/buildability_training.csv   (3 000 samples)
    data/segmentation_labels.csv     (meta-labels, 500 tiles)
"""

import os
import math
import random
import argparse
import csv
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

# ── Reproducibility ────────────────────────────────────────────────────────
SEED = 42
random.seed(SEED)

try:
    import numpy as np
    np.random.seed(SEED)
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False
    print("NumPy not found — using Python random (slower but works)")


# ══════════════════════════════════════════════════════════════════════════════
#  HELPERS
# ══════════════════════════════════════════════════════════════════════════════

SOIL_TYPES = ["Clay Loam", "Sandy Loam", "Silty Clay", "Loam",
              "Sandy Clay Loam", "Sand", "Silt Loam", "Clay"]
SOIL_STABILITY = {
    "Clay Loam": 0.55, "Sandy Loam": 0.35, "Silty Clay": 0.70,
    "Loam": 0.50, "Sandy Clay Loam": 0.45, "Sand": 0.20,
    "Silt Loam": 0.60, "Clay": 0.80,
}
WIND_DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def rng_float(lo, hi):
    return random.uniform(lo, hi)


def rng_choice(lst):
    return random.choice(lst)


def clamp(v, lo=0.0, hi=1.0):
    return max(lo, min(hi, v))


def noise(scale=0.05):
    return random.gauss(0, scale)


# ══════════════════════════════════════════════════════════════════════════════
#  DATASET 1 — FLOOD RISK
#  Features: elevation, slope, ndvi, rainfall_mm, soil_stability,
#             distance_to_water_m
#  Target:   flood_probability  (0.0 – 1.0, regression)
# ══════════════════════════════════════════════════════════════════════════════

FLOOD_FEATURES = [
    "elevation_m", "slope_deg", "ndvi", "rainfall_mm",
    "soil_stability", "distance_to_water_m",
    "flood_probability",   # label
]


def generate_flood_sample():
    elevation    = rng_float(0, 500)
    slope        = rng_float(0, 40)
    ndvi         = rng_float(-0.1, 0.9)
    rainfall     = rng_float(100, 3000)
    soil_type    = rng_choice(SOIL_TYPES)
    soil_stab    = SOIL_STABILITY[soil_type]
    dist_water   = rng_float(10, 5000)

    # Physics-based flood model
    prob = (
        0.40 * clamp(1 - elevation / 100)          # low elevation → flood risk
      + 0.15 * clamp(1 - slope / 30)               # flat land → pools
      + 0.10 * clamp((rainfall - 500) / 2500)      # heavy rainfall
      + 0.15 * clamp(1 - ndvi)                     # bare land absorbs less
      + 0.10 * clamp(1 - dist_water / 500)         # close to water
      + 0.10 * soil_stab                            # clay = poor drainage
      + noise(0.04)
    )
    return {
        "elevation_m":        round(elevation, 2),
        "slope_deg":          round(slope, 2),
        "ndvi":               round(clamp(ndvi, -0.1, 1.0), 4),
        "rainfall_mm":        round(rainfall, 1),
        "soil_stability":     round(soil_stab, 3),
        "distance_to_water_m": round(dist_water, 1),
        "flood_probability":  round(clamp(prob), 4),
    }


def generate_flood_dataset(n=2000):
    path = DATA_DIR / "flood_training.csv"
    print(f"  Generating {n} flood-risk samples → {path}")
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FLOOD_FEATURES)
        writer.writeheader()
        for _ in range(n):
            writer.writerow(generate_flood_sample())
    print(f"  ✓ Saved {n} rows")
    return path


# ══════════════════════════════════════════════════════════════════════════════
#  DATASET 2 — BUILDABILITY SCORE
#  Features: flood_prob, slope_norm, soil_stability, vegetation_density,
#             wind_exposure, sun_score
#  Target:   buildability_score  (0 – 100, regression)
# ══════════════════════════════════════════════════════════════════════════════

BUILD_FEATURES = [
    "flood_probability", "slope_norm", "soil_stability",
    "vegetation_density", "wind_exposure", "sun_score",
    "buildability_score",   # label
]


def generate_build_sample():
    flood_prob  = rng_float(0, 1)
    slope       = rng_float(0, 45)
    soil_stab   = rng_float(0.2, 0.9)
    veg_density = rng_float(0, 1)
    wind_ms     = rng_float(0, 15)
    sun_hours   = rng_float(3, 14)

    slope_norm  = clamp(slope / 45)
    wind_exp    = clamp(wind_ms / 15)
    sun_score   = clamp(sun_hours / 12)

    score = (
        100
      - 35 * flood_prob          # flood risk = biggest penalty
      - 20 * slope_norm          # steep slopes cost money
      - 10 * (1 - soil_stab)    # weak soil = foundations cost more
      +  5 * veg_density         # greenery is a plus
      -  8 * wind_exp            # strong wind = structural cost
      +  8 * sun_score           # passive solar = energy saving
      + noise(3)
    )
    return {
        "flood_probability":  round(clamp(flood_prob), 4),
        "slope_norm":         round(slope_norm, 4),
        "soil_stability":     round(soil_stab, 4),
        "vegetation_density": round(veg_density, 4),
        "wind_exposure":      round(wind_exp, 4),
        "sun_score":          round(sun_score, 4),
        "buildability_score": round(clamp(score, 0, 100), 2),
    }


def generate_build_dataset(n=3000):
    path = DATA_DIR / "buildability_training.csv"
    print(f"  Generating {n} buildability samples → {path}")
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=BUILD_FEATURES)
        writer.writeheader()
        for _ in range(n):
            writer.writerow(generate_build_sample())
    print(f"  ✓ Saved {n} rows")
    return path


# ══════════════════════════════════════════════════════════════════════════════
#  DATASET 3 — SEGMENTATION META-LABELS
#  (lat, lon pairs with expected dominant land class — for quick eval only;
#   actual DeepLabV3 training needs full image tiles, see TRAIN_SEGMENTATION.md)
# ══════════════════════════════════════════════════════════════════════════════

SEG_CLASSES  = ["vegetation", "bare_land", "water", "urban", "agriculture", "forest"]
SEG_FEATURES = ["lat", "lon", "zoom", "dominant_class",
                "vegetation_pct", "bare_land_pct", "water_pct",
                "urban_pct", "agriculture_pct", "forest_pct"]


def generate_seg_sample():
    lat  = rng_float(-60, 60)
    lon  = rng_float(-180, 180)
    zoom = 18

    # Heuristic land class by latitude zone
    if abs(lat) < 10:
        dominant = rng_choice(["vegetation", "forest"])
    elif abs(lat) < 30:
        dominant = rng_choice(["bare_land", "agriculture", "urban"])
    elif abs(lat) < 50:
        dominant = rng_choice(["agriculture", "vegetation", "urban"])
    else:
        dominant = rng_choice(["bare_land", "vegetation"])

    # Distribute percentages
    dom_pct = rng_float(0.35, 0.70)
    remaining = 1.0 - dom_pct
    others = [c for c in SEG_CLASSES if c != dominant]
    splits = sorted([rng_float(0, remaining) for _ in range(len(others) - 1)] + [0, remaining])
    pcts   = {c: round(splits[i+1] - splits[i], 4) for i, c in enumerate(others)}
    pcts[dominant] = round(dom_pct, 4)

    row = {"lat": round(lat, 6), "lon": round(lon, 6),
           "zoom": zoom, "dominant_class": dominant}
    for c in SEG_CLASSES:
        row[f"{c}_pct"] = pcts.get(c, 0.0)
    return row


def generate_seg_dataset(n=500):
    path = DATA_DIR / "segmentation_labels.csv"
    print(f"  Generating {n} segmentation meta-labels → {path}")
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=SEG_FEATURES)
        writer.writeheader()
        for _ in range(n):
            writer.writerow(generate_seg_sample())
    print(f"  ✓ Saved {n} rows")
    return path


# ══════════════════════════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="Generate ECO-3D synthetic training data")
    parser.add_argument("--flood-samples",  type=int, default=2000)
    parser.add_argument("--build-samples",  type=int, default=3000)
    parser.add_argument("--seg-samples",    type=int, default=500)
    args = parser.parse_args()

    print("\n══ ECO-3D Synthetic Data Generator ══\n")
    generate_flood_dataset(args.flood_samples)
    generate_build_dataset(args.build_samples)
    generate_seg_dataset(args.seg_samples)
    print(f"\n✅  All datasets written to {DATA_DIR}/\n")


if __name__ == "__main__":
    main()
