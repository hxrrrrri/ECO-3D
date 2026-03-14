"""
Adaptive vacant-plot boundary extraction.

This replaces the previous centroid-sorted boundary heuristic with:
- adaptive soil color scoring around the clicked seed
- edge-aware region growing
- morphology cleanup
- ordered contour tracing
"""
import asyncio
import io
import logging
import math
from collections import deque
from typing import List, Optional, Tuple

import httpx
import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)

TILE_PX = 256
GRID = 3
COMP_PX = TILE_PX * GRID


def _deg2tile(lat: float, lon: float, zoom: int) -> Tuple[int, int]:
    lat_r = math.radians(lat)
    n = 2 ** zoom
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n)
    return x, y


def _tile_bounds(x: int, y: int, zoom: int) -> Tuple[float, float, float, float]:
    n = 2 ** zoom
    def t2lon(tx: int) -> float:
        return tx / n * 360.0 - 180.0
    def t2lat(ty: int) -> float:
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * ty / n))))
    return t2lon(x), t2lat(y + 1), t2lon(x + 1), t2lat(y)


def _composite_bounds(cx: int, cy: int, zoom: int) -> Tuple[float, float, float, float]:
    off = GRID // 2
    _, lat_s, _, _ = _tile_bounds(cx - off, cy + off, zoom)
    lon_w, _, _, _ = _tile_bounds(cx - off, cy - off, zoom)
    _, _, lon_e, _ = _tile_bounds(cx + off, cy + off, zoom)
    _, _, _, lat_n = _tile_bounds(cx + off, cy - off, zoom)
    return lon_w, lat_s, lon_e, lat_n


def _gps_to_px(lat: float, lon: float, lon_w: float, lat_s: float, lon_e: float, lat_n: float, w: int, h: int) -> Tuple[int, int]:
    px = int((lon - lon_w) / (lon_e - lon_w) * w)
    py = int((lat_n - lat) / (lat_n - lat_s) * h)
    return max(0, min(w - 1, px)), max(0, min(h - 1, py))


def _px_to_gps(points: List[Tuple[int, int]], lon_w: float, lat_s: float, lon_e: float, lat_n: float, w: int, h: int) -> List[List[float]]:
    out = []
    for x, y in points:
        lon = lon_w + (x / w) * (lon_e - lon_w)
        lat = lat_n - (y / h) * (lat_n - lat_s)
        out.append([round(lon, 7), round(lat, 7)])
    return out


async def _fetch_one_tile(x: int, y: int, zoom: int, session: httpx.AsyncClient) -> Optional[np.ndarray]:
    url = f"https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{zoom}/{y}/{x}"
    try:
        r = await session.get(url, headers={"User-Agent": "ECO-3D boundary/5.0"})
        if r.status_code == 200 and len(r.content) > 1000:
            return np.array(Image.open(io.BytesIO(r.content)).convert("RGB"), dtype=np.uint8)
    except Exception as exc:
        logger.warning("Boundary tile fetch failed (%s,%s): %s", x, y, exc)
    return None


async def _fetch_composite(cx: int, cy: int, zoom: int) -> Optional[np.ndarray]:
    comp = np.zeros((COMP_PX, COMP_PX, 3), dtype=np.uint8)
    async with httpx.AsyncClient(timeout=18.0) as session:
        tasks = []
        coords = []
        for gy in range(GRID):
            for gx in range(GRID):
                tx = cx + gx - 1
                ty = cy + gy - 1
                tasks.append(_fetch_one_tile(tx, ty, zoom, session))
                coords.append((gx, gy))
        results = await asyncio.gather(*tasks, return_exceptions=True)

    ok = 0
    for (gx, gy), tile in zip(coords, results):
        if isinstance(tile, np.ndarray):
            comp[gy * TILE_PX:(gy + 1) * TILE_PX, gx * TILE_PX:(gx + 1) * TILE_PX] = tile
            ok += 1
    return comp if ok >= 3 else None


