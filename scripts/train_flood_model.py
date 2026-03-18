"""
train_flood_model.py  — ECO-3D v3.0
======================================
Trains the XGBoost flood-risk regression model (Layer 3).

Labels now come from NRCS SCS CN method + Tehrany (2015) FR weights,
replacing the previous ad-hoc physics formula.

Prerequisites:
    pip install xgboost scikit-learn numpy pandas matplotlib

Run from project root:
    python scripts/train_flood_model.py
    python scripts/train_flood_model.py --samples 8000 --estimators 300

Output:
    backend/ai/flood/weights/flood_xgboost.pkl
    backend/ai/flood/weights/flood_metrics.json
"""

import sys
import argparse
import pickle
import json
from pathlib import Path

SCRIPTS_DIR  = Path(__file__).resolve().parent
ROOT         = SCRIPTS_DIR.parent
WEIGHTS_DIR  = ROOT / "backend" / "ai" / "flood" / "weights"
DATA_DIR     = ROOT / "data"
MODEL_PATH   = WEIGHTS_DIR / "flood_xgboost.pkl"
METRICS_PATH = WEIGHTS_DIR / "flood_metrics.json"

sys.path.insert(0, str(SCRIPTS_DIR))


def load_or_generate_data(n_samples: int):
    csv_path = DATA_DIR / "flood_training.csv"
    if not csv_path.exists():
        print("  No CSV found — generating training data first...")
        from generate_synthetic_data import generate_flood_dataset
        generate_flood_dataset(n_samples)
    import pandas as pd
    df = pd.read_csv(csv_path)
    print(f"  Loaded {len(df)} samples from {csv_path}")
    print(f"  Columns: {list(df.columns)}")
    return df


