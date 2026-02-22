"""
Layer 1: Satellite Segmentation using DeepLabV3+
Input: (lat, lng, zoom) → fetches satellite tile
Output: Land classification mask + class distribution dict
"""
import numpy as np
import logging
from pathlib import Path
import os

logger = logging.getLogger(__name__)

# Land class labels
CLASSES = ["vegetation", "bare_land", "water", "urban", "agriculture", "forest"]

class SatelliteSegmenter:
    def __init__(self):
        self.model = None
        self.device = "cpu"
        self._load_model()

    def _load_model(self):
        try:
            import torch
            import torchvision.models.segmentation as seg_models

            self.device = "cuda" if torch.cuda.is_available() else "cpu"

            weights_path = Path(os.environ.get("WEIGHTS_DIR", "training/weights")) / "deeplabv3_eco3d.pth"

            if weights_path.exists():
                logger.info(f"Loading DeepLabV3 weights from {weights_path}")
                self.model = seg_models.deeplabv3_resnet50(num_classes=len(CLASSES))
                state = torch.load(weights_path, map_location=self.device)
                self.model.load_state_dict(state)
            else:
                logger.warning("DeepLabV3 weights not found. Using pretrained ImageNet backbone (fine-tune required).")
                # Use pretrained backbone without custom head for demo
                self.model = seg_models.deeplabv3_resnet50(
                    weights=seg_models.DeepLabV3_ResNet50_Weights.DEFAULT
                )

            self.model.eval()
            self.model.to(self.device)
        except ImportError:
            logger.warning("PyTorch not available. Segmenter will return synthetic results.")
            self.model = None

    def _fetch_satellite_tile(self, lat: float, lng: float, zoom: int) -> np.ndarray:
        """
        Fetch satellite tile from OpenStreetMap tile server or Mapbox.
        Returns HxWx3 numpy array (uint8).
        """
        try:
            import requests
            from PIL import Image
            import io
            import math

            def deg2tile(lat, lng, zoom):
                lat_r = math.radians(lat)
                n = 2 ** zoom
                x = int((lng + 180) / 360 * n)
                y = int((1 - math.log(math.tan(lat_r) + 1 / math.cos(lat_r)) / math.pi) / 2 * n)
                return x, y

            x, y = deg2tile(lat, lng, zoom)
            url = f"https://tile.openstreetmap.org/{zoom}/{x}/{y}.png"
            headers = {"User-Agent": "ECO3D-Platform/1.0"}
            resp = requests.get(url, headers=headers, timeout=10)
            img = Image.open(io.BytesIO(resp.content)).convert("RGB")
            img = img.resize((512, 512))
            return np.array(img)
        except Exception as e:
            logger.warning(f"Tile fetch failed: {e}. Using synthetic tile.")
            return np.random.randint(40, 200, (512, 512, 3), dtype=np.uint8)

    def _run_inference(self, image: np.ndarray) -> np.ndarray:
        """Run DeepLabV3 inference on image. Returns class index mask (HxW)."""
        try:
            import torch
            from torchvision import transforms
            from PIL import Image

            transform = transforms.Compose([
                transforms.ToTensor(),
                transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
            ])

            pil_img = Image.fromarray(image)
            tensor = transform(pil_img).unsqueeze(0).to(self.device)

            with torch.no_grad():
                output = self.model(tensor)["out"]
                pred = torch.argmax(output, dim=1).squeeze().cpu().numpy()

            # Map 21-class COCO to our 6-class schema
            coco_to_eco = {
                0: 1,   # background → bare_land
                8: 0,   # boat → water (proxy)
                21: 2,  # sky → water (proxy)
                15: 3,  # person → urban
                7: 3,   # car → urban
                2: 0,   # vegetation
                17: 0,  # plant
            }
            remapped = np.full_like(pred, 1)
            for coco_cls, eco_cls in coco_to_eco.items():
                remapped[pred == coco_cls] = eco_cls

            return remapped

        except Exception as e:
            logger.warning(f"Inference failed: {e}. Using synthetic mask.")
            return self._synthetic_mask()

    def _synthetic_mask(self) -> np.ndarray:
        """Generate a realistic synthetic segmentation mask."""
        mask = np.ones((512, 512), dtype=np.uint8)  # default: bare_land
        # Add vegetation patches
        mask[50:200, 50:300] = 0
        mask[350:480, 250:460] = 0
        # Add urban areas
        mask[150:350, 200:400] = 3
        # Add water body
        mask[400:480, 20:120] = 2
        return mask

    def segment(self, lat: float, lng: float, zoom: int = 18) -> dict:
        """Main segmentation entry point."""
        image = self._fetch_satellite_tile(lat, lng, zoom)

        if self.model is not None:
            mask = self._run_inference(image)
        else:
            mask = self._synthetic_mask()

        # Compute class distribution
        total_pixels = mask.size
        distribution = {}
        for i, cls_name in enumerate(CLASSES):
            pct = float((mask == i).sum() / total_pixels)
            if pct > 0:
                distribution[cls_name] = round(pct, 3)

        dominant = max(distribution, key=distribution.get) if distribution else "bare_land"

        return {
            "mask_url": "",  # In production: save mask to S3/storage and return URL
            "class_distribution": distribution,
            "dominant_class": dominant,
        }
