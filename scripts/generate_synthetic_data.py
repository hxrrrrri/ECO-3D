"""
generate_synthetic_data.py  — ECO-3D v3.0 (Scientifically Grounded)
======================================================================
Generates synthetic training datasets using PUBLISHED equations as labels.

CHANGE FROM v2.x:
  Old version used ad-hoc physics formulas invented for this project.
  This version derives training labels from:
    - NRCS SCS Curve Number method [SCS TR-55, 1986]
    - Tehrany et al. (2015) frequency ratio weights
    - LEED BD+C v4 Sustainable Sites criteria
    - NBC 2016 Part 7 (National Building Code of India)
    - ASHRAE Standard 55-2020

  This ensures the XGBoost and MLP models learn the same scientifically-
  grounded scoring used at inference time (model-label consistency).

Outputs:
    data/flood_training.csv          (5 000 samples)
    data/buildability_training.csv   (5 000 samples)
    data/segmentation_labels.csv     (meta-labels, 500 tiles)

Run from project root:
    python scripts/generate_synthetic_data.py
    python scripts/generate_synthetic_data.py --flood-samples 8000 --build-samples 8000
"""

import os
import sys
import math
import random
import argparse
import csv
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────────────
ROOT     = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

# Add backend to path so we can import the scientific calculation functions
sys.path.insert(0, str(ROOT / "backend" / "services"))

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

# ── Import scientifically-grounded label generators ────────────────────────
try:
    from real_env_data import (
        generate_flood_training_sample,
        generate_buildability_training_label,
        compute_sun_hours,
    )
    USE_SCIENTIFIC_LABELS = True
    print("✓ Using NRCS/LEED/NBC scientifically-grounded label generators")
except ImportError as e:
    print(f"Warning: Could not import scientific functions ({e})")
    print("Falling back to simplified label generation.")
    USE_SCIENTIFIC_LABELS = False


# ══════════════════════════════════════════════════════════════════════════════
#  SOIL TYPE TABLES
# ══════════════════════════════════════════════════════════════════════════════

# USDA texture classes with typical clay% ranges [USDA Soil Taxonomy 1999]
SOIL_PROFILES = {
    "Sand":             {"clay_pct": 3,  "sand_pct": 92, "silt_pct": 5,  "buildable": True},
    "Loamy Sand":       {"clay_pct": 6,  "sand_pct": 80, "silt_pct": 14, "buildable": True},
    "Sandy Loam":       {"clay_pct": 10, "sand_pct": 65, "silt_pct": 25, "buildable": True},
    "Loam":             {"clay_pct": 20, "sand_pct": 40, "silt_pct": 40, "buildable": True},
    "Silt Loam":        {"clay_pct": 14, "sand_pct": 20, "silt_pct": 66, "buildable": True},
    "Sandy Clay Loam":  {"clay_pct": 28, "sand_pct": 58, "silt_pct": 14, "buildable": True},
    "Clay Loam":        {"clay_pct": 34, "sand_pct": 32, "silt_pct": 34, "buildable": True},
    "Silty Clay Loam":  {"clay_pct": 34, "sand_pct": 10, "silt_pct": 56, "buildable": True},
    "Sandy Clay":       {"clay_pct": 42, "sand_pct": 52, "silt_pct": 6,  "buildable": True},
    "Silty Clay":       {"clay_pct": 46, "sand_pct": 6,  "silt_pct": 48, "buildable": False},
    "Clay":             {"clay_pct": 50, "sand_pct": 20, "silt_pct": 30, "buildable": False},
    "Heavy Clay":       {"clay_pct": 65, "sand_pct": 10, "silt_pct": 25, "buildable": False},
}

SOIL_TYPES = list(SOIL_PROFILES.keys())
WIND_DIRS  = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def rng_float(lo, hi):
    return random.uniform(lo, hi)

def rng_choice(lst):
    return random.choice(lst)

def clamp(v, lo=0.0, hi=1.0):
    return max(lo, min(hi, v))

def noise_gauss(scale=0.04):
    return random.gauss(0, scale)

def add_noise(v, lo, hi, sigma=0.04):
    """Add Gaussian noise and clamp to [lo, hi]."""
    return clamp(v + noise_gauss(sigma), lo, hi)


# ══════════════════════════════════════════════════════════════════════════════
#  DATASET 1 — FLOOD RISK TRAINING DATA
#
#  Features match the XGBoost model's expected input:
#    elevation_m, slope_deg, ndvi, rainfall_mm, soil_stability,
#    distance_to_water_m
#
#  Labels: flood_probability [0,1] derived from:
#    NRCS SCS Curve Number method [SCS TR-55, 1986]
#    Tehrany et al. (2015) FR consensus weights
#    Topographic Wetness Index [Beven & Kirkby 1979]
# ══════════════════════════════════════════════════════════════════════════════

FLOOD_FEATURES = [
    "elevation_m", "slope_deg", "ndvi", "rainfall_mm",
    "soil_stability", "distance_to_water_m",
    "flood_probability",
]


