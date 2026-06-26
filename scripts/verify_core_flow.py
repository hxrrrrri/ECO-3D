#!/usr/bin/env python3
"""Verify the ECO-3D map-click API flow against a running backend.

This intentionally uses only the Python standard library so it can run before
project dependencies are installed. Start the FastAPI backend first, then run:

    python scripts/verify_core_flow.py
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


def request_json(
    base_url: str,
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
    timeout: int = 90,
) -> dict[str, Any]:
    url = f"{base_url.rstrip('/')}{path}"
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
      with urllib.request.urlopen(req, timeout=timeout) as response:
          body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {url} failed with HTTP {exc.code}: {body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"{method} {url} failed: {exc.reason}") from exc

    parsed = json.loads(body)
    if isinstance(parsed, dict) and parsed.get("error") is True:
        raise RuntimeError(f"{method} {url} returned application error: {parsed}")
    if not isinstance(parsed, dict):
        raise RuntimeError(f"{method} {url} returned malformed JSON: {body[:300]}")
    return parsed


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def valid_lon_lat_ring(boundary: Any) -> bool:
    if not isinstance(boundary, list) or len(boundary) < 4:
        return False
    for point in boundary:
        if not isinstance(point, list) or len(point) < 2:
            return False
        lon, lat = point[:2]
        if not isinstance(lon, (int, float)) or not isinstance(lat, (int, float)):
            return False
        if not -180 <= lon <= 180 or not -90 <= lat <= 90:
            return False
    first = boundary[0]
    last = boundary[-1]
    return first[0] == last[0] and first[1] == last[1]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--lat", type=float, default=12.9716)
    parser.add_argument("--lon", type=float, default=77.5946)
    args = parser.parse_args()

    start = time.perf_counter()
    plot_id = f"VERIFY{abs(int(args.lat * 1000))}X{abs(int(args.lon * 1000))}"

    health = request_json(args.base_url, "GET", "/health", timeout=10)
    require(health.get("status") == "ok", f"health status was not ok: {health}")

    query = urllib.parse.urlencode({"lat": args.lat, "lon": args.lon})
    boundary = request_json(args.base_url, "GET", f"/plot-boundary?{query}", timeout=60)
    require(valid_lon_lat_ring(boundary.get("boundary")), "boundary must be a closed lon/lat ring")
    require(float(boundary.get("area_sqm", 0)) > 0, "boundary area_sqm must be positive")

    analysis_payload = {
        "plot_id": plot_id,
        "lat": args.lat,
        "lon": args.lon,
        "polygon": boundary["boundary"],
    }
    analysis = request_json(args.base_url, "POST", "/analyze-plot", analysis_payload, timeout=120)
    require(analysis.get("plot_id") == plot_id, "analysis plot_id mismatch")
    require(isinstance(analysis.get("environmental"), dict), "analysis environmental payload missing")
    require(isinstance(analysis.get("segmentation"), dict), "analysis segmentation payload missing")

    floorplan_payload = {
        "plot_id": plot_id,
        "plot_area_sqm": boundary["area_sqm"],
        "num_floors": 2,
        "preserve_trees": True,
        "layout_mode": "fit_boundary",
    }
    floorplan = request_json(args.base_url, "POST", "/generate-floorplan", floorplan_payload, timeout=120)
    require(floorplan.get("plot_id") == plot_id, "floorplan plot_id mismatch")
    require(isinstance(floorplan.get("layout"), list) and floorplan["layout"], "floorplan layout missing")
    require(float(floorplan.get("total_area", 0)) > 0, "floorplan total_area must be positive")
    require(isinstance(floorplan.get("variants"), list) and floorplan["variants"], "floorplan variants missing")

    elapsed = time.perf_counter() - start
    summary = {
        "ok": True,
        "base_url": args.base_url,
        "plot_id": plot_id,
        "boundary_points": len(boundary["boundary"]),
        "area_sqm": boundary["area_sqm"],
        "analysis_status": analysis.get("status"),
        "rooms": len(floorplan["layout"]),
        "variants": len(floorplan["variants"]),
        "elapsed_sec": round(elapsed, 2),
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"verify_core_flow failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
