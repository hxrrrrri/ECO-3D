#!/usr/bin/env python3
"""
ECO-3D: Download VHRTrees YOLOv8 Satellite Tree Detection Weights
===================================================================

This script downloads the VHRTrees-trained YOLOv8m weights for accurate
satellite tree detection. These weights replace the generic COCO-trained
yolov8n.pt that has no tree-detection capability on satellite imagery.

Dataset & Paper:
    Topgül, Ş. N., Sertel, E., Aksoy, S., Ünsalan, C., & Fransson, J. E. S. (2024).
    VHRTrees: A New Benchmark Dataset for Tree Detection in Satellite Imagery
    and Performance Evaluation with YOLO-based Models.
    Frontiers in Forests and Global Change, 7.
    DOI: https://doi.org/10.3389/ffgc.2024.1495544

Repository:
    https://github.com/RSandAI/VHRTrees

Best Model Performance (YOLOv8m, 960×960, Auto optimizer, 50 epochs):
    mAP@0.50  = 0.934
    F1-score  = 0.932
    Precision = 0.931
    Recall    = 0.933

Training data: 1,496 VHR Google Earth patches, ~26,000 annotated trees,
covering Bursa and İzmir, Turkey (70% train / 15% val / 15% test).

Usage:
    python scripts/download_vhrtrees_weights.py

    # Or run from project root:
    python -m scripts.download_vhrtrees_weights
"""

import sys
import urllib.request
import hashlib
from pathlib import Path

# ── Paths ─────────────────────────────────────────────────────────────────────
ROOT        = Path(__file__).resolve().parent.parent
WEIGHTS_DIR = ROOT / "backend" / "ai" / "detection" / "weights"
TARGET      = WEIGHTS_DIR / "yolov8m_vhrtrees.pt"

# ── Download sources (in order of preference) ─────────────────────────────────
# The VHRTrees GitHub repository (RSandAI/VHRTrees) hosts weights in releases.
# If the primary URL fails, try the alternatives below.
DOWNLOAD_SOURCES = [
    # Primary: official GitHub release
    "https://github.com/RSandAI/VHRTrees/releases/download/v1.0/yolov8m_vhrtrees_best.pt",
    # Secondary: direct repo raw (in case weights are committed, not released)
    "https://raw.githubusercontent.com/RSandAI/VHRTrees/main/weights/yolov8m_best.pt",
]

# ── Manual download instructions ─────────────────────────────────────────────
MANUAL_INSTRUCTIONS = """
╔══════════════════════════════════════════════════════════════════════════╗
║  MANUAL WEIGHT DOWNLOAD — VHRTrees YOLOv8m                              ║
╠══════════════════════════════════════════════════════════════════════════╣
║  Automated download failed. Please download manually:                   ║
║                                                                          ║
║  1. Visit the GitHub repository:                                         ║
║     https://github.com/RSandAI/VHRTrees                                 ║
║                                                                          ║
║  2. Navigate to "Releases" (right sidebar) or the weights directory.    ║
║                                                                          ║
║  3. Download the YOLOv8m best-performing model file.                    ║
║     Filename: yolov8m_vhrtrees_best.pt (or similar)                     ║
║                                                                          ║
║  4. Place it at:                                                         ║
║     backend/ai/detection/weights/yolov8m_vhrtrees.pt                   ║
║                                                                          ║
║  Alternative — contact the paper authors:                               ║
║     topgul@itu.edu.tr (Şükran Nur Topgül)                               ║
║     sertel@itu.edu.tr (Elif Sertel)                                      ║
║                                                                          ║
║  Alternative — use Kaggle dataset:                                      ║
║     kaggle datasets download -d mcagriaksoy/trees-in-satellite-imagery  ║
║     (then train your own YOLOv8n on this data)                          ║
╚══════════════════════════════════════════════════════════════════════════╝
"""


def download_with_progress(url: str, dest: Path) -> bool:
    """Download a file with a simple progress indicator."""
    try:
        print(f"  Trying: {url}")
        print(f"  Destination: {dest}")

        def _progress(block_num, block_size, total_size):
            if total_size > 0:
                pct = min(100, block_num * block_size * 100 // total_size)
                bar = "█" * (pct // 5) + "░" * (20 - pct // 5)
                print(f"\r  [{bar}] {pct}%", end="", flush=True)

        urllib.request.urlretrieve(url, dest, _progress)
        print()  # newline after progress bar

        size_mb = dest.stat().st_size / (1024 * 1024)
        if size_mb < 1.0:
            # File too small — likely a 404 HTML page, not a real .pt file
            print(f"  ✗ Downloaded file is too small ({size_mb:.2f} MB) — likely a 404 error.")
            dest.unlink()
            return False

        print(f"  ✓ Downloaded successfully ({size_mb:.1f} MB)")
        return True

    except Exception as e:
        print(f"  ✗ Failed: {e}")
        if dest.exists():
            dest.unlink()
        return False


def main():
    print("=" * 70)
    print("  ECO-3D: VHRTrees YOLOv8m Weight Downloader")
    print("=" * 70)
    print()

    # Already downloaded?
    if TARGET.exists():
        size_mb = TARGET.stat().st_size / (1024 * 1024)
        print(f"✓ Weights already present: {TARGET}")
        print(f"  Size: {size_mb:.1f} MB")
        print()
        print("To re-download, delete the file and run this script again.")
        return 0

    # Create weights directory
    WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Weights directory: {WEIGHTS_DIR}")
    print()

    # Try each download source
    print("Downloading VHRTrees YOLOv8m weights...")
    print()
    for url in DOWNLOAD_SOURCES:
        if download_with_progress(url, TARGET):
            print()
            print("=" * 70)
            print("✓ VHRTrees weights installed successfully!")
            print(f"  Location: {TARGET}")
            print()
            print("Model specs:")
            print("  Architecture:  YOLOv8m (medium — 25.9M parameters)")
            print("  Input size:    960×960 (trained), 640×640 (inference default)")
            print("  mAP@0.50:      0.934")
            print("  F1-score:      0.932")
            print("  Training data: 26,000 trees, VHR Google Earth satellite imagery")
            print("  Classes:       1 (tree)")
            print()
            print("Restart the ECO-3D backend to use the new weights.")
            print("=" * 70)
            return 0

    # All sources failed
    print()
    print(MANUAL_INSTRUCTIONS)
    return 1


if __name__ == "__main__":
    sys.exit(main())
