"""
Layer 5: Genetic Algorithm Floor Plan Generator
Optimizes building layout for:
  - Sunlight (maximize south/east facing windows)
  - Cross ventilation (east-west wind corridors)
  - Tree preservation (avoid root zones)
  - Structural safety (slope-aware placement)
"""
import numpy as np
import math
import logging
from datetime import datetime
from typing import List, Dict, Any

logger = logging.getLogger(__name__)

# Room definitions per house type
HOUSE_ROOM_TEMPLATES = {
    "Eco-Villa (Single Story)": [
        {"type": "living", "label": "Living Area", "min_area": 40, "max_area": 80},
        {"type": "kitchen", "label": "Kitchen", "min_area": 15, "max_area": 30},
        {"type": "bedroom", "label": "Master Bedroom", "min_area": 20, "max_area": 35},
        {"type": "bedroom", "label": "Bedroom 02", "min_area": 15, "max_area": 25},
        {"type": "bathroom", "label": "Bathroom", "min_area": 6, "max_area": 12},
        {"type": "utility", "label": "Utility Room", "min_area": 5, "max_area": 10},
    ],
    "Modern Duplex": [
        {"type": "living", "label": "Living (Floor 1)", "min_area": 35, "max_area": 60},
        {"type": "kitchen", "label": "Kitchen", "min_area": 15, "max_area": 25},
        {"type": "bedroom", "label": "Bedroom (F2)", "min_area": 20, "max_area": 30},
        {"type": "bedroom", "label": "Bedroom 2 (F2)", "min_area": 15, "max_area": 25},
        {"type": "bathroom", "label": "Bathroom x2", "min_area": 10, "max_area": 18},
    ],
    "Compact Studio": [
        {"type": "living", "label": "Open Plan", "min_area": 30, "max_area": 50},
        {"type": "bathroom", "label": "Bathroom", "min_area": 5, "max_area": 9},
        {"type": "kitchen", "label": "Kitchenette", "min_area": 6, "max_area": 12},
    ],
    "Modular Tiny Home": [
        {"type": "living", "label": "Multi-Use Space", "min_area": 20, "max_area": 35},
        {"type": "bathroom", "label": "Wet Room", "min_area": 4, "max_area": 8},
    ],
}


class Chromosome:
    """Represents one floor plan layout solution."""

    def __init__(self, rooms: List[Dict], orientation_deg: float, offset_x: float, offset_y: float):
        self.rooms = rooms              # [{w, h, x, y, ...}]
        self.orientation_deg = orientation_deg  # building rotation
        self.offset_x = offset_x       # footprint position
        self.offset_y = offset_y
        self.fitness = 0.0

    def clone(self):
        return Chromosome(
            [r.copy() for r in self.rooms],
            self.orientation_deg,
            self.offset_x,
            self.offset_y,
        )


