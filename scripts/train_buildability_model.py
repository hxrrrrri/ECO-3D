"""
train_buildability_model.py
────────────────────────────
Trains the MLP buildability-score regression model (Layer 4) using PyTorch.

Prerequisites:
    pip install torch scikit-learn numpy pandas matplotlib

Run from project root:
    python scripts/train_buildability_model.py

    # optional flags
    python scripts/train_buildability_model.py --samples 5000 --epochs 300 --plot

Output:
    backend/ai/buildability/weights/buildability_mlp.pkl   (PyTorch state dict)
    data/buildability_training.csv   (if not yet generated)
"""

import sys
import argparse
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
        print("  Generating synthetic training data first...")
        from generate_synthetic_data import generate_build_dataset
        generate_build_dataset(n_samples)

    import pandas as pd
    df = pd.read_csv(csv_path)
    print(f"  Loaded {len(df)} samples from {csv_path}")
    return df


def build_mlp(hidden_sizes, dropout, input_size=6):
    """Build a configurable MLP using PyTorch."""
    import torch.nn as nn
    layers = []
    in_size = input_size
    for h in hidden_sizes:
        layers += [nn.Linear(in_size, h), nn.ReLU(), nn.Dropout(dropout)]
        in_size = h
    layers.append(nn.Linear(in_size, 1))
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
        print(f"\n❌  Missing dependency: {e}")
        print("   Run:  pip install torch scikit-learn numpy pandas\n")
        sys.exit(1)

    print("\n══ Buildability Score Model Training (PyTorch MLP) ══\n")
    WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)

    # ── Device ────────────────────────────────────────────────────────────────
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"  Device: {device}")

    # ── Data ────────────────────────────────────────────────────────────────
    df = load_or_generate_data(args.samples)

    FEATURES = ["flood_probability", "slope_norm", "soil_stability",
                "vegetation_density", "wind_exposure", "sun_score"]
    LABEL    = "buildability_score"

    X = df[FEATURES].values.astype("float32")
    y = df[LABEL].values.astype("float32") / 100.0   # scale to [0,1] for training

    # Standardise features
    scaler = StandardScaler()
    X = scaler.fit_transform(X).astype("float32")

    X_train, X_val, y_train, y_val = train_test_split(
        X, y, test_size=0.20, random_state=42
    )
    print(f"  Train: {len(X_train)}  Val: {len(X_val)}")

    hidden = [int(h) for h in args.hidden.split(",")]
    print(f"  Architecture: 6 → {' → '.join(map(str, hidden))} → 1")

    model = build_mlp(hidden, args.dropout).to(device)
    total_params = sum(p.numel() for p in model.parameters())
    print(f"  Parameters: {total_params:,}")

    # ── DataLoaders ───────────────────────────────────────────────────────────
    X_t  = torch.tensor(X_train).to(device)
    y_t  = torch.tensor(y_train).unsqueeze(1).to(device)
    Xv_t = torch.tensor(X_val).to(device)
    yv_t = torch.tensor(y_val).unsqueeze(1).to(device)

    ds = TensorDataset(X_t, y_t)
    dl = DataLoader(ds, batch_size=args.batch_size, shuffle=True)

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)
    criterion = nn.MSELoss()

    # ── Training loop ─────────────────────────────────────────────────────────
    print(f"\n  Training for {args.epochs} epochs...\n")
    best_val_loss  = float("inf")
    best_state     = None
    train_losses   = []
    val_losses     = []

    for epoch in range(1, args.epochs + 1):
        model.train()
        batch_losses = []
        for xb, yb in dl:
            optimizer.zero_grad()
            pred = model(xb)
            loss = criterion(pred, yb)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            batch_losses.append(loss.item())
        scheduler.step()

        train_loss = sum(batch_losses) / len(batch_losses)

        model.eval()
        with torch.no_grad():
            val_pred = model(Xv_t)
            val_loss = criterion(val_pred, yv_t).item()

        train_losses.append(train_loss)
        val_losses.append(val_loss)

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}

        if epoch % args.log_every == 0 or epoch == args.epochs:
            print(f"  Epoch {epoch:4d}/{args.epochs}  "
                  f"train_loss={train_loss:.5f}  val_loss={val_loss:.5f}  "
                  f"lr={scheduler.get_last_lr()[0]:.6f}")

    # ── Restore best ─────────────────────────────────────────────────────────
    model.load_state_dict(best_state)
    model.eval()

    # ── Evaluation ────────────────────────────────────────────────────────────
    with torch.no_grad():
        preds_norm = model(Xv_t).cpu().numpy().flatten()
    preds  = np.clip(preds_norm * 100, 0, 100)
    y_true = y_val * 100

    mae  = mean_absolute_error(y_true, preds)
    r2   = r2_score(y_true, preds)

    print(f"\n  ── Validation Metrics ──")
    print(f"  MAE : {mae:.3f} points  (target < 3)")
    print(f"  R²  : {r2:.4f}  (target > 0.92)")

    # ── Save ─────────────────────────────────────────────────────────────────
    import pickle
    save_obj = {
        "state_dict":   best_state,
        "scaler_mean":  scaler.mean_.tolist(),
        "scaler_scale": scaler.scale_.tolist(),
        "hidden_sizes": hidden,
        "dropout":      args.dropout,
        "features":     FEATURES,
    }
    with open(MODEL_PATH, "wb") as f:
        pickle.dump(save_obj, f)
    print(f"\n  ✓ Model saved → {MODEL_PATH}")

    metrics = {
        "mae": round(float(mae), 4),
        "r2":  round(float(r2), 4),
        "best_val_loss": round(best_val_loss, 6),
        "epochs_trained": args.epochs,
    }
    with open(METRICS_PATH, "w") as f:
        json.dump(metrics, f, indent=2)
    print(f"  ✓ Metrics saved → {METRICS_PATH}")

    # ── Optional plot ─────────────────────────────────────────────────────────
    if args.plot:
        try:
            import matplotlib.pyplot as plt
            fig, axes = plt.subplots(1, 3, figsize=(15, 4))
            fig.suptitle("ECO-3D Buildability MLP Training", fontsize=13)

            axes[0].plot(train_losses, label="train", color="#0df2f2", linewidth=1)
            axes[0].plot(val_losses,   label="val",   color="#f59e0b", linewidth=1)
            axes[0].set_title("Loss Curve (MSE)")
            axes[0].set_xlabel("Epoch")
            axes[0].legend()

            axes[1].scatter(y_true, preds, alpha=0.4, s=10, color="#0df2f2")
            axes[1].plot([0, 100], [0, 100], "r--")
            axes[1].set_xlabel("True Score")
            axes[1].set_ylabel("Predicted")
            axes[1].set_title(f"Predicted vs True  R²={r2:.3f}")

            residuals = preds - y_true
            axes[2].hist(residuals, bins=40, color="#0df2f2", alpha=0.8)
            axes[2].axvline(0, color="red", linestyle="--")
            axes[2].set_title(f"Residuals  MAE={mae:.2f}")
            axes[2].set_xlabel("Error (points)")

            plt.tight_layout()
            plot_path = WEIGHTS_DIR / "buildability_training_plot.png"
            plt.savefig(plot_path, dpi=150)
            print(f"  ✓ Plot saved → {plot_path}")
            plt.show()
        except Exception as e:
            print(f"  (Plot skipped: {e})")

    print("\n✅  Buildability model training complete!\n")


def main():
    parser = argparse.ArgumentParser(description="Train ECO-3D PyTorch MLP buildability model")
    parser.add_argument("--samples",    type=int,   default=3000,        help="Training samples")
    parser.add_argument("--epochs",     type=int,   default=250,         help="Training epochs")
    parser.add_argument("--batch-size", type=int,   default=64,          help="Batch size")
    parser.add_argument("--lr",         type=float, default=1e-3,        help="Learning rate")
    parser.add_argument("--hidden",     type=str,   default="64,128,64", help="Hidden layer sizes (comma-separated)")
    parser.add_argument("--dropout",    type=float, default=0.1,         help="Dropout rate")
    parser.add_argument("--log-every",  type=int,   default=50,          help="Log every N epochs")
    parser.add_argument("--plot",       action="store_true",             help="Show training plots")
    train(parser.parse_args())


if __name__ == "__main__":
    main()