def _rgb_to_hsv(rgb: np.ndarray) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    arr = rgb.astype(np.float32) / 255.0
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    cmax = np.max(arr, axis=2)
    cmin = np.min(arr, axis=2)
    diff = cmax - cmin + 1e-9
    h = np.zeros_like(cmax)
    mr = cmax == r
    mg = cmax == g
    mb = cmax == b
    h[mr] = (60.0 * ((g[mr] - b[mr]) / diff[mr])) % 360.0
    h[mg] = 60.0 * ((b[mg] - r[mg]) / diff[mg]) + 120.0
    h[mb] = 60.0 * ((r[mb] - g[mb]) / diff[mb]) + 240.0
    s = np.where(cmax < 1e-8, 0.0, diff / cmax) * 100.0
    v = cmax * 100.0
    return h, s, v


def _grayscale(img: np.ndarray) -> np.ndarray:
    return (img[:, :, 0].astype(np.float32) * 0.299 + img[:, :, 1].astype(np.float32) * 0.587 + img[:, :, 2].astype(np.float32) * 0.114)


def _edge_strength(gray: np.ndarray) -> np.ndarray:
    gx = np.zeros_like(gray)
    gy = np.zeros_like(gray)
    gx[:, 1:-1] = gray[:, 2:] - gray[:, :-2]
    gy[1:-1, :] = gray[2:, :] - gray[:-2, :]
    mag = np.hypot(gx, gy)
    q90 = np.percentile(mag, 90)
    return mag / max(q90, 1.0)


def _local_texture(gray: np.ndarray) -> np.ndarray:
    padded = np.pad(gray, 2, mode="edge")
    samples = []
    for dy in range(5):
        for dx in range(5):
            samples.append(padded[dy:dy + gray.shape[0], dx:dx + gray.shape[1]])
    stack = np.stack(samples, axis=0)
    texture = stack.std(axis=0)
    q90 = np.percentile(texture, 90)
    return texture / max(q90, 1.0)


def _soil_likelihood(img: np.ndarray, sx: int, sy: int) -> np.ndarray:
    h, s, v = _rgb_to_hsv(img)
    gray = _grayscale(img)
    texture = _local_texture(gray)
    seed_patch = img[max(0, sy - 6):sy + 7, max(0, sx - 6):sx + 7]
    ph, ps, pv = _rgb_to_hsv(seed_patch)
    seed_h = float(np.median(ph))
    seed_s = float(np.median(ps))
    seed_v = float(np.median(pv))
    seed_rgb = seed_patch.astype(np.float32)
    seed_r = float(np.median(seed_rgb[:, :, 0]))
    seed_g = float(np.median(seed_rgb[:, :, 1]))
    seed_b = float(np.median(seed_rgb[:, :, 2]))

    hue_delta = np.minimum(np.abs(h - seed_h), 360.0 - np.abs(h - seed_h))
    adaptive = np.exp(-((hue_delta / 28.0) ** 2 + ((s - seed_s) / 18.0) ** 2 + ((v - seed_v) / 18.0) ** 2))

    rgb = img.astype(np.float32)
    r = rgb[:, :, 0]
    g = rgb[:, :, 1]
    b = rgb[:, :, 2]
    warmth = np.clip((r - b) / 65.0, 0.0, 1.0) * np.clip((r - g + 18.0) / 55.0, 0.0, 1.0)
    seed_warmth = max(0.1, min(1.0, ((seed_r - seed_b) / 65.0) * ((seed_r - seed_g + 18.0) / 55.0)))

    prior_laterite = ((h <= 38) & (s >= 10) & (s <= 75) & (v >= 15) & (v <= 85)).astype(np.float32)
    prior_beige = ((h >= 18) & (h <= 58) & (s >= 4) & (s <= 55) & (v >= 35) & (v <= 92)).astype(np.float32)
    prior_bare = ((s <= 26) & (v >= 22) & (v <= 76)).astype(np.float32)

    vegetation = ((h >= 60) & (h <= 165) & (s >= 18)).astype(np.float32)
    water = ((h >= 175) & (h <= 275) & (s >= 15)).astype(np.float32)
    dark = (v < 13).astype(np.float32)
    bright = (v > 94).astype(np.float32)
    neutral = (s < 17).astype(np.float32)
    road = ((s < 18) & (v >= 18) & (v <= 64)).astype(np.float32)
    roof_white = ((s < 16) & (v >= 78)).astype(np.float32)
    roof_red = ((((h <= 15) | (h >= 345)) & (s >= 24) & (v >= 28))).astype(np.float32)
    roof_blue = ((h >= 180) & (h <= 245) & (s >= 18) & (v >= 28)).astype(np.float32)
    concrete = ((neutral > 0) & (v >= 42) & (v <= 82) & (texture >= 0.42)).astype(np.float32)
    manmade = np.maximum.reduce([road, roof_white, roof_red, roof_blue, concrete])

    warm_bias = np.clip(warmth / seed_warmth, 0.0, 1.0)
    score = adaptive * 0.46 + np.maximum.reduce([prior_laterite, prior_beige, prior_bare]) * 0.28 + warm_bias * 0.26
    obstacle_penalty = np.maximum.reduce([
        vegetation * 0.96,
        water * 0.96,
        dark * 0.72,
        bright * 0.70,
        manmade * 0.92,
        np.clip(texture - 0.82, 0.0, 1.0) * 0.30,
    ])
    score *= (1.0 - obstacle_penalty)
    return np.clip(score, 0.0, 1.0)


