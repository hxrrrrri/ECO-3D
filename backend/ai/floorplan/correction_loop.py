from __future__ import annotations

import copy
import logging
import math
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from .correction_strategies import (
    RoomMutation,
    correct_criterion_1,
    correct_criterion_2,
    correct_criterion_3,
    correct_criterion_4,
    correct_criterion_5,
    correct_criterion_6,
    correct_criterion_7,
    correct_criterion_8,
    correct_criterion_9,
    correct_criterion_10,
)
from .eco_validator import CriterionResult, EcoAuditReport, run_eco_audit
from .ga_engine import (
    Chromosome,
    Room,
    encode_rooms_to_vector,
    evaluate_chromosome,
    rooms_overlap,
    run_all_algorithms,
    run_nsga3,
)
from .genetic import generate_doors, generate_walls, generate_windows

logger = logging.getLogger(__name__)

MAX_ITERATIONS = 12
TARGET_SCORE = 92.0
MIN_IMPROVEMENT = 0.3
STAGNATION_WINDOW = 3
HARD_TIMEOUT_SEC = 25.0

MIN_ROOM_DIMS: Dict[str, Tuple[float, float]] = {
    "living": (3.6, 3.0),
    "dining": (2.8, 2.5),
    "kitchen": (2.4, 2.2),
    "bedroom": (2.8, 2.8),
    "bathroom": (1.6, 1.6),
    "office": (2.5, 2.5),
    "utility": (1.5, 1.5),
}


@dataclass
class CorrectionResult:
    iteration: int
    mutations_applied: List[RoomMutation]
    n_mutations: int
    criteria_targeted: List[int]
    eco_score_before: float
    eco_score_after: float
    score_delta: float
    improvement: bool
    audit_after: EcoAuditReport


@dataclass
class IterationSnapshot:
    iteration: int
    chromosome: Chromosome
    audit: EcoAuditReport
    correction: Optional[CorrectionResult]
    cumulative_fixes: List[str]
    runtime_ms: int


@dataclass
class IterationHistory:
    plot_id: str
    total_iterations: int
    converged: bool
    convergence_reason: str
    initial_eco_score: float
    final_eco_score: float
    total_improvement: float
    snapshots: List[IterationSnapshot]
    final_chromosome: Chromosome
    final_audit: EcoAuditReport
    total_runtime_ms: int
    eco_score_curve: List[float]
    corrections_applied: List[str] = field(default_factory=list)


STRATEGY_MAP = {
    1: correct_criterion_1,
    2: correct_criterion_2,
    3: correct_criterion_3,
    4: correct_criterion_4,
    5: correct_criterion_5,
    6: correct_criterion_6,
    7: correct_criterion_7,
    8: correct_criterion_8,
    9: correct_criterion_9,
    10: correct_criterion_10,
}

# Ordered by impact on eco_score (most impactful criteria corrected first)
STRATEGY_PRIORITY = [5, 1, 2, 4, 6, 3, 7, 8, 9, 10]


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return float(default)
        return float(value)
    except Exception:
        return float(default)


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        if value is None:
            return int(default)
        return int(value)
    except Exception:
        return int(default)