def generate_flood_sample() -> dict:
    """
    Generate one flood risk training sample.
    Label is computed via the NRCS CN method and Tehrany (2015) weights.
    [SCS TR-55 1986; Tehrany et al. 2015; Beven & Kirkby 1979]
    """
    # Realistic global range sampling
    # Elevation: exponential towards lower values (most plots < 200m)
    elevation  = rng_float(0, 500)
    slope_deg  = rng_float(0, 35)
    ndvi       = rng_float(-0.05, 0.90)
    rainfall   = rng_float(150, 3200)   # mm/year, global range
    soil_type  = rng_choice(SOIL_TYPES)
    dist_water = rng_float(10, 5000)    # metres

    profile = SOIL_PROFILES[soil_type]
    clay_fraction = profile["clay_pct"] / 100.0
    # soil_stability: complement of clay fraction (used as XGBoost feature)
    soil_stability = round(1.0 - clay_fraction, 3)

    # Generate scientifically-grounded label
    if USE_SCIENTIFIC_LABELS:
        flood_prob = generate_flood_training_sample(
            elevation=elevation,
            slope_deg=slope_deg,
            ndvi=ndvi,
            rainfall_mm=rainfall,
            soil_type=soil_type,
            distance_to_water=dist_water,
            clay_fraction=clay_fraction,
            lat=rng_float(-45, 45),  # realistic lat range for building sites
        )
        # Add small realistic noise to avoid perfectly noiseless training data
        flood_prob = clamp(flood_prob + noise_gauss(0.025), 0.01, 0.97)
    else:
        # Fallback: simplified physics (if import failed)
        flood_prob = clamp(
            0.40 * clamp(1 - elevation / 100) +
            0.15 * clamp(1 - slope_deg / 30) +
            0.10 * clamp((rainfall - 500) / 2500) +
            0.15 * clamp(1 - ndvi) +
            0.10 * clamp(1 - dist_water / 500) +
            0.10 * clay_fraction +
            noise_gauss(0.04)
        )

    return {
        "elevation_m":         round(elevation, 2),
        "slope_deg":           round(slope_deg, 2),
        "ndvi":                round(clamp(ndvi, -0.1, 1.0), 4),
        "rainfall_mm":         round(rainfall, 1),
        "soil_stability":      soil_stability,
        "distance_to_water_m": round(dist_water, 1),
        "flood_probability":   round(flood_prob, 4),
    }


def generate_flood_dataset(n: int = 5000) -> Path:
    path = DATA_DIR / "flood_training.csv"
    print(f"  Generating {n} flood-risk samples → {path}")
    label = "NRCS CN + Tehrany (2015)" if USE_SCIENTIFIC_LABELS else "simplified physics"
    print(f"  Label method: {label}")
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FLOOD_FEATURES)
        writer.writeheader()
        for i in range(n):
            writer.writerow(generate_flood_sample())
            if (i + 1) % 1000 == 0:
                print(f"    {i+1}/{n} samples generated")
    print(f"  ✓ Saved {n} rows to {path}")
    return path


# ══════════════════════════════════════════════════════════════════════════════
#  DATASET 2 — BUILDABILITY SCORE TRAINING DATA
#
#  Features match the MLP model's expected input:
#    flood_probability, slope_norm, soil_stability, vegetation_density,
#    wind_exposure, sun_score
#
#  Labels: buildability_score [0,100] derived from:
#    LEED BD+C v4 Sustainable Sites criteria (USGBC 2019)
#    NBC 2016 Part 7: Foundations and Site Works (BIS 2016)
#    ASHRAE Standard 55-2020: Thermal Environmental Conditions
# ══════════════════════════════════════════════════════════════════════════════

BUILD_FEATURES = [
    "flood_probability", "slope_norm", "soil_stability",
    "vegetation_density", "wind_exposure", "sun_score",
    "buildability_score",
]


def generate_build_sample() -> dict:
    """
    Generate one buildability training sample.
    Label derived from LEED BD+C v4, NBC 2016, ASHRAE 55-2020.
    """
    # Raw physical parameters
    flood_prob   = rng_float(0.01, 0.95)
    slope_deg    = rng_float(0, 40)
    soil_type    = rng_choice(SOIL_TYPES)
    ndvi         = rng_float(0.0, 0.90)
    wind_ms      = rng_float(0.5, 15.0)
    elevation    = rng_float(0, 800)
    lat          = rng_float(-45, 45)
    sun_hours    = compute_sun_hours(lat) if USE_SCIENTIFIC_LABELS else rng_float(6, 14)

    profile       = SOIL_PROFILES[soil_type]
    clay_pct      = profile["clay_pct"] + rng_float(-3, 3)
    clay_pct      = clamp(clay_pct, 2, 70)
    soil_buildable = profile["buildable"]
    soil_ph        = rng_float(4.5, 8.8)
    bulk_density   = rng_float(0.9, 2.0)
    soil_stability = clamp(1.0 - clay_pct / 100.0)

    # Normalised features for the model (these are what get stored in CSV)
    slope_norm  = clamp(slope_deg / 45.0)
    wind_exp    = clamp(wind_ms / 15.0)
    sun_score   = clamp(sun_hours / 14.0)

    # Generate scientifically-grounded label [LEED BD+C v4; NBC 2016; ASHRAE 55]
    if USE_SCIENTIFIC_LABELS:
        score = generate_buildability_training_label(
            flood_prob=flood_prob,
            slope_deg=slope_deg,
            soil_buildable=soil_buildable,
            clay_pct=clay_pct,
            ndvi=ndvi,
            wind_ms=wind_ms,
            sun_hours=sun_hours,
            elevation=elevation,
            soil_ph=soil_ph,
            bulk_density=bulk_density,
        )
        score = clamp(score + noise_gauss(2.5), 1.0, 99.0)
    else:
        # Fallback: simplified formula
        score = clamp(
            100 - 35 * flood_prob - 20 * slope_norm - 10 * (1 - soil_stability) +
            5 * ndvi - 8 * wind_exp + 8 * sun_score + noise_gauss(3),
            0, 100
        )

    return {
        "flood_probability":  round(clamp(flood_prob), 4),
        "slope_norm":         round(slope_norm, 4),
        "soil_stability":     round(soil_stability, 4),
        "vegetation_density": round(clamp(ndvi), 4),
        "wind_exposure":      round(wind_exp, 4),
        "sun_score":          round(sun_score, 4),
        "buildability_score": round(clamp(score, 0, 100), 2),
    }