def _manmade_mask(img: np.ndarray) -> np.ndarray:
    h, s, v = _rgb_to_hsv(img)
    gray = _grayscale(img)
    texture = _local_texture(gray)
    road = ((s < 18) & (v >= 18) & (v <= 66)).astype(np.uint8)
    roof_white = ((s < 16) & (v >= 78)).astype(np.uint8)
    roof_red = ((((h <= 15) | (h >= 345)) & (s >= 24) & (v >= 28))).astype(np.uint8)
    roof_blue = ((h >= 180) & (h <= 245) & (s >= 18) & (v >= 28)).astype(np.uint8)
    concrete = ((s < 22) & (v >= 42) & (v <= 82) & (texture >= 0.40)).astype(np.uint8)
    return np.maximum.reduce([road, roof_white, roof_red, roof_blue, concrete]).astype(np.uint8)


def _binary_dilate(mask: np.ndarray, iterations: int = 1) -> np.ndarray:
    out = mask.copy()
    for _ in range(iterations):
        padded = np.pad(out, 1, constant_values=0)
        nxt = np.zeros_like(out)
        for dy in range(3):
            for dx in range(3):
                nxt = np.maximum(nxt, padded[dy:dy + out.shape[0], dx:dx + out.shape[1]])
        out = nxt
    return out


def _binary_erode(mask: np.ndarray, iterations: int = 1) -> np.ndarray:
    out = mask.copy()
    for _ in range(iterations):
        padded = np.pad(out, 1, constant_values=0)
        nxt = np.ones_like(out)
        for dy in range(3):
            for dx in range(3):
                nxt = np.minimum(nxt, padded[dy:dy + out.shape[0], dx:dx + out.shape[1]])
        out = nxt
    return out


def _cleanup(mask: np.ndarray) -> np.ndarray:
    mask = _binary_dilate(mask, 2)
    mask = _binary_erode(mask, 1)
    mask = _binary_dilate(mask, 2)
    return mask