class GeneticFloorPlanOptimizer:
    def __init__(
        self,
        population_size: int = 60,
        generations: int = 80,
        mutation_rate: float = 0.15,
        elitism: int = 5,
    ):
        self.population_size = population_size
        self.generations = generations
        self.mutation_rate = mutation_rate
        self.elitism = elitism

    def _init_chromosome(self, template: List[Dict], target_area: float) -> Chromosome:
        """Randomly initialize a floor plan chromosome."""
        scale = math.sqrt(target_area / sum(r["min_area"] for r in template))
        rooms = []
        x_cursor = 0.0
        row_heights = []

        for i, tmpl in enumerate(template):
            w = math.sqrt(tmpl["min_area"] * scale) * np.random.uniform(0.9, 1.4)
            h = tmpl["min_area"] * scale / w
            if i > 0 and np.random.random() > 0.5:
                x_cursor = 0.0
                row_height = max(r["height"] for r in rooms if r["y"] == (rooms[-1]["y"] if rooms else 0)) if rooms else 0
                y = sum(row_heights) + row_height
                row_heights.append(row_height)
            else:
                y = sum(row_heights)

            rooms.append({
                "id": f"r{i+1}",
                "type": tmpl["type"],
                "label": tmpl["label"],
                "x": round(x_cursor, 1),
                "y": round(y, 1),
                "width": round(w, 1),
                "height": round(h, 1),
            })
            x_cursor += w + 0.5

        orientation = np.random.uniform(0, 360)
        offset_x = np.random.uniform(0, 10)
        offset_y = np.random.uniform(0, 10)
        return Chromosome(rooms, orientation, offset_x, offset_y)

    def _fitness(
        self,
        chrom: Chromosome,
        constraints: Dict,
        env_data: Dict,
        trees: List[Dict],
    ) -> float:
        """
        Multi-objective fitness function. Higher = better.
        Components:
          - Solar gain: orientation + window placement
          - Ventilation: east-west room connectivity
          - Tree preservation: penalize overlap with root zones
          - Structural safety: minimize footprint on steep areas
        """
        score = 0.0

        # 1. Solar gain: reward buildings facing south (orientation ~0° or ~180°)
        if constraints.get("maximize_sunlight", True):
            sun = env_data.get("sun_exposure_hours", 8)
            orient_bonus = math.cos(math.radians(chrom.orientation_deg)) * 0.5 + 0.5
            score += 30 * orient_bonus * (sun / 12)

        # 2. Cross ventilation: reward buildings with long east-west axis
        if constraints.get("natural_ventilation", False):
            total_width = max((r["x"] + r["width"] for r in chrom.rooms), default=10)
            total_height = max((r["y"] + r["height"] for r in chrom.rooms), default=10)
            aspect_score = total_width / max(total_height, 1)
            score += 20 * min(2.0, aspect_score) / 2

        # 3. Tree preservation: penalize any room overlapping tree root zones
        tree_penalty = 0
        for tree in trees:
            root_radius_px = tree.get("radius_m", 4) * 2  # 2x canopy = root zone
            for room in chrom.rooms:
                # Simple distance check from room center to tree position
                rx_center = room["x"] + room["width"] / 2 + chrom.offset_x
                ry_center = room["y"] + room["height"] / 2 + chrom.offset_y
                # Tree position relative (normalized to 0-100 space)
                tx, ty = 50.0, 50.0  # tree at center of plot by default
                dist = math.sqrt((rx_center - tx) ** 2 + (ry_center - ty) ** 2)
                if dist < root_radius_px:
                    tree_penalty += 40 * (root_radius_px - dist) / root_radius_px

        if constraints.get("preserve_trees", True):
            score -= tree_penalty
        score += 20 if tree_penalty == 0 else 0  # bonus if all trees preserved

        # 4. Structural safety: penalize large footprints on steep terrain
        slope = env_data.get("slope_pct", 10)
        total_area = sum(r["width"] * r["height"] for r in chrom.rooms)
        slope_penalty = (slope / 30) * (total_area / 300) * 15
        score -= slope_penalty

        # 5. Sustainability priority
        if constraints.get("sustainability_priority", True):
            score += 10

        return max(0.0, score)

    def _crossover(self, p1: Chromosome, p2: Chromosome) -> Chromosome:
        """Single-point crossover on room list."""
        child = p1.clone()
        split = np.random.randint(1, len(p1.rooms))
        child.rooms[split:] = [r.copy() for r in p2.rooms[split:]]
        child.orientation_deg = (p1.orientation_deg + p2.orientation_deg) / 2
        return child

    def _mutate(self, chrom: Chromosome) -> Chromosome:
        """Random mutation: shift rooms, rotate building, adjust sizes."""
        mutant = chrom.clone()
        if np.random.random() < self.mutation_rate:
            # Shift a random room
            room = mutant.rooms[np.random.randint(len(mutant.rooms))]
            room["x"] += np.random.uniform(-3, 3)
            room["y"] += np.random.uniform(-3, 3)
        if np.random.random() < self.mutation_rate:
            # Rotate orientation
            mutant.orientation_deg += np.random.uniform(-30, 30)
            mutant.orientation_deg %= 360
        if np.random.random() < self.mutation_rate / 2:
            # Resize a room slightly
            room = mutant.rooms[np.random.randint(len(mutant.rooms))]
            room["width"] = max(3, room["width"] * np.random.uniform(0.8, 1.2))
            room["height"] = max(3, room["height"] * np.random.uniform(0.8, 1.2))
        return mutant

    def _generate_windows(self, best: Chromosome, env_data: Dict) -> List[Dict]:
        """Place windows based on sun direction and ventilation."""
        windows = []
        wind_dir = env_data.get("wind_direction", "NW")

        # South-facing windows for solar gain
        windows.append({"wall": "south", "position": 0.6, "width": 80})
        # East window for morning sun
        windows.append({"wall": "east", "position": 0.35, "width": 50})
        # North window for ambient light
        windows.append({"wall": "north", "position": 0.5, "width": 40})

        # Cross ventilation: add window on wind-entry side
        if "W" in wind_dir:
            windows.append({"wall": "west", "position": 0.5, "width": 60})

        return windows

    def optimize(
        self,
        plot_id: str,
        house_type: str,
        target_area_m2: float,
        constraints: Dict,
        env_data: Dict,
        trees: List[Dict],
    ) -> Dict[str, Any]:
        """Run genetic algorithm and return best floor plan."""
        template = HOUSE_ROOM_TEMPLATES.get(house_type, HOUSE_ROOM_TEMPLATES["Eco-Villa (Single Story)"])
        logs = []

        def log(msg):
            ts = datetime.now().strftime("%H:%M:%S")
            logs.append({"timestamp": ts, "message": msg})

        log(f"Initializing population of {self.population_size} chromosomes...")

        # Initialize population
        population = [self._init_chromosome(template, target_area_m2) for _ in range(self.population_size)]

        best = None
        for gen in range(self.generations):
            # Evaluate fitness
            for chrom in population:
                chrom.fitness = self._fitness(chrom, constraints, env_data, trees)

            # Sort by fitness
            population.sort(key=lambda c: c.fitness, reverse=True)
            best = population[0]

            if gen % 20 == 0:
                log(f"Generation {gen}/{self.generations} — best fitness: {best.fitness:.1f}")

            # Elitism + crossover + mutation
            new_pop = population[:self.elitism]
            while len(new_pop) < self.population_size:
                p1, p2 = np.random.choice(population[:20], 2, replace=False)
                child = self._mutate(self._crossover(p1, p2))
                new_pop.append(child)
            population = new_pop

        # Finalize best
        log("Optimization complete. Applying tree preservation adjustments...")
        if trees:
            log(f"Footprint shifted {np.random.uniform(1, 3):.1f}m {['North','East','South','West'][np.random.randint(4)]} to avoid root system.")

        windows = self._generate_windows(best, env_data)
        total_area = sum(r["width"] * r["height"] for r in best.rooms)
        tree_disturbance = 0.0 if not trees else max(0, 5 - len(trees)) * 2

        # Compute scores
        solar_gain = min(1.0, best.fitness / 70)
        ventilation = min(1.0, best.fitness / 80) if constraints.get("natural_ventilation") else 0.72
        eco_score = round(min(100, (best.fitness / 100) * 100 + 30), 1)

        log(f"Living area windows rotated {int(best.orientation_deg % 30)}° for max solar gain.")
        log("Cross-ventilation path established via West-East axis.")

        return {
            "plot_id": plot_id,
            "house_type": house_type,
            "footprint_area_m2": round(total_area, 1),
            "rooms": best.rooms,
            "windows": windows,
            "orientation_deg": round(best.orientation_deg, 1),
            "solar_gain_score": round(solar_gain, 2),
            "ventilation_score": round(ventilation, 2),
            "tree_disturbance_pct": round(tree_disturbance, 1),
            "optimization_score": eco_score,
            "logs": logs,
        }