def generate_build_dataset(n: int = 5000) -> Path:
    path = DATA_DIR / "buildability_training.csv"
    print(f"  Generating {n} buildability samples → {path}")
    label = "LEED BD+C v4 + NBC 2016 + ASHRAE 55" if USE_SCIENTIFIC_LABELS else "simplified formula"
    print(f"  Label method: {label}")
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=BUILD_FEATURES)
        writer.writeheader()
        for i in range(n):
            writer.writerow(generate_build_sample())
            if (i + 1) % 1000 == 0:
                print(f"    {i+1}/{n} samples generated")
    print(f"  ✓ Saved {n} rows to {path}")
    return path


# ══════════════════════════════════════════════════════════════════════════════
#  DATASET 3 — SEGMENTATION META-LABELS (unchanged)
# ══════════════════════════════════════════════════════════════════════════════

SEG_CLASSES  = ["vegetation", "bare_land", "water", "urban", "agriculture", "forest"]
SEG_FEATURES = ["lat", "lon", "zoom", "dominant_class",
                "vegetation_pct", "bare_land_pct", "water_pct",
                "urban_pct", "agriculture_pct", "forest_pct"]


def generate_seg_sample() -> dict:
    lat  = rng_float(-60, 60)
    lon  = rng_float(-180, 180)
    zoom = 18

    if abs(lat) < 10:
        dominant = rng_choice(["vegetation", "forest"])
    elif abs(lat) < 30:
        dominant = rng_choice(["bare_land", "agriculture", "urban"])
    elif abs(lat) < 50:
        dominant = rng_choice(["agriculture", "vegetation", "urban"])
    else:
        dominant = rng_choice(["bare_land", "vegetation"])

    dom_pct  = rng_float(0.35, 0.70)
    remaining = 1.0 - dom_pct
    others   = [c for c in SEG_CLASSES if c != dominant]
    splits   = sorted(
        [rng_float(0, remaining) for _ in range(len(others) - 1)] + [0, remaining]
    )
    pcts = {c: round(splits[i+1] - splits[i], 4) for i, c in enumerate(others)}
    pcts[dominant] = round(dom_pct, 4)

    row = {"lat": round(lat, 6), "lon": round(lon, 6),
           "zoom": zoom, "dominant_class": dominant}
    for c in SEG_CLASSES:
        row[f"{c}_pct"] = pcts.get(c, 0.0)
    return row


def generate_seg_dataset(n: int = 500) -> Path:
    path = DATA_DIR / "segmentation_labels.csv"
    print(f"  Generating {n} segmentation meta-labels → {path}")
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=SEG_FEATURES)
        writer.writeheader()
        for _ in range(n):
            writer.writerow(generate_seg_sample())
    print(f"  ✓ Saved {n} rows to {path}")
    return path


# ══════════════════════════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description="Generate ECO-3D synthetic training data (scientifically grounded v3.0)"
    )
    parser.add_argument("--flood-samples", type=int, default=5000,
                        help="Number of flood risk samples (default: 5000)")
    parser.add_argument("--build-samples", type=int, default=5000,
                        help="Number of buildability samples (default: 5000)")
    parser.add_argument("--seg-samples",   type=int, default=500,
                        help="Number of segmentation meta-labels (default: 500)")
    args = parser.parse_args()

    print("\n══ ECO-3D Synthetic Data Generator v3.0 ══")
    print(f"   Labels: {'Scientific (NRCS/LEED/NBC)' if USE_SCIENTIFIC_LABELS else 'Simplified fallback'}\n")

    generate_flood_dataset(args.flood_samples)
    print()
    generate_build_dataset(args.build_samples)
    print()
    generate_seg_dataset(args.seg_samples)
    print(f"\n✅  All datasets written to {DATA_DIR}/\n")
    print("Next step: run train_flood_model.py and train_buildability_model.py")


if __name__ == "__main__":
    main()