def train(args):
    try:
        import numpy as np
        import xgboost as xgb
        from sklearn.model_selection import train_test_split
        from sklearn.preprocessing import StandardScaler
        from sklearn.metrics import mean_absolute_error, r2_score
    except ImportError as e:
        print(f"\n❌  Missing: {e}\n   pip install xgboost scikit-learn numpy pandas\n")
        sys.exit(1)

    print("\n══ Flood Risk Model Training (XGBoost) ══\n")
    WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)

    df = load_or_generate_data(args.samples)

    # ── Feature columns — must match generate_synthetic_data.py output ──────
    # CSV columns: elevation_m, slope_deg, ndvi, rainfall_mm,
    #              soil_stability, distance_to_water_m, flood_probability
    FEATURES = [
        "elevation_m",
        "slope_deg",
        "ndvi",
        "rainfall_mm",
        "soil_stability",       # = 1 - clay_fraction
        "distance_to_water_m",
    ]
    LABEL = "flood_probability"

    # Validate all columns present
    missing = [c for c in FEATURES + [LABEL] if c not in df.columns]
    if missing:
        print(f"\n❌  Missing columns in CSV: {missing}")
        print(f"   Available: {list(df.columns)}")
        print("   Delete data/flood_training.csv and re-run generate_synthetic_data.py")
        sys.exit(1)

    X = df[FEATURES].values.astype("float32")
    y = df[LABEL].values.astype("float32")

    # StandardScaler — stored with model for inference consistency
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X).astype("float32")

    X_train, X_val, y_train, y_val = train_test_split(
        X_scaled, y, test_size=0.20, random_state=42
    )
    print(f"  Train: {len(X_train)}  Val: {len(X_val)}")

    # ── Model ────────────────────────────────────────────────────────────────
    model = xgb.XGBRegressor(
        n_estimators=args.estimators,
        max_depth=args.max_depth,
        learning_rate=args.lr,
        subsample=0.85,
        colsample_bytree=0.85,
        min_child_weight=3,
        gamma=0.1,
        objective="reg:squarederror",
        tree_method="hist",
        random_state=42,
        n_jobs=-1,
        early_stopping_rounds=30,
    )

    print(f"\n  Training: estimators={args.estimators}, depth={args.max_depth}, lr={args.lr}")
    model.fit(
        X_train, y_train,
        eval_set=[(X_val, y_val)],
        verbose=args.verbose,
    )

    # ── Evaluation ────────────────────────────────────────────────────────────
    preds = model.predict(X_val)
    preds = preds.clip(0.0, 1.0)
    mae  = mean_absolute_error(y_val, preds)
    r2   = r2_score(y_val, preds)

    print(f"\n  ── Validation Metrics ──")
    print(f"  MAE:  {mae:.4f}   (target < 0.05)")
    print(f"  R²:   {r2:.4f}   (target > 0.90)")

    # Feature importances
    importances = dict(zip(FEATURES, model.feature_importances_))
    print("\n  Feature importances:")
    for feat, imp in sorted(importances.items(), key=lambda x: -x[1]):
        bar = "█" * int(imp * 40)
        print(f"    {feat:<25} {imp:.3f}  {bar}")

    # ── Save ─────────────────────────────────────────────────────────────────
    bundle = {
        "model":         model,
        "scaler":        scaler,
        "features":      FEATURES,
        "label":         LABEL,
        "label_method":  "NRCS CN + Tehrany (2015) FR weights",
    }
    with open(MODEL_PATH, "wb") as f:
        pickle.dump(bundle, f)
    print(f"\n  ✓ Model saved → {MODEL_PATH}")

    metrics = {
        "mae":          round(float(mae), 5),
        "r2":           round(float(r2), 5),
        "n_train":      len(X_train),
        "n_val":        len(X_val),
        "features":     FEATURES,
        "label_method": "NRCS SCS CN + Tehrany (2015) FR consensus weights",
        "references": [
            "SCS (1986) TR-55 NRCS Curve Number Method",
            "Tehrany et al. (2015) Catena 125 FR meta-analysis",
            "Beven & Kirkby (1979) TWI = ln(a/tan β)",
        ],
    }
    with open(METRICS_PATH, "w") as f:
        json.dump(metrics, f, indent=2)
    print(f"  ✓ Metrics → {METRICS_PATH}")

    if args.plot:
        try:
            import matplotlib.pyplot as plt
            import numpy as np
            fig, axes = plt.subplots(1, 3, figsize=(15, 4))
            fig.suptitle("ECO-3D Flood Risk XGBoost Training", fontsize=13)

            axes[0].scatter(y_val, preds, alpha=0.3, s=8, color="#00e5ff")
            axes[0].plot([0, 1], [0, 1], "r--")
            axes[0].set_xlabel("True Flood Probability")
            axes[0].set_ylabel("Predicted")
            axes[0].set_title(f"Predicted vs True  R²={r2:.3f}")

            residuals = preds - y_val
            axes[1].hist(residuals, bins=40, color="#00e5ff", alpha=0.8)
            axes[1].axvline(0, color="red", linestyle="--")
            axes[1].set_title(f"Residuals  MAE={mae:.4f}")
            axes[1].set_xlabel("Error")

            feat_names = FEATURES
            feat_imps  = list(model.feature_importances_)
            sorted_idx = sorted(range(len(feat_imps)), key=lambda i: feat_imps[i])
            axes[2].barh(
                [feat_names[i] for i in sorted_idx],
                [feat_imps[i]  for i in sorted_idx],
                color="#00e5ff", alpha=0.8,
            )
            axes[2].set_title("Feature Importances")

            plt.tight_layout()
            plot_path = WEIGHTS_DIR / "flood_training_plot.png"
            plt.savefig(plot_path, dpi=150)
            print(f"  ✓ Plot → {plot_path}")
        except Exception as e:
            print(f"  (Plot skipped: {e})")

    print("\n✅  Flood model training complete!\n")


def main():
    p = argparse.ArgumentParser(description="Train ECO-3D XGBoost flood risk model")
    p.add_argument("--samples",    type=int,   default=5000)
    p.add_argument("--estimators", type=int,   default=300)
    p.add_argument("--max-depth",  type=int,   default=6)
    p.add_argument("--lr",         type=float, default=0.05)
    p.add_argument("--verbose",    action="store_true")
    p.add_argument("--plot",       action="store_true")
    train(p.parse_args())


if __name__ == "__main__":
    main()
