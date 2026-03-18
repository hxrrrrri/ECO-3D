"""
train_buildability_model.py  — ECO-3D v3.0
============================================
Trains the MLP buildability-score regression model (Layer 4).

Labels now come from LEED BD+C v4 + NBC 2016 + ASHRAE 55-2020,
replacing the previous ad-hoc weighted formula.

Prerequisites:
    pip install torch scikit-learn numpy pandas matplotlib

Run from project root:
    python scripts/train_buildability_model.py
    python scripts/train_buildability_model.py --samples 8000 --epochs 300 --plot

Output:
    backend/ai/buildability/weights/buildability_mlp.pkl
    backend/ai/buildability/weights/buildability_metrics.json
"""

import sys
import argparse
import pickle
import json
from pathlib import Path

SCRIPTS_DIR  = Path(__file__).resolve().parent
ROOT         = SCRIPTS_DIR.parent
WEIGHTS_DIR  = ROOT / "backend" / "ai" / "buildability" / "weights"
DATA_DIR     = ROOT / "data"
MODEL_PATH   = WEIGHTS_DIR / "buildability_mlp.pkl"
METRICS_PATH = WEIGHTS_DIR / "buildability_metrics.json"

sys.path.insert(0, str(SCRIPTS_DIR))


def load_or_generate_data(n_samples: int):
    csv_path = DATA_DIR / "buildability_training.csv"
    if not csv_path.exists():
        print("  No CSV found — generating training data first...")
        from generate_synthetic_data import generate_build_dataset
        generate_build_dataset(n_samples)
    import pandas as pd
    df = pd.read_csv(csv_path)
    print(f"  Loaded {len(df)} samples from {csv_path}")
    print(f"  Columns: {list(df.columns)}")
    return df


def build_mlp(hidden_sizes, dropout, input_size=6):
    import torch.nn as nn
    layers = []
    in_sz = input_size
    for h in hidden_sizes:
        layers += [nn.Linear(in_sz, h), nn.ReLU(), nn.Dropout(dropout)]
        in_sz = h
    layers.append(nn.Linear(in_sz, 1))
    return nn.Sequential(*layers)


