"""
train_flood_model.py
─────────────────────
Trains the XGBoost flood-risk regression model (Layer 3).

Prerequisites:
    pip install xgboost scikit-learn numpy pandas matplotlib

Run from the project root:
    python scripts/train_flood_model.py

    # optional flags
    python scripts/train_flood_model.py --samples 5000 --estimators 300

Output:
    backend/ai/flood/weights/flood_xgboost.pkl
    data/flood_training.csv   (if not already generated)
"""

import sys
import argparse
import pickle
import json
from pathlib import Path

# ── Resolve paths ──────────────────────────────────────────────────────────
SCRIPTS_DIR = Path(__file__).resolve().parent
ROOT        = SCRIPTS_DIR.parent
WEIGHTS_DIR = ROOT / "backend" / "ai" / "flood" / "weights"
DATA_DIR    = ROOT / "data"
MODEL_PATH  = WEIGHTS_DIR / "flood_xgboost.pkl"
METRICS_PATH = WEIGHTS_DIR / "flood_metrics.json"

# Add backend to path so we can import the data generator
sys.path.insert(0, str(SCRIPTS_DIR))


def load_or_generate_data(n_samples: int):
    """Load existing CSV or generate fresh synthetic data."""
    csv_path = DATA_DIR / "flood_training.csv"

    if not csv_path.exists():
        print("  Generating synthetic training data first...")
        from generate_synthetic_data import generate_flood_dataset
        generate_flood_dataset(n_samples)

    import pandas as pd
    df = pd.read_csv(csv_path)
    print(f"  Loaded {len(df)} samples from {csv_path}")
    return df


def train(args):
    try:
        import numpy as np
        import xgboost as xgb
        from sklearn.model_selection import train_test_split
        from sklearn.metrics import mean_absolute_error, r2_score
    except ImportError as e:
        print(f"\n❌  Missing dependency: {e}")
        print("   Run:  pip install xgboost scikit-learn numpy pandas\n")
        sys.exit(1)

    print("\n══ Flood Risk Model Training (XGBoost) ══\n")
    WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)

    # ── Data ────────────────────────────────────────────────────────────────
    df = load_or_generate_data(args.samples)

    FEATURES = ["elevation_m", "slope_deg", "ndvi",
                "rainfall_mm", "soil_stability", "distance_to_water_m"]
    LABEL    = "flood_probability"

    X = df[FEATURES].values.astype("float32")
    y = df[LABEL].values.astype("float32")

    X_train, X_val, y_train, y_val = train_test_split(
        X, y, test_size=0.20, random_state=42
    )
    print(f"  Train: {len(X_train)}  Val: {len(X_val)}")

    # ── Model ────────────────────────────────────────────────────────────────
    model = xgb.XGBRegressor(
        n_estimators          = args.estimators,
        max_depth             = args.max_depth,
        learning_rate         = args.lr,
        subsample             = 0.85,
        colsample_bytree      = 0.85,
        min_child_weight      = 3,
        gamma                 = 0.1,
        objective             = "reg:squarederror",
        tree_method           = "hist",
        random_state          = 42,
        n_jobs                = -1,
        early_stopping_rounds = 30,   # XGBoost >=2.0: must be in constructor
    )

    print(f"\n  Training XGBoost  (estimators={args.estimators}, depth={args.max_depth}, lr={args.lr}) ...")
    model.fit(
        X_train, y_train,
        eval_set = [(X_val, y_val)],
        verbose  = args.verbose,
    )

    # ── Evaluation ───────────────────────────────────────────────────────────
    preds = model.predict(X_val)
    preds = np.clip(preds, 0, 1)

    mae  = mean_absolute_error(y_val, preds)
    r2   = r2_score(y_val, preds)

    print(f"\n  ── Validation Metrics ──")
    print(f"  MAE : {mae:.4f}  (lower is better; target < 0.05)")
    print(f"  R²  : {r2:.4f}  (higher is better; target > 0.90)")

    # Feature importance
    importances = dict(zip(FEATURES, model.feature_importances_))
    print("\n  Feature Importances:")
    for feat, imp in sorted(importances.items(), key=lambda x: -x[1]):
        bar = "█" * int(imp * 40)
        print(f"    {feat:<25} {bar}  {imp:.3f}")

    # ── Save ─────────────────────────────────────────────────────────────────
    with open(MODEL_PATH, "wb") as f:
        pickle.dump(model, f)
    print(f"\n  ✓ Model saved → {MODEL_PATH}")

    metrics = {
        "mae": round(mae, 5),
        "r2":  round(r2, 5),
        "n_estimators_used": model.best_iteration if hasattr(model, "best_iteration") else args.estimators,
        "feature_importances": {k: round(float(v), 4) for k, v in importances.items()},
    }
    with open(METRICS_PATH, "w") as f:
        json.dump(metrics, f, indent=2)
    print(f"  ✓ Metrics saved → {METRICS_PATH}")

    # ── Optional plot ─────────────────────────────────────────────────────────
    if args.plot:
        try:
            import matplotlib.pyplot as plt
            fig, axes = plt.subplots(1, 2, figsize=(12, 4))
            axes[0].scatter(y_val, preds, alpha=0.4, s=10, color="#0df2f2")
            axes[0].plot([0, 1], [0, 1], "r--")
            axes[0].set_xlabel("True Flood Probability")
            axes[0].set_ylabel("Predicted")
            axes[0].set_title(f"Flood Model  R²={r2:.3f}")

            feat_sorted = sorted(importances.items(), key=lambda x: x[1])
            axes[1].barh([f[0] for f in feat_sorted], [f[1] for f in feat_sorted], color="#0df2f2")
            axes[1].set_title("Feature Importances")

            plt.tight_layout()
            plot_path = WEIGHTS_DIR / "flood_training_plot.png"
            plt.savefig(plot_path, dpi=150)
            print(f"  ✓ Plot saved → {plot_path}")
            plt.show()
        except Exception as e:
            print(f"  (Plot skipped: {e})")

    print("\n✅  Flood model training complete!\n")


def main():
    parser = argparse.ArgumentParser(description="Train ECO-3D XGBoost flood model")
    parser.add_argument("--samples",    type=int,   default=2000,  help="Training samples to generate")
    parser.add_argument("--estimators", type=int,   default=300,   help="Number of XGBoost trees")
    parser.add_argument("--max-depth",  type=int,   default=6,     help="Max tree depth")
    parser.add_argument("--lr",         type=float, default=0.05,  help="Learning rate")
    parser.add_argument("--plot",       action="store_true",       help="Show training plots")
    parser.add_argument("--verbose",    type=int,   default=50,    help="XGBoost verbosity interval")
    train(parser.parse_args())


if __name__ == "__main__":
    main()
