"""Genetic floor plan integration wrapper for the multi-algorithm GA engine."""

from __future__ import annotations

import math
from typing import Any, Dict, List, Tuple

from .ga_engine import Chromosome, Room, run_all_algorithms


ALGO_STYLE_MAP = {
    "NSGA-III": "Multi-Objective Pareto",
    "MOEA-D": "Decomposition-Optimised",
    "SHADE": "Adaptive Evolution",
    "Island-GA": "Topology-Specialised",
    "CMA-ES": "Covariance-Adapted",
}


def _overlap_1d(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def room_to_dict(room: Room) -> Dict[str, Any]:
    return {
        "id": room.id,
        "type": room.type,
        "width": round(room.width, 3),
        "height": round(room.height, 3),
        "x": round(room.x, 3),
        "y": round(room.y, 3),
        "floor": int(room.floor),
        "orientation": room.orientation,
    }


def _shared_segments(rooms: List[Room], tol: float = 0.09) -> List[Dict[str, Any]]:
    shared: List[Dict[str, Any]] = []
    seen = set()
    for i in range(len(rooms)):
        a = rooms[i]
        for j in range(i + 1, len(rooms)):
            b = rooms[j]
            if a.floor != b.floor:
                continue

            if abs((a.x + a.width) - b.x) <= tol or abs((b.x + b.width) - a.x) <= tol:
                x = a.x + a.width if abs((a.x + a.width) - b.x) <= tol else b.x + b.width
                y0 = max(a.y, b.y)
                y1 = min(a.y + a.height, b.y + b.height)
                if y1 - y0 > 0.35:
                    key = (round(x, 2), round(y0, 2), round(y1, 2), "vertical")
                    if key not in seen:
                        seen.add(key)
                        shared.append(
                            {
                                "room_a": a,
                                "room_b": b,
                                "orientation": "vertical",
                                "x": x,
                                "y0": y0,
                                "y1": y1,
                                "length": y1 - y0,
                            }
                        )

            if abs((a.y + a.height) - b.y) <= tol or abs((b.y + b.height) - a.y) <= tol:
                y = a.y + a.height if abs((a.y + a.height) - b.y) <= tol else b.y + b.height
                x0 = max(a.x, b.x)
                x1 = min(a.x + a.width, b.x + b.width)
                if x1 - x0 > 0.35:
                    key = (round(y, 2), round(x0, 2), round(x1, 2), "horizontal")
                    if key not in seen:
                        seen.add(key)
                        shared.append(
                            {
                                "room_a": a,
                                "room_b": b,
                                "orientation": "horizontal",
                                "y": y,
                                "x0": x0,
                                "x1": x1,
                                "length": x1 - x0,
                            }
                        )
    return shared


def generate_walls(rooms: List[Room]) -> List[Dict[str, Any]]:
    if not rooms:
        return []

    walls: List[Dict[str, Any]] = []
    wid = 1

    min_x = min(r.x for r in rooms)
    min_y = min(r.y for r in rooms)
    max_x = max(r.x + r.width for r in rooms)
    max_y = max(r.y + r.height for r in rooms)

    perimeter = [
        ("horizontal", min_x, min_y, max_x, min_y),
        ("horizontal", min_x, max_y, max_x, max_y),
        ("vertical", min_x, min_y, min_x, max_y),
        ("vertical", max_x, min_y, max_x, max_y),
    ]
    for orient, x1, y1, x2, y2 in perimeter:
        length = abs(x2 - x1) if orient == "horizontal" else abs(y2 - y1)
        walls.append(
            {
                "id": f"wall_{wid}",
                "room_id": "perimeter",
                "type": "exterior",
                "orientation": orient,
                "x": round((x1 + x2) / 2.0, 3),
                "y": round((y1 + y2) / 2.0, 3),
                "x2": round(x2, 3),
                "y2": round(y2, 3),
                "length": round(length, 3),
                "thickness": 0.23,
                "floor": 1,
                "height": 3.2,
            }
        )
        wid += 1

    for seg in _shared_segments(rooms):
        if seg["orientation"] == "vertical":
            x1 = x2 = seg["x"]
            y1 = seg["y0"]
            y2 = seg["y1"]
        else:
            x1 = seg["x0"]
            x2 = seg["x1"]
            y1 = y2 = seg["y"]

        walls.append(
            {
                "id": f"wall_{wid}",
                "room_id": seg["room_a"].id,
                "type": "interior",
                "orientation": seg["orientation"],
                "x": round((x1 + x2) / 2.0, 3),
                "y": round((y1 + y2) / 2.0, 3),
                "x2": round(x2, 3),
                "y2": round(y2, 3),
                "length": round(seg["length"], 3),
                "thickness": 0.12,
                "floor": 1,
                "height": 3.2,
            }
        )
        wid += 1

    return walls


def generate_doors(rooms: List[Room]) -> List[Dict[str, Any]]:
    if not rooms:
        return []

    doors: List[Dict[str, Any]] = []
    did = 1

    for seg in _shared_segments(rooms):
        a = seg["room_a"]
        b = seg["room_b"]
        if {a.type, b.type} == {"bathroom", "dining"}:
            continue

        width = max(0.75, min(0.9, seg["length"] * 0.55))
        if seg["orientation"] == "vertical":
            x = seg["x"]
            y = (seg["y0"] + seg["y1"]) / 2.0
            orientation = "vertical"
        else:
            x = (seg["x0"] + seg["x1"]) / 2.0
            y = seg["y"]
            orientation = "horizontal"

        smaller = a if (a.width * a.height) < (b.width * b.height) else b
        doors.append(
            {
                "id": f"door_{did}",
                "room_to": b.id,
                "type": "interior",
                "x": round(x, 3),
                "y": round(y, 3),
                "width": round(width, 3),
                "orientation": orientation,
                "symbol": f"arc_swing_{smaller.id}",
                "floor": 1,
                "height": 2.1,
                "wall_id": None,
            }
        )
        did += 1

    south_room = min(rooms, key=lambda r: r.y)
    doors.append(
        {
            "id": f"door_{did}",
            "room_to": south_room.id,
            "type": "entry",
            "x": round(south_room.x + south_room.width / 2.0, 3),
            "y": round(south_room.y, 3),
            "width": 1.2,
            "orientation": "horizontal",
            "symbol": "double_door",
            "floor": 1,
            "height": 2.1,
            "wall_id": None,
        }
    )
    return doors


def _edge_map(rooms: List[Room], tol: float = 0.18) -> Dict[str, List[str]]:
    if not rooms:
        return {}
    min_x = min(r.x for r in rooms)
    min_y = min(r.y for r in rooms)
    max_x = max(r.x + r.width for r in rooms)
    max_y = max(r.y + r.height for r in rooms)

    out: Dict[str, List[str]] = {}
    for room in rooms:
        edges: List[str] = []
        if room.y <= min_y + tol:
            edges.append("top")
        if room.y + room.height >= max_y - tol:
            edges.append("bottom")
        if room.x <= min_x + tol:
            edges.append("left")
        if room.x + room.width >= max_x - tol:
            edges.append("right")
        out[room.id] = edges
    return out


def _windward_edge(wind_direction: str) -> str:
    wd = (wind_direction or "SW").upper()
    if wd.startswith("N"):
        return "top"
    if wd.startswith("S"):
        return "bottom"
    if wd.startswith("E"):
        return "right"
    if wd.startswith("W"):
        return "left"
    return "left"


def _leeward_edge(wind_direction: str) -> str:
    mapping = {"top": "bottom", "bottom": "top", "left": "right", "right": "left"}
    return mapping[_windward_edge(wind_direction)]


def _climate_wwr(solar_radiation: float) -> float:
    if solar_radiation > 6.0:
        return 0.25
    if solar_radiation < 3.5:
        return 0.45
    return 0.35


def generate_windows(rooms: List[Room], env_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    if not rooms:
        return []

    edges_by_room = _edge_map(rooms)
    windows: List[Dict[str, Any]] = []
    wid = 1

    windward = _windward_edge(str(env_data.get("wind_direction", "SW")))
    leeward = _leeward_edge(str(env_data.get("wind_direction", "SW")))
    wwr = _climate_wwr(float(env_data.get("solar_radiation", 5.2)))

    def edge_span(room: Room, edge: str) -> float:
        return room.width if edge in {"top", "bottom"} else room.height

    def add_window(room: Room, edge: str, sill: float = 0.9) -> None:
        nonlocal wid
        width = max(0.5, min(2.4, edge_span(room, edge) * wwr))
        windows.append(
            {
                "id": f"win_{wid}",
                "wall": f"{room.id}_{edge}",
                "position": 0.5,
                "width": round(width, 3),
                "sill_height": round(sill, 3),
                "head_height": 2.1,
                "floor": 1,
            }
        )
        wid += 1

    for room in rooms:
        edges = edges_by_room.get(room.id, [])
        if not edges:
            continue

        preferred: List[str]
        if room.type == "living":
            preferred = ["top", "right"]
        elif room.type == "bedroom":
            preferred = ["right", "left", "bottom"]
        elif room.type == "kitchen":
            preferred = [windward, leeward]
        elif room.type == "bathroom":
            preferred = list(edges)
        elif room.type == "office":
            preferred = ["bottom", "right", "left"]
        elif room.type == "dining":
            preferred = ["top", "right", "left"]
        else:
            preferred = [windward, "right", "left", "top", "bottom"]

        chosen = [edge for edge in preferred if edge in edges]
        if not chosen:
            chosen = edges[:]

        if room.type == "living":
            for edge in chosen[:2]:
                add_window(room, edge, sill=0.9)
        elif room.type == "bedroom":
            add_window(room, chosen[0], sill=0.9)
            cross = next((e for e in chosen if (e in {"left", "right"} and chosen[0] in {"top", "bottom"}) or (e in {"top", "bottom"} and chosen[0] in {"left", "right"})), None)
            if cross is not None:
                add_window(room, cross, sill=1.0)
            elif len(chosen) > 1:
                add_window(room, chosen[1], sill=1.0)
        elif room.type == "bathroom":
            add_window(room, chosen[0], sill=1.5)
        else:
            add_window(room, chosen[0], sill=0.9)

        if room.type in {"living", "bedroom", "dining", "office"}:
            existing_edges = [w["wall"].split("_")[-1] for w in windows if str(w["wall"]).startswith(f"{room.id}_")]
            has_cross = any(
                (a in {"top", "bottom"} and b in {"left", "right"}) or (a in {"left", "right"} and b in {"top", "bottom"})
                for a in existing_edges
                for b in existing_edges
                if a != b
            )
            if not has_cross:
                candidate = next((e for e in edges if e not in existing_edges), None)
                if candidate is not None:
                    add_window(room, candidate, sill=1.0)

    return windows


def chromosome_to_response(c: Chromosome, idx: int, env_data: Dict[str, Any]) -> Dict[str, Any]:
    walls = generate_walls(c.rooms)
    doors = generate_doors(c.rooms)
    windows = generate_windows(c.rooms, env_data)

    return {
        "id": idx + 1,
        "algorithm": c.algorithm,
        "style": ALGO_STYLE_MAP.get(c.algorithm, c.algorithm),
        "layout": [room_to_dict(room) for room in c.rooms],
        "walls": walls,
        "doors": doors,
        "windows": windows,
        "eco_score": round(c.fitness["eco_score"], 3),
        "fitness_score": round(c.fitness["eco_score"], 3),
        "solar_score": round(c.fitness["solar_score"], 3),
        "ventilation_score": round(c.fitness["ventilation_score"], 3),
        "structural_score": round(c.fitness["structural_score"], 3),
        "flood_score": round(c.fitness["flood_score"], 3),
        "tree_score": round(c.fitness["tree_score"], 3),
        "total_area": round(sum(r.width * r.height for r in c.rooms), 3),
        "is_best": False,
        "convergence_curve": [round(v, 4) for v in c.convergence_curve],
        "generations_run": int(c.generations_run),
        "converged_early": bool(c.converged_early),
        "runtime_ms": int(c.runtime_ms),
    }


def generate_floor_plan_variants(env_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    chromosomes = run_all_algorithms(env_data)
    variants = [chromosome_to_response(chrom, idx, env_data) for idx, chrom in enumerate(chromosomes)]
    variants.sort(key=lambda item: item["eco_score"], reverse=True)

    for i, variant in enumerate(variants):
        variant["id"] = i + 1
        variant["is_best"] = i == 0
    return variants


def run_genetic_optimizer(
    plot_area: float = 500.0,
    num_floors: int = 2,
    style: str = "sustainable",
    preserve_trees: bool = True,
    population_size: int = 60,
    generations: int = 80,
    mutation_rate: float = 0.2,
) -> Dict[str, Any]:
    """Backwards-compatible wrapper used by older service paths."""
    env = {
        "plot_area_sqm": max(45.0, float(plot_area)),
        "num_floors": int(max(1, num_floors)),
        "style": style,
        "preserve_trees": bool(preserve_trees),
        "wind_direction": "SW",
        "sun_exposure_hours": 6.0,
        "solar_radiation": 5.0,
        "flood_probability": 0.25,
        "buildability_score": 72.0,
        "tree_coordinates": [],
    }
    variants = generate_floor_plan_variants(env)
    best = variants[0] if variants else {
        "layout": [],
        "eco_score": 0.0,
        "solar_score": 0.0,
        "ventilation_score": 0.0,
        "generations_run": 0,
    }

    return {
        "rooms": best["layout"],
        "fitness_score": best["eco_score"],
        "generation_count": best.get("generations_run", 0),
        "sunlight_score": best["solar_score"],
        "ventilation_score": best["ventilation_score"],
        "tree_preserved_count": 0,
        "orientation_degrees": 0.0,
    }