def _value(obj: Any, key: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _orientation_to_bearing(orientation: str) -> float:
    lookup = {
        "N": 0.0,
        "NE": 45.0,
        "E": 90.0,
        "SE": 135.0,
        "S": 180.0,
        "SW": 225.0,
        "W": 270.0,
        "NW": 315.0,
        "NNE": 22.5,
        "ENE": 67.5,
        "ESE": 112.5,
        "SSE": 157.5,
        "SSW": 202.5,
        "WSW": 247.5,
        "WNW": 292.5,
        "NNW": 337.5,
    }
    return lookup.get(str(orientation or "S").upper(), 180.0)


def _bearing_to_orientation(bearing: float) -> str:
    octants = [
        "N",
        "NE",
        "E",
        "SE",
        "S",
        "SW",
        "W",
        "NW",
    ]
    idx = int(((bearing % 360.0) + 22.5) // 45.0) % 8
    return octants[idx]


def _merge_annotations(chromosome: Chromosome, annotations: Dict[str, Any]) -> None:
    if not annotations:
        return
    current = getattr(chromosome, "eco_annotations", None)
    if not isinstance(current, dict):
        current = {}
    current.update(annotations)
    setattr(chromosome, "eco_annotations", current)


def _room_by_id(chromosome: Chromosome, room_id: str) -> Optional[Room]:
    for room in list(getattr(chromosome, "rooms", []) or []):
        if str(getattr(room, "id", "")) == str(room_id):
            return room
    return None


def _room_confidence_map(mutations: List[RoomMutation]) -> Dict[str, float]:
    out: Dict[str, float] = {}
    for mutation in mutations:
        rid = str(mutation.room_id)
        prev = out.get(rid, -1.0)
        if mutation.confidence > prev:
            out[rid] = float(mutation.confidence)
    return out


def _normalized_wall_face(face_value: Any) -> str:
    face = str(face_value or "").strip().lower()
    if face in {"north", "n", "top"}:
        return "top"
    if face in {"south", "s", "bottom"}:
        return "bottom"
    if face in {"west", "w", "left"}:
        return "left"
    if face in {"east", "e", "right"}:
        return "right"
    return face


def _windows_for_chromosome(chromosome: Chromosome, env: dict) -> List[dict]:
    existing = list(getattr(chromosome, "windows", []) or [])
    if existing:
        return existing
    generated = generate_windows(list(getattr(chromosome, "rooms", []) or []), env)
    setattr(chromosome, "windows", list(generated))
    return list(generated)


def _criteria_sorted_for_iteration(failed: List[CriterionResult], iteration: int) -> List[CriterionResult]:
    ordered = sorted(
        failed,
        key=lambda row: STRATEGY_PRIORITY.index(row.criterion_id)
        if row.criterion_id in STRATEGY_PRIORITY
        else 999,
    )

    if iteration == 0:
        flood = [row for row in ordered if row.criterion_id == 5]
        rest = [row for row in ordered if row.criterion_id != 5]
        ordered = flood + rest

    return ordered


def _resolve_mutation_conflicts(mutations: List[RoomMutation]) -> List[RoomMutation]:
    if not mutations:
        return []

    sorted_mutations = sorted(mutations, key=lambda item: item.confidence, reverse=True)

    move_like_best: Dict[Tuple[str, str], RoomMutation] = {}
    window_ops: Dict[Tuple[str, str], RoomMutation] = {}
    passthrough: List[RoomMutation] = []

    for mutation in sorted_mutations:
        mtype = mutation.mutation_type
        room_key = str(mutation.room_id)

        if mtype in {"move", "resize", "rotate", "reorient", "elevate_floor", "swap_type"}:
            normalized_key = (room_key, "move") if mtype == "move" else (room_key, mtype)
            current = move_like_best.get(normalized_key)
            if current is None or mutation.confidence > current.confidence:
                move_like_best[normalized_key] = mutation
            continue

        if mtype in {"add_window", "remove_window"}:
            face = _normalized_wall_face(mutation.new_value.get("wall_face", ""))
            key = (room_key, face)
            prev = window_ops.get(key)
            if prev is None:
                window_ops[key] = mutation
                continue

            if prev.mutation_type == "add_window" and mtype == "remove_window":
                continue
            if prev.mutation_type == "remove_window" and mtype == "add_window":
                window_ops[key] = mutation
                continue
            if mutation.confidence > prev.confidence:
                window_ops[key] = mutation
            continue

        passthrough.append(mutation)

    resolved = list(move_like_best.values()) + list(window_ops.values()) + passthrough
    resolved.sort(key=lambda item: item.confidence, reverse=True)
    return resolved


def _apply_reorient_cooldown(mutations: List[RoomMutation], cooldown: int) -> Tuple[List[RoomMutation], int]:
    if cooldown <= 0:
        return (mutations, 0)

    filtered: List[RoomMutation] = []
    dropped = 0
    for mutation in mutations:
        if mutation.mutation_type in {"reorient", "rotate"}:
            dropped += 1
            continue
        filtered.append(mutation)
    return (filtered, dropped)


def _scale_mutation(mutation: RoomMutation, factor: float) -> RoomMutation:
    new_mutation = copy.deepcopy(mutation)
    f = max(0.1, min(1.0, factor))

    if new_mutation.mutation_type == "move":
        ox = _safe_float(new_mutation.old_value.get("x"), 0.0)
        oy = _safe_float(new_mutation.old_value.get("y"), 0.0)
        nx = _safe_float(new_mutation.new_value.get("x", ox), ox)
        ny = _safe_float(new_mutation.new_value.get("y", oy), oy)
        new_mutation.new_value["x"] = round(ox + (nx - ox) * f, 3)
        new_mutation.new_value["y"] = round(oy + (ny - oy) * f, 3)

    elif new_mutation.mutation_type == "resize":
        sf = _safe_float(new_mutation.new_value.get("scale_factor", 1.0), 1.0)
        new_mutation.new_value["scale_factor"] = round(1.0 + (sf - 1.0) * f, 4)

    elif new_mutation.mutation_type in {"reorient", "rotate"}:
        delta = _safe_float(new_mutation.new_value.get("orientation_delta_deg", new_mutation.new_value.get("rotation_deg", 0.0)), 0.0)
        scaled = round(delta * f, 3)
        if "orientation_delta_deg" in new_mutation.new_value:
            new_mutation.new_value["orientation_delta_deg"] = scaled
        if "rotation_deg" in new_mutation.new_value:
            new_mutation.new_value["rotation_deg"] = scaled

    elif new_mutation.mutation_type == "add_window":
        width = _safe_float(new_mutation.new_value.get("width", 1.0), 1.0)
        new_mutation.new_value["width"] = round(max(0.4, width * f), 3)

    new_mutation.confidence = max(0.1, min(1.0, mutation.confidence * (0.8 + 0.2 * f)))
    return new_mutation


def _stagnated(eco_score_curve: List[float]) -> bool:
    if len(eco_score_curve) < STAGNATION_WINDOW + 1:
        return False
    recent = eco_score_curve[-(STAGNATION_WINDOW + 1) :]
    return (max(recent) - min(recent)) < MIN_IMPROVEMENT


def apply_mutations(chromosome: Chromosome, mutations: List[RoomMutation]) -> Chromosome:
    """
    Apply a list of RoomMutation objects to a chromosome.
    Returns a NEW chromosome and never mutates in place.
    """
    new_chrom = copy.deepcopy(chromosome)
    if not hasattr(new_chrom, "windows") or getattr(new_chrom, "windows", None) is None:
        setattr(new_chrom, "windows", [])

    room_confidence = _room_confidence_map(mutations)

    for mutation in sorted(mutations, key=lambda item: -item.confidence):
        room = _room_by_id(new_chrom, mutation.room_id)

        annotations = mutation.new_value.get("_annotations") if isinstance(mutation.new_value, dict) else None
        if isinstance(annotations, dict):
            _merge_annotations(new_chrom, annotations)

        if mutation.mutation_type == "move":
            if room is not None:
                room.x = _safe_float(mutation.new_value.get("x", room.x), room.x)
                room.y = _safe_float(mutation.new_value.get("y", room.y), room.y)

        elif mutation.mutation_type == "resize":
            if room is not None:
                room_type = str(getattr(room, "type", "") or "").lower()
                min_w, min_h = MIN_ROOM_DIMS.get(room_type, (2.4, 2.0))
                sf = _safe_float(mutation.new_value.get("scale_factor", 1.0), 1.0)
                axis = str(mutation.new_value.get("axis", "both") or "both").lower()

                if axis == "minor":
                    axis = "width" if room.width <= room.height else "height"
                elif axis == "major":
                    axis = "width" if room.width >= room.height else "height"

                if axis in {"both", "width"}:
                    room.width = max(min_w, room.width * sf)
                if axis in {"both", "height"}:
                    room.height = max(min_h, room.height * sf)

        elif mutation.mutation_type in {"reorient", "rotate"}:
            delta = _safe_float(
                mutation.new_value.get("orientation_delta_deg", mutation.new_value.get("rotation_deg", 0.0)),
                0.0,
            )

            if mutation.new_value.get("all_rooms", False):
                rooms = list(getattr(new_chrom, "rooms", []) or [])
                if rooms:
                    cx = sum(r.x + r.width * 0.5 for r in rooms) / len(rooms)
                    cy = sum(r.y + r.height * 0.5 for r in rooms) / len(rooms)
                    rad = math.radians(delta)
                    for rm in rooms:
                        rcx = rm.x + rm.width * 0.5 - cx
                        rcy = rm.y + rm.height * 0.5 - cy
                        nx = cx + rcx * math.cos(rad) - rcy * math.sin(rad)
                        ny = cy + rcx * math.sin(rad) + rcy * math.cos(rad)
                        rm.x = nx - rm.width * 0.5
                        rm.y = ny - rm.height * 0.5

                        new_bearing = (_orientation_to_bearing(getattr(rm, "orientation", "S")) + delta) % 360.0
                        rm.orientation = _bearing_to_orientation(new_bearing)
            elif room is not None:
                if "orientation" in mutation.new_value:
                    room.orientation = str(mutation.new_value.get("orientation", room.orientation))
                elif abs(delta) > 1e-6:
                    new_bearing = (_orientation_to_bearing(getattr(room, "orientation", "S")) + delta) % 360.0
                    room.orientation = _bearing_to_orientation(new_bearing)

        elif mutation.mutation_type == "elevate_floor":
            if room is not None:
                room.floor = _safe_int(mutation.new_value.get("floor", int(getattr(room, "floor", 1)) + 1), int(getattr(room, "floor", 1)))

        elif mutation.mutation_type == "add_window":
            windows = list(getattr(new_chrom, "windows", []) or [])
            face = _normalized_wall_face(mutation.new_value.get("wall_face", "south"))
            floor = int(getattr(room, "floor", 1)) if room is not None else 1
            wall_name = f"{mutation.room_id}_{face}"
            new_window = {
                "id": f"w_{mutation.room_id}_{len(windows)}",
                "wall": wall_name,
                "position": _safe_float(mutation.new_value.get("position", 0.5), 0.5),
                "width": _safe_float(mutation.new_value.get("width", 1.2), 1.2),
                "sill_height": _safe_float(mutation.new_value.get("sill_height", 0.9), 0.9),
                "head_height": _safe_float(mutation.new_value.get("head_height", 2.1), 2.1),
                "floor": floor,
            }
            windows.append(new_window)
            setattr(new_chrom, "windows", windows)

        elif mutation.mutation_type == "remove_window":
            target_face = _normalized_wall_face(mutation.new_value.get("wall_face", ""))
            target_prefix = f"{mutation.room_id}_"

            filtered = []
            for w in list(getattr(new_chrom, "windows", []) or []):
                wall = str(_value(w, "wall", "") or "")
                if not wall.startswith(target_prefix):
                    filtered.append(w)
                    continue

                if not target_face:
                    continue

                wall_face = _normalized_wall_face(wall.split("_")[-1])
                if wall_face == target_face:
                    continue
                filtered.append(w)

            setattr(new_chrom, "windows", filtered)

        elif mutation.mutation_type == "add_room":
            rooms = list(getattr(new_chrom, "rooms", []) or [])
            new_room = Room(
                id=f"room_{len(rooms) + 1}",
                type=str(mutation.new_value.get("type", "utility")),
                x=_safe_float(mutation.new_value.get("x", getattr(new_chrom, "plot_w", 12.0) * 0.8), 0.0),
                y=_safe_float(mutation.new_value.get("y", getattr(new_chrom, "plot_h", 12.0) * 0.8), 0.0),
                width=_safe_float(mutation.new_value.get("width", 2.0), 2.0),
                height=_safe_float(mutation.new_value.get("height", 2.0), 2.0),
                floor=_safe_int(mutation.new_value.get("floor", 1), 1),
                orientation=str(mutation.new_value.get("orientation", "N") or "N"),
            )
            rooms.append(new_room)
            setattr(new_chrom, "rooms", rooms)

        elif mutation.mutation_type == "swap_type":
            if room is not None:
                room.type = str(mutation.new_value.get("type", room.type))

        # Boundary safety after every mutation
        new_chrom = _enforce_boundary(new_chrom)

    new_chrom = _resolve_overlaps(new_chrom, room_confidence)
    new_chrom = _enforce_boundary(new_chrom)

    try:
        new_chrom.fitness = evaluate_chromosome(new_chrom, {
            "plot_w": new_chrom.plot_w,
            "plot_h": new_chrom.plot_h,
            "plot_area_sqm": max(45.0, new_chrom.plot_w * new_chrom.plot_h),
        })
    except Exception:
        # Keep previous fitness if quick recompute context is incomplete.
        pass

    return new_chrom


def _resolve_overlaps(chrom: Chromosome, room_confidence: Optional[Dict[str, float]] = None) -> Chromosome:
    """
    Push-apart overlap resolution with at most 20 passes.
    """
    room_confidence = room_confidence or {}
    rooms = list(getattr(chrom, "rooms", []) or [])

    for _ in range(20):
        any_overlap = False
        for i, a in enumerate(rooms):
            for j, b in enumerate(rooms):
                if i >= j:
                    continue
                if int(getattr(a, "floor", 1) or 1) != int(getattr(b, "floor", 1) or 1):
                    continue
                overlap = rooms_overlap(a, b)
                if overlap <= 1e-9:
                    continue

                any_overlap = True
                conf_a = room_confidence.get(str(getattr(a, "id", "")), 0.5)
                conf_b = room_confidence.get(str(getattr(b, "id", "")), 0.5)
                moving = a if conf_a < conf_b else b
                fixed = b if moving is a else a

                ox = max(0.0, min(a.x + a.width, b.x + b.width) - max(a.x, b.x))
                oy = max(0.0, min(a.y + a.height, b.y + b.height) - max(a.y, b.y))

                ax = a.x + a.width * 0.5
                ay = a.y + a.height * 0.5
                bx = b.x + b.width * 0.5
                by = b.y + b.height * 0.5

                if ox <= oy:
                    shift = ox + 0.1
                    if ax >= bx:
                        direction = 1.0 if moving is a else -1.0
                    else:
                        direction = -1.0 if moving is a else 1.0
                    moving.x += shift * direction
                else:
                    shift = oy + 0.1
                    if ay >= by:
                        direction = 1.0 if moving is a else -1.0
                    else:
                        direction = -1.0 if moving is a else 1.0
                    moving.y += shift * direction

                _ = fixed

        chrom = _enforce_boundary(chrom)
        if not any_overlap:
            break
    else:
        logger.warning("overlap resolution reached pass limit (20) and residual overlap may remain")

    return chrom


def _enforce_boundary(chrom: Chromosome) -> Chromosome:
    """Clamp all rooms inside plot boundary with 0.15m margin."""
    margin = 0.15
    plot_w = _safe_float(getattr(chrom, "plot_w", 0.0), 0.0)
    plot_h = _safe_float(getattr(chrom, "plot_h", 0.0), 0.0)

    for room in list(getattr(chrom, "rooms", []) or []):
        room.x = max(margin, min(plot_w - room.width - margin, room.x))
        room.y = max(margin, min(plot_h - room.height - margin, room.y))

    return chrom


def warm_start_ga(seed_chromosome: Chromosome, env: dict, elite_fraction: float = 0.50) -> Chromosome:
    """
    Run a reduced GA seeded with seed_chromosome as initial elite.
    """
    elite = max(0.1, min(0.9, float(elite_fraction)))
    env_with_seed = {
        **env,
        "_warm_seed": encode_rooms_to_vector(seed_chromosome.rooms, env),
        "_warm_elite_fraction": elite,
        "_max_generations": 30,
    }
    deterministic_seed = hash(str([(r.id, r.x, r.y, r.width, r.height, r.floor) for r in seed_chromosome.rooms])) % 10000
    return run_nsga3(env_with_seed, seed=deterministic_seed)


def run_correction_loop(
    initial_chromosome: Chromosome,
    env: dict,
    max_iterations: int = MAX_ITERATIONS,
    target_score: float = TARGET_SCORE,
) -> IterationHistory:
    """
    Main iterative correction loop.
    """
    start_time = time.perf_counter()
    stop_event = threading.Event()
    watchdog = threading.Timer(HARD_TIMEOUT_SEC, stop_event.set)
    watchdog.daemon = True
    watchdog.start()

    snapshots: List[IterationSnapshot] = []
    eco_score_curve: List[float] = []
    cumulative_fixes: List[str] = []

    best_chromosome = copy.deepcopy(initial_chromosome)
    best_score = -1.0
    best_audit: Optional[EcoAuditReport] = None

    current_chromosome = copy.deepcopy(initial_chromosome)
    current_chromosome.windows = _windows_for_chromosome(current_chromosome, env)

    convergence_reason = "max_iterations"
    converged = False
    reorient_cooldown = 0

    try:
        for iteration in range(max_iterations + 1):
            iter_start = time.perf_counter()

            if stop_event.is_set():
                convergence_reason = "hard_timeout"
                break

            current_chromosome.windows = _windows_for_chromosome(current_chromosome, env)
            walls = _generate_walls(current_chromosome.rooms)
            doors = _generate_doors(current_chromosome.rooms)
            windows = list(current_chromosome.windows or [])

            audit = run_eco_audit(
                variant_id=iteration,
                algorithm=str(getattr(current_chromosome, "algorithm", "NSGA-III")),
                rooms=current_chromosome.rooms,
                walls=walls,
                doors=doors,
                windows=windows,
                env=env,
            )

            eco_score = float(audit.composite_eco_score)

            def append_terminal_snapshot() -> None:
                if snapshots and int(snapshots[-1].iteration) == int(iteration):
                    return
                snapshots.append(
                    IterationSnapshot(
                        iteration=iteration,
                        chromosome=copy.deepcopy(current_chromosome),
                        audit=audit,
                        correction=None,
                        cumulative_fixes=list(cumulative_fixes),
                        runtime_ms=int((time.perf_counter() - iter_start) * 1000),
                    )
                )
                eco_score_curve.append(eco_score)

            if eco_score > best_score:
                best_score = eco_score
                best_chromosome = copy.deepcopy(current_chromosome)
                best_audit = audit

            if iteration == 0 and not snapshots:
                snapshots.append(
                    IterationSnapshot(
                        iteration=0,
                        chromosome=copy.deepcopy(current_chromosome),
                        audit=audit,
                        correction=None,
                        cumulative_fixes=list(cumulative_fixes),
                        runtime_ms=int((time.perf_counter() - iter_start) * 1000),
                    )
                )
                eco_score_curve.append(eco_score)

            if bool(audit.overall_passed) and int(audit.n_criteria_failed) == 0:
                convergence_reason = "all_criteria_passed"
                converged = True
                append_terminal_snapshot()
                break

            if eco_score >= target_score:
                convergence_reason = "score_target_reached"
                converged = True
                append_terminal_snapshot()
                break

            if iteration == max_iterations:
                append_terminal_snapshot()
                break

            if _stagnated(eco_score_curve):
                convergence_reason = "stagnation"
                append_terminal_snapshot()
                break

            failed = [criterion for criterion in audit.criteria if not bool(criterion.passed)]
            failed_sorted = _criteria_sorted_for_iteration(failed, iteration)
            failed_sorted = failed_sorted[:4]

            all_mutations: List[RoomMutation] = []
            criteria_targeted: List[int] = []
            env_iteration = dict(env)
            env_iteration["_strategy1_applied"] = False
            env_iteration["_reorient_cooldown_active"] = reorient_cooldown > 0

            for criterion_result in failed_sorted:
                cid = int(criterion_result.criterion_id)
                strategy_fn = STRATEGY_MAP.get(cid)
                if strategy_fn is None:
                    continue
                try:
                    mutations = strategy_fn(current_chromosome, criterion_result, env_iteration)
                except Exception as exc:
                    cumulative_fixes.append(f"[Iter {iteration + 1}] C{cid} strategy error: {exc}")
                    continue

                if mutations:
                    criteria_targeted.append(cid)
                if cid == 1 and any(m.mutation_type in {"reorient", "rotate"} for m in mutations):
                    env_iteration["_strategy1_applied"] = True

                for mutation in mutations:
                    all_mutations.append(mutation)
                    cumulative_fixes.append(f"[Iter {iteration + 1}] C{cid}: {mutation.reason}")

            if not all_mutations:
                convergence_reason = "no_mutations_available"
                converged = True
                append_terminal_snapshot()
                break

            all_mutations = _resolve_mutation_conflicts(all_mutations)
            all_mutations, dropped_reorients = _apply_reorient_cooldown(all_mutations, reorient_cooldown)
            if dropped_reorients > 0:
                cumulative_fixes.append(
                    f"[Iter {iteration + 1}] Reorient cooldown active: skipped {dropped_reorients} rotation mutation(s)."
                )

            if not all_mutations:
                convergence_reason = "no_mutations_available"
                append_terminal_snapshot()
                break

            corrected = apply_mutations(current_chromosome, all_mutations)

            if stop_event.is_set():
                refined = corrected
            else:
                try:
                    refined = warm_start_ga(corrected, env_iteration)
                    refined.windows = generate_windows(refined.rooms, env_iteration)
                    refined_annotations = getattr(corrected, "eco_annotations", None)
                    if isinstance(refined_annotations, dict):
                        setattr(refined, "eco_annotations", dict(refined_annotations))
                    window_ops = [m for m in all_mutations if m.mutation_type in {"add_window", "remove_window"}]
                    if window_ops:
                        refined = apply_mutations(refined, window_ops)
                except Exception as exc:
                    logger.warning("warm-start GA failed, using corrected chromosome directly: %s", exc)
                    refined = corrected

            refined.windows = _windows_for_chromosome(refined, env_iteration)
            new_audit = run_eco_audit(
                variant_id=iteration + 1,
                algorithm=str(getattr(refined, "algorithm", getattr(current_chromosome, "algorithm", "NSGA-III"))),
                rooms=refined.rooms,
                walls=_generate_walls(refined.rooms),
                doors=_generate_doors(refined.rooms),
                windows=list(refined.windows or []),
                env=env_iteration,
            )
            new_score = float(new_audit.composite_eco_score)

            improvement = new_score - eco_score
            chosen_chromosome = refined
            chosen_audit = new_audit
            chosen_score = new_score
            chosen_mutations = all_mutations

            if improvement < 0.5 and not stop_event.is_set():
                scaled = [_scale_mutation(mutation, 0.5) for mutation in all_mutations]
                retry_corrected = apply_mutations(current_chromosome, scaled)
                try:
                    retry_refined = warm_start_ga(retry_corrected, env_iteration)
                    retry_refined.windows = generate_windows(retry_refined.rooms, env_iteration)
                    retry_window_ops = [m for m in scaled if m.mutation_type in {"add_window", "remove_window"}]
                    if retry_window_ops:
                        retry_refined = apply_mutations(retry_refined, retry_window_ops)
                except Exception:
                    retry_refined = retry_corrected

                retry_refined.windows = _windows_for_chromosome(retry_refined, env_iteration)
                retry_audit = run_eco_audit(
                    variant_id=iteration + 1,
                    algorithm=str(getattr(retry_refined, "algorithm", getattr(current_chromosome, "algorithm", "NSGA-III"))),
                    rooms=retry_refined.rooms,
                    walls=_generate_walls(retry_refined.rooms),
                    doors=_generate_doors(retry_refined.rooms),
                    windows=list(retry_refined.windows or []),
                    env=env_iteration,
                )
                retry_score = float(retry_audit.composite_eco_score)

                if retry_score >= chosen_score:
                    chosen_chromosome = retry_refined
                    chosen_audit = retry_audit
                    chosen_score = retry_score
                    chosen_mutations = scaled

            if chosen_score >= eco_score:
                current_chromosome = chosen_chromosome
                accepted_chromosome = copy.deepcopy(chosen_chromosome)
                accepted_audit = chosen_audit
                accepted_score = chosen_score
            else:
                cumulative_fixes.append(
                    f"[Iter {iteration + 1}] No score gain after retry; retaining previous iteration geometry."
                )
                accepted_chromosome = copy.deepcopy(current_chromosome)
                accepted_audit = audit
                accepted_score = eco_score

            if accepted_score > best_score:
                best_score = accepted_score
                best_chromosome = copy.deepcopy(accepted_chromosome)
                best_audit = accepted_audit

            current_delta = accepted_score - eco_score
            snapshot = IterationSnapshot(
                iteration=iteration + 1,
                chromosome=copy.deepcopy(accepted_chromosome),
                audit=accepted_audit,
                correction=CorrectionResult(
                    iteration=iteration + 1,
                    mutations_applied=chosen_mutations,
                    n_mutations=len(chosen_mutations),
                    criteria_targeted=criteria_targeted,
                    eco_score_before=eco_score,
                    eco_score_after=accepted_score,
                    score_delta=current_delta,
                    improvement=current_delta > 0.0,
                    audit_after=accepted_audit,
                ),
                cumulative_fixes=list(cumulative_fixes),
                runtime_ms=int((time.perf_counter() - iter_start) * 1000),
            )
            snapshots.append(snapshot)
            eco_score_curve.append(accepted_score)

            if any(mutation.mutation_type in {"reorient", "rotate"} for mutation in all_mutations):
                reorient_cooldown = 2
            elif reorient_cooldown > 0:
                reorient_cooldown -= 1

            if stop_event.is_set():
                convergence_reason = "hard_timeout"
                break

    except Exception as exc:
        convergence_reason = "exception"
        logger.exception("correction loop failed: %s", exc)

    finally:
        watchdog.cancel()

    if best_audit is None:
        best_chromosome.windows = _windows_for_chromosome(best_chromosome, env)
        best_audit = run_eco_audit(
            variant_id=9997,
            algorithm=str(getattr(best_chromosome, "algorithm", "NSGA-III")),
            rooms=best_chromosome.rooms,
            walls=_generate_walls(best_chromosome.rooms),
            doors=_generate_doors(best_chromosome.rooms),
            windows=list(best_chromosome.windows or []),
            env=env,
        )
        best_score = float(best_audit.composite_eco_score)

    final_chromosome = copy.deepcopy(best_chromosome)
    final_chromosome.windows = _windows_for_chromosome(final_chromosome, env)

    final_audit = run_eco_audit(
        variant_id=9999,
        algorithm=str(getattr(final_chromosome, "algorithm", "NSGA-III")),
        rooms=final_chromosome.rooms,
        walls=_generate_walls(final_chromosome.rooms),
        doors=_generate_doors(final_chromosome.rooms),
        windows=list(final_chromosome.windows or []),
        env=env,
    )

    initial_score = eco_score_curve[0] if eco_score_curve else float(final_audit.composite_eco_score)

    return IterationHistory(
        plot_id=str(env.get("plot_id", "UNKNOWN")),
        total_iterations=len(snapshots),
        converged=converged,
        convergence_reason=convergence_reason,
        initial_eco_score=float(initial_score),
        final_eco_score=float(best_score),
        total_improvement=float(best_score - initial_score),
        snapshots=snapshots,
        final_chromosome=final_chromosome,
        final_audit=final_audit,
        total_runtime_ms=int((time.perf_counter() - start_time) * 1000),
        eco_score_curve=[float(score) for score in eco_score_curve],
        corrections_applied=list(cumulative_fixes),
    )


def _generate_walls(rooms: List[Room]) -> List[dict]:
    return list(generate_walls(rooms))


def _generate_doors(rooms: List[Room]) -> List[dict]:
    return list(generate_doors(rooms))
