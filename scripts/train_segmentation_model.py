"""
train_segmentation_model.py
────────────────────────────
Fine-tunes DeepLabV3-ResNet50 for 6-class land segmentation (Layer 1).

The model is pre-trained on ImageNet/COCO; we replace the classifier head
and fine-tune on our land-use classes using synthetic tiles (or real tiles
from the data/ directory if available).

Classes: vegetation | bare_land | water | urban | agriculture | forest

Prerequisites:
    pip install torch torchvision numpy pillow scikit-learn matplotlib

Run from project root:
    python scripts/train_segmentation_model.py

    # with more tiles / epochs
    python scripts/train_segmentation_model.py --tiles 500 --epochs 20 --plot

Output:
    backend/ai/segmentation/weights/deeplabv3_eco3d.pth
"""

import sys
import argparse
import json
import random
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
ROOT        = SCRIPTS_DIR.parent
WEIGHTS_DIR = ROOT / "backend" / "ai" / "segmentation" / "weights"
MODEL_PATH  = WEIGHTS_DIR / "deeplabv3_eco3d.pth"
METRICS_PATH = WEIGHTS_DIR / "segmentation_metrics.json"

CLASSES = ["vegetation", "bare_land", "water", "urban", "agriculture", "forest"]
NUM_CLASSES = len(CLASSES)