def _expand_region(mask: np.ndarray, score: np.ndarray, edge: np.ndarray) -> np.ndarray:
    h, w = mask.shape
    out = mask.copy()
    ys, xs = np.where(out > 0)
    if len(xs) < 20:
        return out
    region_scores = score[ys, xs]
    target = float(np.median(region_scores))
    loose_thr = max(0.20, target - 0.12)
    frontier = deque(zip(xs.tolist(), ys.tolist()))
    seen = set(frontier)
    while frontier:
        x, y = frontier.popleft()
        for nx in range(max(0, x - 1), min(w, x + 2)):
            for ny in range(max(0, y - 1), min(h, y + 2)):
                if (nx, ny) in seen:
                    continue
                seen.add((nx, ny))
                if out[ny, nx]:
                    frontier.append((nx, ny))
                    continue
                if score[ny, nx] >= loose_thr and edge[ny, nx] <= 1.75:
                    out[ny, nx] = 1
                    frontier.append((nx, ny))
    return _cleanup(out)


def _region_grow(score: np.ndarray, edge: np.ndarray, sx: int, sy: int) -> np.ndarray:
    h, w = score.shape
    if score[sy, sx] < 0.22:
        found = False
        for rad in range(1, 24):
            for y in range(max(0, sy - rad), min(h, sy + rad + 1)):
                for x in range(max(0, sx - rad), min(w, sx + rad + 1)):
                    if score[y, x] > 0.28:
                        sx, sy = x, y
                        found = True
                        break
                if found:
                    break
            if found:
                break
        if not found:
            return np.zeros_like(score, dtype=np.uint8)

    mask = np.zeros((h, w), dtype=np.uint8)
    q = deque([(sx, sy)])
    mask[sy, sx] = 1
    while q:
        x, y = q.popleft()
        local_thr = 0.23 if edge[y, x] < 0.85 else 0.32
        for nx in range(max(0, x - 1), min(w, x + 2)):
            for ny in range(max(0, y - 1), min(h, y + 2)):
                if mask[ny, nx]:
                    continue
                if score[ny, nx] >= local_thr and edge[ny, nx] <= 1.55:
                    mask[ny, nx] = 1
                    q.append((nx, ny))
    return _expand_region(_cleanup(mask), score, edge)


def _largest_component_with_seed(mask: np.ndarray, sx: int, sy: int) -> np.ndarray:
    h, w = mask.shape
    if mask[sy, sx] == 0:
        return mask
    out = np.zeros_like(mask)
    q = deque([(sx, sy)])
    out[sy, sx] = 1
    while q:
        x, y = q.popleft()
        for nx in range(max(0, x - 1), min(w, x + 2)):
            for ny in range(max(0, y - 1), min(h, y + 2)):
                if mask[ny, nx] and not out[ny, nx]:
                    out[ny, nx] = 1
                    q.append((nx, ny))
    return out


def _nearest_positive(mask: np.ndarray, sx: int, sy: int) -> Optional[Tuple[int, int]]:
    ys, xs = np.where(mask > 0)
    if len(xs) == 0:
        return None
    d2 = (xs - sx) ** 2 + (ys - sy) ** 2
    idx = int(np.argmin(d2))
    return int(xs[idx]), int(ys[idx])


def _prune_appendages(mask: np.ndarray, sx: int, sy: int) -> np.ndarray:
    eroded = _binary_erode(mask, 1)
    if int(eroded.sum()) < 60:
        return mask
    seed = (sx, sy) if eroded[sy, sx] else _nearest_positive(eroded, sx, sy)
    if seed is None:
        return mask
    core = _largest_component_with_seed(eroded, seed[0], seed[1])
    if int(core.sum()) < 40:
        return mask
    return _binary_dilate(core, 1)


def _ordered_contour(mask: np.ndarray) -> List[Tuple[int, int]]:
    padded = np.pad(mask, 1, constant_values=0)
    start = None
    h, w = mask.shape
    for y in range(1, h + 1):
        for x in range(1, w + 1):
            if padded[y, x] == 1 and np.min(padded[y - 1:y + 2, x - 1:x + 2]) == 0:
                start = (x, y)
                break
        if start:
            break
    if not start:
        return []

    directions = [
        (1, 0), (1, 1), (0, 1), (-1, 1),
        (-1, 0), (-1, -1), (0, -1), (1, -1),
    ]
    contour = [start]
    current = start
    prev_dir = 6
    for _ in range(8000):
        found = False
        for step in range(8):
            idx = (prev_dir + step) % 8
            dx, dy = directions[idx]
            nx, ny = current[0] + dx, current[1] + dy
            if padded[ny, nx] == 1:
                current = (nx, ny)
                contour.append(current)
                prev_dir = (idx + 5) % 8
                found = True
                break
        if not found:
            break
        if current == start and len(contour) > 16:
            break
    return [(x - 1, y - 1) for x, y in contour]


