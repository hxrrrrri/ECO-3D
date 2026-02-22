"""
evaluate_models.py
──────────────────
Quick sanity-check for all trained ECO-3D models.
Loads each model and runs a set of test predictions, printing pass/fail.

Run from project root:
    python scripts/evaluate_models.py
"""

import sys
import json
from pathlib import Path

ROOT        = Path(__file__).resolve().parent.parent
WEIGHTS_DIR = ROOT / "backend" / "ai"
sys.path.insert(0, str(ROOT / "backend"))


def check(label, condition, detail=""):
    icon = "✅" if condition else "❌"
    print(f"  {icon}  {label}" + (f"  ({detail})" if detail else ""))
    return condition


def evaluate_flood_model():
    print("\n── Flood Risk Model (XGBoost) ──")
    pkl = WEIGHTS_DIR / "flood" / "weights" / "flood_xgboost.pkl"

    if not check("Weights file exists", pkl.exists(), str(pkl)):
        return False

    try:
        import pickle, numpy as np
        with open(pkl, "rb") as f:
            model = pickle.load(f)

        # Test 1: low-risk plot (high elevation, steep slope, low rainfall)
        X_low  = np.array([[350, 25, 0.7, 400, 0.3, 2000]], dtype="float32")
        p_low  = float(model.predict(X_low)[0])
        check("Low-risk prediction < 0.25", p_low < 0.25, f"p={p_low:.3f}")

        # Test 2: high-risk plot (low elevation, flat, high rainfall, close to water)
        X_high = np.array([[5, 1, 0.1, 2500, 0.8, 50]], dtype="float32")
        p_high = float(model.predict(X_high)[0])
        check("High-risk prediction > 0.55", p_high > 0.55, f"p={p_high:.3f}")

        check("Prediction order correct (low < high)", p_low < p_high)
        return True
    except Exception as e:
        print(f"  ❌  Exception: {e}")
        return False


def evaluate_buildability_model():
    print("\n── Buildability Model (PyTorch MLP) ──")
    pkl = WEIGHTS_DIR / "buildability" / "weights" / "buildability_mlp.pkl"

    if not check("Weights file exists", pkl.exists(), str(pkl)):
        return False

    try:
        import pickle, numpy as np, torch, torch.nn as nn

        with open(pkl, "rb") as f:
            obj = pickle.load(f)

        hidden  = obj["hidden_sizes"]
        dropout = obj["dropout"]
        mean    = np.array(obj["scaler_mean"])
        scale   = np.array(obj["scaler_scale"])

        # Rebuild architecture
        layers, in_s = [], 6
        for h in hidden:
            layers += [nn.Linear(in_s, h), nn.ReLU(), nn.Dropout(dropout)]
            in_s = h
        layers.append(nn.Linear(in_s, 1))
        model = nn.Sequential(*layers)
        model.load_state_dict(obj["state_dict"])
        model.eval()

        def predict(raw_features):
            x = (np.array(raw_features, dtype="float32") - mean) / scale
            with torch.no_grad():
                return float(model(torch.tensor(x).unsqueeze(0)).item()) * 100

        # Excellent plot
        score_good = predict([0.05, 0.10, 0.70, 0.80, 0.20, 0.85])
        check("Good plot score > 60", score_good > 60, f"score={score_good:.1f}")

        # Terrible plot
        score_bad  = predict([0.90, 0.90, 0.20, 0.10, 0.90, 0.20])
        check("Bad plot score < 40",  score_bad  < 40, f"score={score_bad:.1f}")

        check("Score ordering (bad < good)", score_bad < score_good)
        return True
    except Exception as e:
        print(f"  ❌  Exception: {e}")
        return False


def evaluate_segmentation_model():
    print("\n── Segmentation Model (DeepLabV3) ──")
    pth = WEIGHTS_DIR / "segmentation" / "weights" / "deeplabv3_eco3d.pth"

    if not check("Weights file exists", pth.exists(), str(pth)):
        return False

    try:
        import torch
        import torchvision.models.segmentation as seg

        model = seg.deeplabv3_resnet50(weights=None)
        from torch import nn
        model.classifier[4] = nn.Conv2d(
            model.classifier[4].in_channels, 6, kernel_size=1
        )
        state = torch.load(pth, map_location="cpu")
        model.load_state_dict(state)
        model.eval()

        dummy = torch.randn(1, 3, 256, 256)
        with torch.no_grad():
            out = model(dummy)["out"]

        check("Output shape correct", out.shape == (1, 6, 256, 256), str(out.shape))
        check("Softmax sums to 1",
              abs(torch.softmax(out, 1).sum(1).mean().item() - 1.0) < 1e-4)
        return True
    except Exception as e:
        print(f"  ❌  Exception: {e}")
        return False


def print_metrics():
    print("\n── Saved Training Metrics ──")
    for name, path in [
        ("Flood",         WEIGHTS_DIR / "flood" / "weights" / "flood_metrics.json"),
        ("Buildability",  WEIGHTS_DIR / "buildability" / "weights" / "buildability_metrics.json"),
        ("Segmentation",  WEIGHTS_DIR / "segmentation" / "weights" / "segmentation_metrics.json"),
    ]:
        if path.exists():
            with open(path) as f:
                m = json.load(f)
            print(f"\n  {name}:")
            for k, v in m.items():
                if not isinstance(v, dict):
                    print(f"    {k}: {v}")
        else:
            print(f"\n  {name}: no metrics file yet")


def main():
    print("\n╔══════════════════════════════════════╗")
    print("║   ECO-3D Model Evaluation Suite      ║")
    print("╚══════════════════════════════════════╝")

    results = {
        "flood":         evaluate_flood_model(),
        "buildability":  evaluate_buildability_model(),
        "segmentation":  evaluate_segmentation_model(),
    }

    print_metrics()

    passed = sum(results.values())
    total  = len(results)
    print(f"\n══ Summary: {passed}/{total} models passing ══\n")

    if passed < total:
        print("  To train missing models, run:")
        if not results["flood"]:
            print("    python scripts/train_flood_model.py")
        if not results["buildability"]:
            print("    python scripts/train_buildability_model.py")
        if not results["segmentation"]:
            print("    python scripts/train_segmentation_model.py")
        print()


if __name__ == "__main__":
    main()