def generate_synthetic_tile(img_size=256):
    """
    Create a synthetic RGB satellite tile + pixel-wise label mask.
    Returns (image_tensor, label_tensor) ready for training.
    """
    import numpy as np
    import torch

    img  = np.zeros((img_size, img_size, 3), dtype=np.uint8)
    mask = np.zeros((img_size, img_size), dtype=np.int64)

    # Paint random land-use patches
    for _ in range(random.randint(3, 8)):
        cls  = random.randint(0, NUM_CLASSES - 1)
        x1   = random.randint(0, img_size - 40)
        y1   = random.randint(0, img_size - 40)
        w    = random.randint(30, img_size // 2)
        h    = random.randint(30, img_size // 2)
        x2   = min(x1 + w, img_size)
        y2   = min(y1 + h, img_size)

        # Approximate spectral signature per class
        colors = {
            0: (34, 139, 34),    # vegetation → green
            1: (194, 178, 128),  # bare_land  → tan
            2: (30,  100, 200),  # water      → blue
            3: (128, 128, 128),  # urban      → grey
            4: (210, 180, 100),  # agriculture → yellow-green
            5: (0,   80,   0),   # forest     → dark green
        }
        r, g, b = colors[cls]
        img[y1:y2, x1:x2, 0] = r + random.randint(-15, 15)
        img[y1:y2, x1:x2, 1] = g + random.randint(-15, 15)
        img[y1:y2, x1:x2, 2] = b + random.randint(-15, 15)
        mask[y1:y2, x1:x2] = cls

    img = np.clip(img, 0, 255).astype(np.uint8)

    # ToTensor + Normalize (ImageNet stats)
    img_t = torch.tensor(img, dtype=torch.float32).permute(2, 0, 1) / 255.0
    mean = torch.tensor([0.485, 0.456, 0.406]).view(3, 1, 1)
    std  = torch.tensor([0.229, 0.224, 0.225]).view(3, 1, 1)
    img_t = (img_t - mean) / std

    return img_t, torch.tensor(mask, dtype=torch.long)


def build_model(num_classes, freeze_backbone=True):
    """
    Load pretrained DeepLabV3-ResNet50 and replace the classifier head
    for our custom number of classes.
    """
    import torch
    import torchvision.models.segmentation as seg

    model = seg.deeplabv3_resnet50(
        weights=seg.DeepLabV3_ResNet50_Weights.DEFAULT
    )

    if freeze_backbone:
        # Freeze all backbone parameters — only train the new head
        for name, param in model.named_parameters():
            if "classifier" not in name and "aux_classifier" not in name:
                param.requires_grad = False

    # Replace final conv layers with our class count
    from torch import nn
    in_channels = model.classifier[4].in_channels
    model.classifier[4] = nn.Conv2d(in_channels, num_classes, kernel_size=1)
    if model.aux_classifier is not None:
        in_channels_aux = model.aux_classifier[4].in_channels
        model.aux_classifier[4] = nn.Conv2d(in_channels_aux, num_classes, kernel_size=1)

    return model


def train(args):
    try:
        import torch
        import torch.nn as nn
        from torch.utils.data import DataLoader, Dataset
        from sklearn.metrics import jaccard_score
        import numpy as np
    except ImportError as e:
        print(f"\n❌  Missing dependency: {e}")
        print("   Run:  pip install torch torchvision numpy pillow scikit-learn\n")
        sys.exit(1)

    print("\n══ Land Segmentation Model Training (DeepLabV3-ResNet50) ══\n")
    WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"  Device  : {device}")
    print(f"  Classes : {CLASSES}")
    print(f"  Tiles   : {args.tiles}  (synthetic)")
    print(f"  Epochs  : {args.epochs}")
    print(f"  Freeze backbone: {not args.full_finetune}\n")

    # ── Dataset ────────────────────────────────────────────────────────────
    class SyntheticTileDataset(Dataset):
        def __init__(self, n):
            self.n = n
        def __len__(self):
            return self.n
        def __getitem__(self, idx):
            random.seed(idx)
            return generate_synthetic_tile(args.img_size)

    n_train = int(args.tiles * 0.85)
    n_val   = args.tiles - n_train
    train_ds = SyntheticTileDataset(n_train)
    val_ds   = SyntheticTileDataset(n_val)

    train_dl = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True,  num_workers=0)
    val_dl   = DataLoader(val_ds,   batch_size=args.batch_size, shuffle=False, num_workers=0)

    print(f"  Train tiles: {n_train}  Val tiles: {n_val}")

    # ── Model ──────────────────────────────────────────────────────────────
    model = build_model(NUM_CLASSES, freeze_backbone=not args.full_finetune).to(device)
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total     = sum(p.numel() for p in model.parameters())
    print(f"  Parameters: {total:,} total  |  {trainable:,} trainable\n")

    optimizer = torch.optim.AdamW(
        filter(lambda p: p.requires_grad, model.parameters()),
        lr=args.lr, weight_decay=1e-4
    )
    scheduler = torch.optim.lr_scheduler.OneCycleLR(
        optimizer, max_lr=args.lr, epochs=args.epochs, steps_per_epoch=len(train_dl)
    )
    criterion = nn.CrossEntropyLoss(ignore_index=255)

    best_miou   = 0.0
    best_state  = None
    train_losses = []
    val_mious    = []

    for epoch in range(1, args.epochs + 1):
        # ── Train ────────────────────────────────────────────────────────
        model.train()
        epoch_losses = []
        for imgs, masks in train_dl:
            imgs, masks = imgs.to(device), masks.to(device)
            optimizer.zero_grad()
            out = model(imgs)
            loss = criterion(out["out"], masks)
            if "aux" in out:
                loss += 0.4 * criterion(out["aux"], masks)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            scheduler.step()
            epoch_losses.append(loss.item())

        avg_train_loss = np.mean(epoch_losses)
        train_losses.append(avg_train_loss)

        # ── Validate ─────────────────────────────────────────────────────
        model.eval()
        all_preds = []
        all_true  = []
        with torch.no_grad():
            for imgs, masks in val_dl:
                imgs = imgs.to(device)
                out  = model(imgs)
                preds = out["out"].argmax(1).cpu().numpy().flatten()
                true  = masks.numpy().flatten()
                all_preds.extend(preds.tolist())
                all_true.extend(true.tolist())

        miou = jaccard_score(all_true, all_preds, average="macro", zero_division=0)
        val_mious.append(miou)

        if miou > best_miou:
            best_miou  = miou
            best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}

        print(f"  Epoch {epoch:3d}/{args.epochs}  "
              f"train_loss={avg_train_loss:.4f}  "
              f"val_mIoU={miou:.4f}  "
              f"{'← best' if miou == best_miou else ''}")

    # ── Save ──────────────────────────────────────────────────────────────
    torch.save(best_state, MODEL_PATH)
    print(f"\n  ✓ Model saved → {MODEL_PATH}")
    print(f"  Best val mIoU: {best_miou:.4f}")

    metrics = {
        "best_val_miou": round(best_miou, 5),
        "epochs_trained": args.epochs,
        "num_classes": NUM_CLASSES,
        "classes": CLASSES,
    }
    with open(METRICS_PATH, "w") as f:
        json.dump(metrics, f, indent=2)
    print(f"  ✓ Metrics saved → {METRICS_PATH}")

    if args.plot:
        try:
            import matplotlib.pyplot as plt
            fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 4))
            ax1.plot(train_losses, color="#0df2f2")
            ax1.set_title("Training Loss (CrossEntropy)")
            ax1.set_xlabel("Epoch")
            ax2.plot(val_mious, color="#f59e0b")
            ax2.axhline(best_miou, color="red", linestyle="--", label=f"Best={best_miou:.3f}")
            ax2.set_title("Validation mIoU")
            ax2.set_xlabel("Epoch")
            ax2.legend()
            plt.tight_layout()
            plot_path = WEIGHTS_DIR / "segmentation_training_plot.png"
            plt.savefig(plot_path, dpi=150)
            print(f"  ✓ Plot saved → {plot_path}")
            plt.show()
        except Exception as e:
            print(f"  (Plot skipped: {e})")

    print("\n✅  Segmentation model training complete!\n")


def main():
    parser = argparse.ArgumentParser(description="Train ECO-3D DeepLabV3 segmentation model")
    parser.add_argument("--tiles",         type=int,   default=200,   help="Number of synthetic training tiles")
    parser.add_argument("--epochs",        type=int,   default=10,    help="Training epochs")
    parser.add_argument("--batch-size",    type=int,   default=4,     help="Batch size")
    parser.add_argument("--lr",            type=float, default=1e-3,  help="Learning rate")
    parser.add_argument("--img-size",      type=int,   default=256,   help="Tile image size")
    parser.add_argument("--full-finetune", action="store_true",       help="Unfreeze backbone (slower, needs more data)")
    parser.add_argument("--plot",          action="store_true",       help="Show training plots")
    train(parser.parse_args())


if __name__ == "__main__":
    main()