def _rdp(points: List[Tuple[int, int]], tol: float) -> List[Tuple[int, int]]:
    if len(points) < 3:
        return points
    sx, sy = points[0]
    ex, ey = points[-1]
    den = math.hypot(ex - sx, ey - sy)
    max_d = 0.0
    max_i = 0
    for i in range(1, len(points) - 1):
        px, py = points[i]
        if den < 1e-6:
            d = math.hypot(px - sx, py - sy)
        else:
            d = abs((ey - sy) * px - (ex - sx) * py + ex * sy - ey * sx) / den
        if d > max_d:
            max_d = d
            max_i = i
    if max_d > tol:
        left = _rdp(points[:max_i + 1], tol)
        right = _rdp(points[max_i:], tol)
        return left[:-1] + right
    return [points[0], points[-1]]


def _area_m2(coords: List[List[float]]) -> float:
    if len(coords) < 3:
        return 0.0
    clat = sum(c[1] for c in coords) / len(coords)
    clon = sum(c[0] for c in coords) / len(coords)
    lat_m = 111_320.0
    lon_m = 111_320.0 * math.cos(math.radians(clat))
    pts = [((x - clon) * lon_m, (y - clat) * lat_m) for x, y in coords]
    area = 0.0
    for i in range(len(pts)):
        j = (i + 1) % len(pts)
        area += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
    return abs(area) / 2.0


async def detect_plot_boundary(lat: float, lon: float) -> Tuple[Optional[List[List[float]]], float]:
    zoom = 19
    cx, cy = _deg2tile(lat, lon, zoom)
    lon_w, lat_s, lon_e, lat_n = _composite_bounds(cx, cy, zoom)
    sx, sy = _gps_to_px(lat, lon, lon_w, lat_s, lon_e, lat_n, COMP_PX, COMP_PX)
    img = await _fetch_composite(cx, cy, zoom)
    if img is None:
        return None, 0.0

    gray = _grayscale(img)
    edges = _edge_strength(gray)
    soil_score = _soil_likelihood(img, sx, sy)
    region = _region_grow(soil_score, edges, sx, sy)
    obstacles = _manmade_mask(img)
    region = np.where(obstacles > 0, 0, region).astype(np.uint8)
    region = _largest_component_with_seed(region, sx, sy)
    seed = (sx, sy) if region[sy, sx] else _nearest_positive(region, sx, sy)
    if seed is not None:
        region = _largest_component_with_seed(region, seed[0], seed[1])
        region = _prune_appendages(region, seed[0], seed[1])

    pixel_count = int(region.sum())
    if pixel_count < 45:
        logger.info("Boundary segmentation rejected: too few pixels (%s)", pixel_count)
        return None, 0.0

    contour = _ordered_contour(region)
    if len(contour) < 4:
        return None, 0.0
    sampled = contour[::max(1, len(contour) // 240)]
    simplified = _rdp(sampled + [sampled[0]], 2.2)
    if len(simplified) < 5:
        simplified = sampled[:]
    polygon = _px_to_gps(simplified, lon_w, lat_s, lon_e, lat_n, COMP_PX, COMP_PX)
    if polygon[0] != polygon[-1]:
        polygon.append(polygon[0])
    area = round(_area_m2(polygon), 1)
    if area < 20 or area > 120_000:
        logger.info("Boundary segmentation rejected: implausible area %.1f", area)
        return None, 0.0
    return polygon, area