def train(args):
    try:
        import numpy as np
        import torch
        import torch.nn as nn
        from torch.utils.data import TensorDataset, DataLoader
        from sklearn.model_selection import train_test_split
        from sklearn.preprocessing import StandardScaler
        from sklearn.metrics import mean_absolute_error, r2_score
    except ImportError as e:
        print(f"\n❌  Missing: {e}\n   pip install torch scikit-learn numpy pandas\n")
        sys.exit(1)

    print("\n══ Buildability Score Model Training (PyTorch MLP) ══\n")
    WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"  Device: {device}")

    df = load_or_generate_data(args.samples)

    # ── Feature columns — must match generate_synthetic_data.py output ──────
    # CSV columns: flood_probability, slope_norm, soil_stability,
    #              vegetation_density, wind_exposure, sun_score,
    #              buildability_score
    FEATURES = [
        "flood_probability",
        "slope_norm",          # slope_deg / 45, normalised [0,1]
        "soil_stability",      # 1 - clay_fraction
        "vegetation_density",  # NDVI
        "wind_exposure",       # wind_ms / 15, normalised [0,1]
        "sun_score",           # sun_hours / 14, normalised [0,1]
    ]
    LABEL = "buildability_score"

    # Validate columns
    missing = [c for c in FEATURES + [LABEL] if c not in df.columns]
    if missing:
        print(f"\n❌  Missing columns in CSV: {missing}")
        print(f"   Available: {list(df.columns)}")
        print("   Delete data/buildability_training.csv and re-run generate_synthetic_data.py")
        sys.exit(1)

    X = df[FEATURES].values.astype("float32")
    y = df[LABEL].values.astype("float32")
    y_norm = y / 100.0  # scale to [0,1] for training

    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X).astype("float32")

    X_train, X_val, y_train, y_val = train_test_split(
        X_scaled, y_norm, test_size=0.20, random_state=42
    )
    print(f"  Train: {len(X_train)}  Val: {len(X_val)}")

    hidden = [int(h) for h in args.hidden.split(",")]
    print(f"  Architecture: 6 → {' → '.join(map(str, hidden))} → 1  (dropout={args.dropout})")

    model = build_mlp(hidden, args.dropout, input_size=len(FEATURES)).to(device)
    total_params = sum(p.numel() for p in model.parameters())
    print(f"  Parameters: {total_params:,}")

    # ── DataLoaders ───────────────────────────────────────────────────────────
    X_t  = torch.tensor(X_train).to(device)
    y_t  = torch.tensor(y_train).unsqueeze(1).to(device)
    Xv_t = torch.tensor(X_val).to(device)
    yv_t = torch.tensor(y_val).unsqueeze(1).to(device)

    dl = DataLoader(TensorDataset(X_t, y_t), batch_size=args.batch_size, shuffle=True)

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)
    criterion = nn.MSELoss()

    # ── Training loop ─────────────────────────────────────────────────────────
    print(f"\n  Training {args.epochs} epochs...\n")
    best_val_loss = float("inf")
    best_state    = None
    train_losses  = []
    val_losses    = []

    for epoch in range(1, args.epochs + 1):
        model.train()
        batch_losses = []
        for xb, yb in dl:
            optimizer.zero_grad()
            loss = criterion(model(xb), yb)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            batch_losses.append(loss.item())
        scheduler.step()

        tr_loss = sum(batch_losses) / len(batch_losses)
        model.eval()
        with torch.no_grad():
            val_loss = criterion(model(Xv_t), yv_t).item()

        train_losses.append(tr_loss)
        val_losses.append(val_loss)

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}

        if epoch % args.log_every == 0 or epoch == args.epochs:
            print(f"  Epoch {epoch:4d}/{args.epochs}  "
                  f"train={tr_loss:.5f}  val={val_loss:.5f}  "
                  f"lr={scheduler.get_last_lr()[0]:.6f}")

    # ── Restore best weights ──────────────────────────────────────────────────
    model.load_state_dict(best_state)
    model.eval()

    # ── Evaluation ────────────────────────────────────────────────────────────
    import numpy as np
    with torch.no_grad():
        preds_norm = model(Xv_t).cpu().numpy().flatten()
    preds  = np.clip(preds_norm * 100, 0, 100)
    y_true = y_val * 100

    mae = mean_absolute_error(y_true, preds)
    r2  = r2_score(y_true, preds)

    print(f"\n  ── Validation Metrics ──")
    print(f"  MAE: {mae:.3f} points   (target < 3)")
    print(f"  R²:  {r2:.4f}            (target > 0.92)")

    # ── Save ─────────────────────────────────────────────────────────────────
    bundle = {
        "state_dict":   best_state,
        "scaler_mean":  scaler.mean_.tolist(),
        "scaler_scale": scaler.scale_.tolist(),
        "hidden_sizes": hidden,
        "dropout":      args.dropout,
        "features":     FEATURES,
        "label_method": "LEED BD+C v4 + NBC 2016 + ASHRAE 55-2020",
    }
    with open(MODEL_PATH, "wb") as f:
        pickle.dump(bundle, f)
    print(f"\n  ✓ Model saved → {MODEL_PATH}")

    metrics = {
        "mae":          round(float(mae), 4),
        "r2":           round(float(r2), 4),
        "best_val_loss": round(best_val_loss, 6),
        "epochs_trained": args.epochs,
        "features":     FEATURES,
        "label_method": "LEED BD+C v4 + NBC 2016 Part 7 + ASHRAE 55-2020",
        "references": [
            "LEED BD+C v4 Sustainable Sites (USGBC 2019)",
            "NBC 2016 Part 7: Foundations and Site Works (BIS 2016)",
            "ASHRAE Standard 55-2020: Thermal Environmental Conditions",
            "FEMA Risk Rating 2.0 — elevation zone penalties",
        ],
    }
    with open(METRICS_PATH, "w") as f:
        json.dump(metrics, f, indent=2)
    print(f"  ✓ Metrics → {METRICS_PATH}")

    # ── Optional plot ─────────────────────────────────────────────────────────
    if args.plot:
        try:
            import matplotlib.pyplot as plt
            fig, axes = plt.subplots(1, 3, figsize=(15, 4))
            fig.suptitle("ECO-3D Buildability MLP Training", fontsize=13)

            axes[0].plot(train_losses, label="train", color="#00e5ff", linewidth=1)
            axes[0].plot(val_losses,   label="val",   color="#f59e0b", linewidth=1)
            axes[0].set_title("Loss Curve (MSE)")
            axes[0].set_xlabel("Epoch")
            axes[0].legend()

            axes[1].scatter(y_true, preds, alpha=0.4, s=10, color="#00e5ff")
            axes[1].plot([0, 100], [0, 100], "r--")
            axes[1].set_xlabel("True Score")
            axes[1].set_ylabel("Predicted")
            axes[1].set_title(f"Predicted vs True  R²={r2:.3f}")

            residuals = preds - y_true
            axes[2].hist(residuals, bins=40, color="#00e5ff", alpha=0.8)
            axes[2].axvline(0, color="red", linestyle="--")
            axes[2].set_title(f"Residuals  MAE={mae:.2f}")
            axes[2].set_xlabel("Error (points)")

            plt.tight_layout()
            plot_path = WEIGHTS_DIR / "buildability_training_plot.png"
            plt.savefig(plot_path, dpi=150)
            print(f"  ✓ Plot → {plot_path}")
        except Exception as e:
            print(f"  (Plot skipped: {e})")

    print("\n✅  Buildability model training complete!\n")


def main():
    p = argparse.ArgumentParser(description="Train ECO-3D PyTorch MLP buildability model")
    p.add_argument("--samples",    type=int,   default=5000)
    p.add_argument("--epochs",     type=int,   default=250)
    p.add_argument("--batch-size", type=int,   default=64)
    p.add_argument("--lr",         type=float, default=1e-3)
    p.add_argument("--hidden",     type=str,   default="64,128,64")
    p.add_argument("--dropout",    type=float, default=0.1)
    p.add_argument("--log-every",  type=int,   default=50)
    p.add_argument("--plot",       action="store_true")
    train(p.parse_args())


if __name__ == "__main__":
    main()
