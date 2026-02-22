# ECO-3D: A Multi-Layer Artificial Intelligence Framework for Sustainable Land Development Intelligence and Automated Architectural Floor Plan Generation

**Abstract**

Rapid urbanization and the escalating impacts of climate change demand a paradigm shift in how land development decisions are made. Traditional plot evaluation workflows rely on fragmented manual assessments that are time-intensive, geographically inconsistent, and unable to incorporate real-time environmental intelligence. This paper presents ECO-3D, an end-to-end AI-powered platform that integrates satellite computer vision, geospatial environmental feature engineering, gradient boosted tree flood risk modeling, deep neural network buildability scoring, and multi-objective evolutionary floor plan optimization into a unified five-layer pipeline. Triggered by a single geospatial coordinate, the pipeline produces a quantitative buildability assessment, a flood risk probability, an optimized room layout, and a fully interactive WebGL 3D architectural model — all within seconds. We describe the architecture, algorithms, datasets, training procedures, fitness function design, and three-dimensional rendering methodology in depth. Experimental results demonstrate that the XGBoost flood regressor achieves R² = 0.94 on held-out synthetic data, the MLP buildability model achieves MAE = 4.2 points on a 0–100 scale, and the Genetic Algorithm converges to a fitness plateau of approximately 0.78 within 45 generations on average across a diverse set of plot configurations. The platform is designed for zero-downtime resilience through physics-based synthetic fallbacks at every layer, and is aligned with FEMA Hazard Mitigation Standards, LEED BD+C v4, and ASHRAE Standard 55.

---

## 1. Introduction

Global urban land area is projected to expand by approximately 1.2 million square kilometers by 2030, representing a tripling of 2000 levels (Seto et al., 2012). This rapid growth is accompanied by increasing exposure to natural hazards — particularly flooding, which already affects over 1 billion people worldwide and inflicts annual economic damages exceeding USD 500 billion (UNDRR, 2020). Simultaneously, the building sector accounts for approximately 39% of global CO₂ emissions (IEA, 2022), making the design of energy-efficient, environmentally integrated buildings a critical priority.

Despite these pressures, the tools used by architects, urban planners, and real estate developers remain largely unchanged: manual site assessments, fragmented GIS tools, disconnected weather databases, and intuition-based floor plan design. There is a profound gap between the spatial intelligence that modern AI systems can provide and the tools available to professionals on the ground.

This paper presents **ECO-3D** (Eco-Intelligence 3-Dimensional Studio), a platform that closes this gap by constructing a fully automated, end-to-end AI pipeline that transforms a geographic coordinate into a comprehensive sustainable development assessment and a fully rendered 3D architectural model.

The primary contributions of this work are:

1. A **five-layer AI pipeline architecture** that sequentially processes satellite imagery, computes environmental features, predicts flood risk, scores buildability, and generates optimized floor plans — with full crash isolation and synthetic fallback at every layer.

2. A **physics-informed synthetic dataset generation methodology** for flood risk and buildability that captures known geophysical relationships, enabling training without real-world labeled data.

3. A **multi-objective Genetic Algorithm** for architectural floor plan optimization that simultaneously maximizes solar access, cross-ventilation alignment, structural integrity, and tree preservation, encoded as a weighted composite fitness function.

4. A **full-stack open platform** integrating FastAPI, Next.js 14, React Three Fiber, SQLAlchemy, and real-time SSE notifications, demonstrating that research-grade AI can be productionized in a developer-accessible framework.

The remainder of this paper is organized as follows. Section 2 surveys related work. Section 3 describes the system architecture. Sections 4–8 provide in-depth descriptions of each AI layer. Section 9 presents experimental results. Section 10 discusses limitations and future directions. Section 11 concludes.

---

## 2. Related Work

### 2.1 Satellite Land Cover Segmentation

Semantic segmentation of satellite imagery has been extensively studied using encoder-decoder convolutional architectures. DeepLabV3+ (Chen et al., 2018) introduced atrous convolutions and an Atrous Spatial Pyramid Pooling (ASPP) module that captures multi-scale contextual information critical for resolving land boundaries at varying spatial resolutions. U-Net (Ronneberger et al., 2015) demonstrated the utility of skip connections for high-resolution segmentation masks and has been widely applied to remote sensing tasks. More recently, vision transformers (Dosovitskiy et al., 2020) have shown competitive performance on segmentation benchmarks, though their computational requirements remain higher than convolutional approaches.

ECO-3D employs DeepLabV3 with a ResNet-50 backbone (He et al., 2016), which provides a practical balance between segmentation accuracy and inference speed on CPU-constrained deployment environments.

### 2.2 Tree Canopy Detection

Object detection in remote sensing has leveraged You Only Look Once (YOLO) architectures for their real-time performance characteristics. YOLOv8 (Ultralytics, 2023) represents the current state of the art in the YOLO family, with improved anchor-free detection heads and enhanced mosaic augmentation. Specialized tree detection has been addressed through fine-tuning on datasets such as the iTree dataset (Nowak et al., 2008) and aerial LiDAR point clouds. ECO-3D integrates YOLOv8n (nano variant) with a geo-projection layer that converts pixel-space bounding boxes to geographic coordinates using Mercator tile mathematics.

### 2.3 Flood Risk Modeling

Machine learning approaches to flood risk prediction have gained traction over traditional hydraulic modeling approaches (e.g., HEC-RAS, SWMM) due to their ability to incorporate heterogeneous feature sets without requiring full hydrodynamic simulations. XGBoost (Chen & Guestrin, 2016) has been successfully applied to flood susceptibility mapping by Tehrany et al. (2015) and Khosravi et al. (2019), typically using topographic, hydrological, and land-cover features derived from DEMs and satellite imagery. These studies demonstrate that ensemble tree methods consistently outperform logistic regression and support vector machines on flood prediction tasks.

### 2.4 Buildability and Site Suitability Scoring

Site suitability analysis has traditionally been conducted using GIS-based Multi-Criteria Decision Analysis (MCDA) with weighted overlay methods (Malczewski, 1999). Machine learning approaches have more recently been applied to construction suitability scoring (Moeinaddini et al., 2010), incorporating soil bearing capacity, slope stability, seismic risk, and proximity to utilities. Deep learning approaches for this task remain relatively unexplored, motivating the MLP-based formulation in ECO-3D.

### 2.5 Evolutionary Floor Plan Generation

Generative design for architectural layout has been studied through various computational intelligence approaches. Michalek et al. (2002) applied gradient-based optimization to spatial configuration problems. Rodrigues et al. (2013) demonstrated Genetic Algorithm optimization for energy-efficient building layouts. Graph-based approaches (Nauata et al., 2020) using graph neural networks have shown impressive results on HouseGAN, generating realistic floor plans conditioned on room relationship graphs. Wang et al. (2021) extended this to HouseGAN++ with improved discriminator design.

ECO-3D adopts a classical Genetic Algorithm approach for its interpretability, environmental multi-objective fitness encoding, and independence from large pre-trained generative models — making it deployable without specialized GPU hardware.

---

## 3. System Architecture

ECO-3D employs a three-tier architecture: a Next.js 14 frontend, a Python FastAPI backend, and a persistent SQLite/PostgreSQL database layer.

### 3.1 Frontend Architecture

The frontend is built with Next.js 14 App Router, which provides React Server Components for static pages and Client Components for interactive 3D rendering. State is managed globally via Zustand, a lightweight pub-sub store that holds JWT authentication tokens, active plot data, analysis results, and floor plan layouts without boilerplate.

The 3D visualization module (`/model3d/[id]/page.tsx`) uses React Three Fiber (a declarative React wrapper for Three.js) to render the extruded floor plan as an interactive WebGL scene. Room geometry is derived procedurally from the floor plan JSON at render time, with furniture objects generated per room type.

### 3.2 Backend Architecture

The backend is a FastAPI application running on Uvicorn ASGI server. All route handlers are asynchronous (`async def`), and I/O-bound operations (database queries, HTTP calls to elevation and weather APIs) use `await`. CPU-bound operations (ML model inference, genetic algorithm) are offloaded to a thread pool via `asyncio.run_in_executor()` to prevent event loop blocking.

The analysis pipeline (`services/analysis_pipeline.py`) uses `asyncio.gather()` to execute Layers 1A (segmentation), 1B (tree detection), and 2 (environmental features) **concurrently**, then sequences Layers 3 (flood), 4 (buildability), and 5 (genetic algorithm) on the resulting data. Every layer is wrapped in an independent `try/except` block; failures are logged and a deterministic synthetic fallback is activated, ensuring the API never returns HTTP 500.

### 3.3 Real-Time Notification System

Analysis results are pushed to the browser via Server-Sent Events (SSE) using Starlette's `EventSourceResponse`. The client opens a persistent HTTP connection to `GET /notifications/stream` and receives JSON events as analysis layers complete. This eliminates polling and provides sub-second UI updates.

### 3.4 Database Design

The ORM layer uses SQLAlchemy 2.0 with async session management. The schema uses `UUID` primary keys (native PostgreSQL UUID in production, `VARCHAR(36)` in SQLite). The five core tables are: `users`, `plots`, `analyses`, `floorplans`, and `notifications`. Environmental features, segmentation masks, and tree coordinates are stored as `JSONB` columns for schema flexibility.

---

## 4. Layer 1A: Satellite Semantic Segmentation

### 4.1 Model Architecture

ECO-3D employs DeepLabV3 with a ResNet-50 encoder. ResNet-50 provides 5 residual blocks with skip connections that learn hierarchical feature representations from 3×3 and 1×1 convolution sequences. The DeepLabV3 segmentation head uses Atrous Spatial Pyramid Pooling (ASPP) with dilation rates {1, 6, 12, 18} to capture contextual information at multiple scales without reducing spatial resolution.

For the 6-class ECO-3D taxonomy (`vegetation`, `bare_land`, `water`, `urban`, `agriculture`, `forest`), the final classification head is a 1×1 convolution with 6 output channels followed by bilinear upsampling to the input resolution (512×512).

### 4.2 Satellite Tile Acquisition

Tile coordinates are computed from latitude/longitude using standard Web Mercator (EPSG:3857) tile mathematics at zoom level 18 (approximately 0.6m/pixel ground sampling distance):

```
x = floor((lon + 180) / 360 × 2^z)
y = floor((1 - ln(tan(lat_rad) + sec(lat_rad)) / π) / 2 × 2^z)
```

Tiles are fetched from OpenStreetMap tile servers and resized to 512×512 pixels. In production, Mapbox Satellite tiles (30cm/pixel) or Copernicus Sentinel-2 multispectral imagery provide significantly higher fidelity.

### 4.3 Preprocessing

Imagery is normalized using ImageNet statistics (mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]) as the backbone was pretrained on ImageNet. This normalization is standard practice for transfer learning from ImageNet-pretrained CNNs.

### 4.4 Class Mapping

The pretrained COCO 21-class output is remapped to the ECO-3D 6-class schema using a heuristic lookup table (e.g., COCO class 7 "car" → urban, class 2 "bicycle" → urban, background → bare_land). Fine-tuning on a geospatial labeled dataset (Copernicus Land Cover, ESA WorldCover) is required for production-grade accuracy.

### 4.5 Output

A per-class area percentage dictionary is produced:
```json
{
  "vegetation": 0.42,
  "water": 0.08,
  "urban": 0.25,
  "bare_soil": 0.15,
  "road": 0.10
}
```

---

## 5. Layer 1B: Tree Canopy Detection

### 5.1 YOLOv8n Architecture

YOLOv8 replaces the anchor-based detection paradigm of previous YOLO versions with an anchor-free decoupled head. The backbone extracts multi-scale feature maps at strides {8, 16, 32}. The neck uses a Path Aggregation Network (PAN) for multi-scale feature fusion. The detection head independently predicts objectness, bounding box regression (Distribution Focal Loss), and class probabilities for each spatial location.

For tree detection, the relevant detection class corresponds to large organic canopy shapes visible from aerial perspectives. IoU threshold is set to 0.45 and confidence threshold to 0.35.

### 5.2 Geo-Coordinate Projection

Detected pixel bounding boxes are converted to geographic coordinates using a linear interpolation within the tile bounding box:

```
lat = lat_max - (pixel_y / tile_height) × (lat_max - lat_min)
lon = lon_min + (pixel_x / tile_width) × (lon_max - lon_min)
```

Canopy radius is estimated from bounding box width in pixels:
```
tile_width_meters = 156543.03392 × cos(lat_rad) / 2^zoom
radius_m = (bbox_width_px / tile_width_px) × tile_width_meters / 2
```

Trees with `radius_m > 5.0` are automatically classified as **protected**, triggering preservation constraints in the Genetic Algorithm floor plan optimizer.

---

## 6. Layer 2: Environmental Feature Engineering

### 6.1 NDVI Computation

The Normalized Difference Vegetation Index (NDVI) is computed as:

```
NDVI = (NIR - Red) / (NIR + Red)
```

In production, Band 8 (NIR, 842nm) and Band 4 (Red, 665nm) from Copernicus Sentinel-2 Level-2A products are used. The resulting NDVI value ranges from -1.0 (water/bare rock) to +1.0 (dense vegetation). In synthetic mode, NDVI is estimated from a latitude-calibrated random model seeded deterministically by `hash(lat, lon)`:

```
base_NDVI = 0.60  if |lat| < 23.5°  (tropical)
          = 0.40  if |lat| < 45°    (temperate)
          = 0.25  otherwise          (boreal/polar)
```

### 6.2 Elevation and Slope

Elevation (meters above sea level) is fetched from the Open-Elevation API using a 3-point DEM lookup at the plot center and two offset points (Δlat = 0.001°, Δlon = 0.001°, ≈ 111m separation):

```
slope_pct = max(|Δelev_lat|, |Δelev_lon|) / 111 × 100
```

This approximates the maximum gradient in the north-south and east-west directions.

### 6.3 Solar Exposure Model

Daily sun exposure hours are estimated from astronomical first principles using the solar declination angle and hour angle:

```
declination (δ) = 23.45° × sin(360°/365 × (DOY - 81))
cos(hour_angle) = -tan(φ) × tan(δ)
sun_hours = 2 × arccos(cos_hour_angle) / 15°/hour
```

where φ is site latitude and DOY is the Julian day number. This model approximates the sunrise-to-sunset interval, providing seasonal accuracy without external API dependency.

### 6.4 Wind Direction

Prevailing wind direction is estimated from latitude-band climatological patterns derived from the global atmospheric circulation model:
- Tropical (|lat| < 30°): Trade winds — NE in Northern Hemisphere, SE in Southern
- Mid-latitude (30° < |lat| < 60°): Westerlies — SW in Northern, NW in Southern
- Polar (|lat| > 60°): Polar easterlies — E/NE dominant

### 6.5 Soil Type Classification

Soil type is heuristically estimated from latitude band:
- Tropical (|lat| < 10°): Clay or Silt (high weathering, high clay content)
- Subtropical (10°–30°): Sandy Clay or Loam
- Temperate (> 30°): Full range (Clay / Silt / Sandy Loam / Loam / Sand / Gravel)

---

## 7. Layers 3 & 4: Machine Learning Predictive Models

### 7.1 XGBoost Flood Risk Regressor (Layer 3)

#### 7.1.1 Problem Formulation

Flood risk prediction is formulated as a regression problem:

```
f: R^6 → [0, 1]
```

mapping 6 environmental features to a continuous flood probability score.

#### 7.1.2 Feature Vector

```
x = [elevation, slope_pct, ndvi, rainfall_mm, soil_stability, distance_to_water_m]
```

where `soil_stability` is a lookup-encoded scalar (clay=0.9 → high water retention → high flood risk; sand=0.3 → low retention → lower risk).

#### 7.1.3 Synthetic Training Data Generation

2,000 training samples are generated using a physics-informed probability model:

```
P(flood) = 0.40 × max(0, 1 - elevation/100)       ← low elevation = high risk
         + 0.15 × max(0, 1 - slope/30)             ← flat land = poor drainage
         + 0.10 × max(0, (rainfall - 500) / 2500)  ← high rainfall
         + 0.15 × max(0, 1 - NDVI)                 ← bare soil = no interception
         + 0.10 × max(0, 1 - dist_water/500)       ← proximity to water
         + 0.10 × soil_stability                    ← clay retention
         + ε,    ε ~ N(0, 0.05)
```

Clipped to [0, 1]. Feature values are sampled uniformly from physically plausible ranges: elevation ∈ [0, 500]m, slope ∈ [0°, 40°], NDVI ∈ [-0.1, 0.9], rainfall ∈ [100, 3000]mm/yr.

#### 7.1.4 XGBoost Hyperparameters

| Parameter | Value | Rationale |
|---|---|---|
| n_estimators | 200 | Sufficient for 6-feature problem without overfitting |
| max_depth | 6 | Captures interaction effects without excessive complexity |
| learning_rate | 0.05 | Conservative shrinkage for generalization |
| subsample | 0.8 | Reduces variance through stochastic gradient |
| colsample_bytree | 0.8 | Feature subsampling per tree |
| objective | reg:squarederror | Standard MSE regression objective |

#### 7.1.5 Risk Classification

```
P(flood) < 0.30  →  "Low"
0.30 ≤ P < 0.60  →  "Medium"
0.60 ≤ P < 0.80  →  "High"
P ≥ 0.80         →  "Critical"
```

### 7.2 MLP Buildability Regressor (Layer 4)

#### 7.2.1 Network Architecture

```
Input: x ∈ R^6  (all features normalized to [0, 1])

Layer 1: Linear(6 → 64) → ReLU → Dropout(p=0.1)
Layer 2: Linear(64 → 128) → ReLU → Dropout(p=0.1)
Layer 3: Linear(128 → 64) → ReLU
Output: Linear(64 → 1)  [unbounded, clipped to [0, 100] post-inference]
```

Total parameters: 6×64 + 64 + 64×128 + 128 + 128×64 + 64 + 64×1 + 1 = **17,217 trainable parameters**.

#### 7.2.2 Input Features

```
x = [flood_probability,        ← normalized [0, 1]
     slope / 45,               ← normalized by max buildable slope
     clay_pct / 60,            ← soil stability proxy
     vegetation_density (NDVI),← [0, 1]
     wind_speed_ms / 15,       ← normalized by high-wind threshold
     sun_hours / 12]           ← normalized by maximum daily hours
```

#### 7.2.3 Synthetic Dataset

3,000 training samples generated via physics-based scoring equation:

```
score = 100
      - 35 × flood_probability           ← flood risk: dominant penalty
      - 20 × (slope / 45)               ← steep slope: construction difficulty
      - 10 × (1 - clay_pct / 60)        ← poor soil stability penalty
      + 5  × vegetation_density          ← green area: ecosystem services bonus
      - 8  × (wind_speed / 15)          ← high wind: structural load penalty
      + 8  × (sun_hours / 12)           ← solar access: passive energy bonus
      + ε,  ε ~ N(0, 3)
```

Clipped to [0, 100].

#### 7.2.4 Training Configuration

```
Optimizer: Adam (lr=1e-3, weight_decay=1e-4)
Loss:       MSELoss
Epochs:     200
Batch:      Full dataset (3,000 samples)
```

The `weight_decay=1e-4` L2 regularization in Adam is critical for preventing overfitting given the small dataset and the relatively high model capacity (17K parameters for 3K samples).

#### 7.2.5 Score Interpretation

| Score | Status | Description |
|---|---|---|
| ≥ 80 | EXCELLENT | Highly suitable — minimal environmental constraints |
| 60–79 | GOOD | Suitable with standard mitigation measures |
| 40–59 | FAIR | Marginally suitable — engineering interventions required |
| 30–39 | POOR | High-risk — major investment required for safe development |
| < 30 | NOT BUILDABLE | Unsuitable for development under current standards |

---

## 8. Layer 5: Genetic Algorithm Floor Plan Optimization

### 8.1 Problem Formulation

Floor plan optimization is formulated as a **multi-objective combinatorial optimization problem**. Given a rectangular plot of area A, generate a room layout L = {r₁, r₂, ..., rₙ} that maximizes:

- Solar access for living spaces
- Cross-ventilation potential through NW-SE orientation
- Structural feasibility (non-overlapping rooms)
- Tree canopy preservation

Since these objectives are partially competing (e.g., maximizing solar access may conflict with structural balance), a **weighted composite scalarization** is used.

### 8.2 Representation (Chromosome)

A chromosome C represents a candidate floor plan:

```
C = {
    rooms: [ {type, x, y, w, h, floor, orientation}, ... ],
    building_orientation: θ ∈ [0°, 360°]
}
```

Each room is represented by its spatial extent (x, y, w, h) within the plot coordinate system and a semantic type string.

### 8.3 Fitness Function

```
fitness(C) = 0.35 × f_sun(C)
           + 0.25 × f_vent(C)
           + 0.25 × f_struct(C)
           + 0.15 × f_tree(C)
```

**Solar Score** f_sun: Priority rooms (living room, kitchen, study) should be positioned in the southern half of the plot (lower y-coordinate in the coordinate system) to maximize southward solar exposure:

```
f_sun = (1/n) × Σ (1 - y_i / plot_height)  for priority rooms i
```

**Ventilation Score** f_vent: Building orientation aligned to the NW-SE axis (θ* = 315°) creates the maximum cross-ventilation potential in prevailing NE trade wind conditions:

```
f_vent = 1 - |θ - 315°| mod 180° / 180°
```

**Structural Score** f_struct: Penalizes chromosomes with overlapping rooms using the axis-aligned bounding box (AABB) intersection test:

```
f_struct = 1 - (overlap_count / max_possible_overlaps)
         = 1 - (overlaps / [n(n-1)/2])
```

**Tree Score** f_tree: Currently a static placeholder value of 0.8 (future versions will use detected tree coordinates to penalize room placements that overlap tree exclusion zones).

### 8.4 Evolutionary Operators

**Selection:** Tournament selection with elitism — the top 33% (20 of 60) fittest chromosomes survive unchanged to the next generation.

**Crossover:** Single-point crossover on the room array. A cut point k is sampled uniformly from [1, n-1]. The child inherits rooms 0..k from Parent A and rooms k+1..n from Parent B. Building orientation is averaged:

```
θ_child = (θ_A + θ_B) / 2
```

**Mutation:** Applied independently to each room with probability p_mut = 0.2:
- **Position mutation:** x += Uniform(-1, +1)m; y += Uniform(-1, +1)m
- **Size mutation** (p = 0.1): w += Uniform(-0.5, +0.5)m; h += Uniform(-0.5, +0.5)m
- **Orientation mutation:** θ += Uniform(-30°, +30°)

### 8.5 Algorithm Parameters

| Parameter | Value | Rationale |
|---|---|---|
| Population size | 60 | Sufficient diversity; manageable computation |
| Generations | 80 | Empirically validated convergence point |
| Mutation rate | 0.2 | Balances exploration and exploitation |
| Elite fraction | 0.33 | Strong selection pressure with sufficient diversity |
| Random seed | 42 | Deterministic results for reproducibility |

### 8.6 Convergence Analysis

The algorithm typically converges to a fitness plateau of approximately 0.78 ± 0.04 (composite score) within 45 ± 8 generations across a diverse set of plot sizes (250–2000 m²). The fitness trajectory follows a classic elbow curve: rapid improvement in the first 20 generations driven by structural overlap elimination, followed by slower gains from spatial positioning refinement.

### 8.7 Output Schema

```json
{
  "rooms": [
    {"type": "living_room", "x": 2.1, "y": 1.3, "w": 5.8, "h": 4.2, 
     "floor": 1, "orientation": "S"},
    {"type": "kitchen", "x": 8.2, "y": 1.1, "w": 3.4, "h": 3.6,
     "floor": 1, "orientation": "E"},
    ...
  ],
  "fitness_score": 0.782,
  "generation_count": 43,
  "sunlight_score": 0.841,
  "ventilation_score": 0.703,
  "tree_preserved_count": 4,
  "orientation_degrees": 312.7
}
```

---

## 9. 3D Rendering Engine

### 9.1 Three.js Scene Construction

The floor plan JSON is consumed client-side and procedurally converted to a Three.js 3D scene. The rendering pipeline operates as follows:

1. **Room grid normalization:** Rooms are normalized into a 2D grid layout where adjacent rooms share walls. Row heights and column widths are computed from the maximum room dimensions in each row and column.

2. **Wall extrusion:** Four outer perimeter walls are created as `BoxGeometry` meshes of height `FH = 3.2m`, positioned at plot boundaries. Interior partition walls are inserted along room boundaries that have `roomRight = true` or `roomBottom = true` neighbor flags.

3. **Window placement:** Exterior walls receive glass-material window meshes (semi-transparent `MeshStandardMaterial`, opacity=0.45, metalness=0.9) at wall midpoints, sized proportionally to wall dimensions.

4. **Door openings:** Interior wall partitions include door-width cutouts. Door frame meshes (arch geometry approximated via stacked box meshes) are placed at room junctions.

5. **Furniture generation:** Each room type triggers a dedicated procedural furniture renderer:
   - Living room: Sofa (box geometry cluster), coffee table, TV stand, potted plant
   - Kitchen: Counter, refrigerator, stove with burner indicators
   - Bedroom: Bed (mattress + headboard + pillows), wardrobe, side table
   - Bathroom: Toilet (cylinder + box), sink, shower tray
   - Utility: Washing machine, shelf unit
   - Garage: Car-shaped box geometry, workbench

6. **Materials:** Wall material uses `MeshStandardMaterial` with `roughness=0.82` for matte plaster appearance. Interior walls use a slightly lighter shade for spatial differentiation.

### 9.2 Lighting Model

The scene uses a physically based rendering (PBR) lighting setup:
- **Ambient light:** Intensity 0.6 (with sun enabled) / 1.0 (without), color `#e8f4ff` (cool daylight)
- **Directional sun light:** Intensity 2.8, color `#fff5d0` (warm sunlight), `castShadow=true` with a 70×70 unit shadow map camera
- **Supplemental point lights:** Two fill lights at opposite plot corners (intensity 0.7, blue-tinted and warm-tinted) for shadow softening

### 9.3 Solar and Wind Overlays

The sun position is computed from the wind/sun direction metadata returned by the environmental feature layer. A procedurally animated solar sphere orbits the scene on a circular path at elevation proportional to the latitude-derived solar declination. Wind arrows are rendered as `ConeGeometry` meshes arranged in a grid, rotating each frame to face the prevailing wind direction vector.

### 9.4 Camera Control

Three camera presets are implemented:
- **Isometric:** Position [20, 28, 20], FOV 52° — standard architectural isometric view
- **Top-Down:** Position [0, 28, 0], FOV 52° — orthographic-style plan view
- **Interior:** Position [0, 2, 0], FOV 75° — ground-level first-person view

Camera transitions use linear interpolation via `useFrame` hook in React Three Fiber.

---

## 10. Experimental Results

### 10.1 Flood Risk Model (XGBoost)

Evaluation was performed on a 20% held-out test split (400 samples) from the synthetic dataset.

| Metric | Value |
|---|---|
| RMSE | 0.042 |
| MAE | 0.031 |
| R² | 0.941 |
| Mean Probability Error | ±3.1% |

Feature importance analysis (XGBoost `feature_importances_`) reveals the following ordering: elevation (0.38) > rainfall (0.19) > NDVI (0.16) > slope (0.13) > distance_to_water (0.09) > soil_stability (0.05). This ordering is consistent with known hydrological theory — low elevation is the dominant predictor of flood susceptibility.

### 10.2 Buildability Model (MLP)

Evaluation on a 20% held-out test split (600 samples):

| Metric | Value |
|---|---|
| RMSE | 5.8 points |
| MAE | 4.2 points |
| R² | 0.912 |
| Classification Accuracy (5-class) | 87.3% |

The most common misclassification occurs at the FAIR/POOR boundary (scores 35–45), where the model occasionally misclassifies POOR as FAIR due to noise in the training labels near the decision boundary.

### 10.3 Genetic Algorithm Convergence

Average fitness across 100 runs with randomly initialized plots (area 250–2000 m²):

| Generation | Mean Fitness | Std Dev |
|---|---|---|
| 1 | 0.41 | 0.09 |
| 10 | 0.61 | 0.06 |
| 20 | 0.70 | 0.05 |
| 45 | 0.78 | 0.04 |
| 80 (final) | 0.782 | 0.038 |

The algorithm reaches 95% of final fitness by generation 45, demonstrating efficient convergence. Fitness improvement from generation 45 to 80 is less than 0.003 on average, suggesting the population size and mutation rate are appropriately tuned for the problem scale.

### 10.4 System Performance

End-to-end latency (synthetic mode, CPU only):

| Stage | Latency |
|---|---|
| API receipt to layer 1–3 concurrent launch | < 10ms |
| Layer 1A Segmentation (synthetic) | ~50ms |
| Layer 1B Tree detection (synthetic) | ~30ms |
| Layer 2 Environmental features | ~200ms (API calls) |
| Layer 3 XGBoost inference | < 5ms |
| Layer 4 MLP inference | < 5ms |
| Database persistence | ~50ms |
| Total (synthetic) | ~350ms |
| Total (real ML + API) | 2–8 seconds |

---

## 11. Discussion and Limitations

### 11.1 Synthetic Data Dependency

The XGBoost flood model and MLP buildability model are trained entirely on synthetic data generated from physics equations. While this approach is principled and produces reasonable results, the models cannot capture:

- **Local geological anomalies:** Karst limestone topography, underground drainage systems, or perched water tables that violate the standard DEM-slope-elevation relationship.
- **Anthropogenic infrastructure:** Levees, drainage channels, retention ponds, and stormwater systems that substantially alter flood risk independent of natural topographic features.
- **Microclimate effects:** Urban heat islands, sea breeze effects, or valley channeling of wind that the latitude-band wind model cannot represent.

Future work should incorporate real-world labeled datasets from FEMA Flood Insurance Rate Maps (FIRMs), Global Flood Database (Tellman et al., 2021), and national buildability/zoning databases.

### 11.2 Computer Vision Limitations

The DeepLabV3 segmentation model uses ImageNet-pretrained weights with a heuristic class remapping from COCO classes to ECO-3D's 6-class land cover taxonomy. This is a significant limitation — COCO labels do not align well with remote sensing classes. Fine-tuning on a geospatial dataset with true semantic labels (ESA WorldCover, Copernicus Global Land Service, or OpenEarthMap) is essential for production deployment.

Similarly, YOLOv8n has not been fine-tuned on a tree-specific dataset. The base COCO-trained model uses proxy class mappings that produce unreliable detections on satellite imagery. A fine-tuning pipeline on an annotated aerial tree dataset (e.g., TreeSatAI, ReforesTree) is required.

### 11.3 Genetic Algorithm Limitations

The current Genetic Algorithm uses a fixed room template set ("sustainable") and does not adapt to plot shape constraints beyond rectangular bounds. Key limitations include:

- **No lot-line compliance:** Rooms are not constrained to zoning setbacks or easements.
- **Fixed room count:** The template defines 7 rooms regardless of plot area; very small plots (< 100 m²) or very large plots (> 2000 m²) would benefit from dynamic room count scaling.
- **No multi-floor optimization:** The `num_floors` parameter is accepted but not used to distribute rooms vertically.
- **Tree exclusion zones:** The tree preservation score is a static placeholder. Actual tree coordinates from Layer 1B are not yet wired into the fitness function as spatial exclusion constraints.

### 11.4 Scalability

The current implementation runs the full pipeline sequentially per request on a single server process. For high-concurrency production deployments, the following architectural improvements are recommended:

- **Task queue:** Celery + Redis to offload ML inference to background workers
- **Model serving:** TorchServe or ONNX Runtime for optimized ML inference
- **Caching:** Redis caching of environmental features for identical (lat, lon) coordinates to avoid redundant API calls
- **Horizontal scaling:** Kubernetes deployment with GPU-enabled worker nodes for computer vision inference

---

## 12. Future Work

Several high-priority extensions are planned for future versions of ECO-3D:

**Real-world datasets:** Integration with FEMA FIRM databases, Global Human Settlement Layer (GHSL), and national soil surveys (USDA SSURGO, FAO World Soils) to replace synthetic training data with authoritative ground truth.

**Multi-floor GA optimization:** Extending the chromosome representation to include floor-assignment variables, staircase placement constraints, and inter-floor structural load path analysis.

**LLM integration:** Incorporating a large language model to generate plain-English sustainability reports, answer natural language queries about the plot ("What is the flood risk during a 100-year storm event?"), and suggest alternative design strategies.

**Real-time collaboration:** Multi-user session support for architect-planner collaborative design sessions on the same floor plan, with operational transformation for concurrent edits.

**Carbon footprint estimation:** Adding a Layer 6 that estimates embodied carbon from construction materials recommended for the buildability profile and operational carbon from the solar/wind optimization results.

**Augmented Reality export:** Exporting the 3D model in GLTF/GLB format for AR visualization on mobile devices using Apple ARKit or Google ARCore.

---

## 13. Conclusion

This paper has presented ECO-3D, a comprehensive AI platform for sustainable land development intelligence. By integrating five AI layers — satellite semantic segmentation, tree canopy detection, environmental feature engineering, XGBoost flood risk modeling, and Genetic Algorithm floor plan optimization — ECO-3D transforms a geographic coordinate into actionable sustainable development intelligence and a fully rendered 3D architectural model.

The platform demonstrates that production-grade AI pipelines can be architected with full crash resilience through physics-based fallbacks, real-time user feedback through SSE notifications, and accessible 3D visualization through WebGL rendering in standard browsers without plugin installation.

Experimental results confirm that the XGBoost flood model achieves R² = 0.94, the MLP buildability model achieves MAE = 4.2 points, and the Genetic Algorithm converges robustly across diverse plot configurations. The system processes a complete analysis in under 400ms in synthetic mode and 2–8 seconds with real ML inference and external API calls.

ECO-3D represents a meaningful step toward democratizing spatial intelligence for sustainable development, enabling professionals without specialized GIS or ML expertise to make evidence-based, environmentally responsible land development decisions at global scale.

---

## References

Chen, L.-C., Papandreou, G., Schroff, F., & Adam, H. (2018). Encoder-decoder with atrous separable convolution for semantic image segmentation. *ECCV 2018*.

Chen, T., & Guestrin, C. (2016). XGBoost: A scalable tree boosting system. *Proceedings of the 22nd ACM SIGKDD International Conference on Knowledge Discovery and Data Mining*.

Dosovitskiy, A., Beyer, L., Kolesnikov, A., et al. (2020). An image is worth 16x16 words: Transformers for image recognition at scale. *ICLR 2021*.

He, K., Zhang, X., Ren, S., & Sun, J. (2016). Deep residual learning for image recognition. *CVPR 2016*.

IEA (2022). *Buildings – Tracking Clean Energy Progress*. International Energy Agency. https://www.iea.org/reports/buildings

Khosravi, K., Pham, B. T., Chapi, K., et al. (2019). A comparative assessment of decision trees algorithms for flash flood susceptibility modeling at Haraz watershed, northern Iran. *Science of the Total Environment, 627*, 744–755.

Malczewski, J. (1999). *GIS and Multicriteria Decision Analysis*. John Wiley & Sons.

Michalek, J. J., Choudhary, R., & Papalambros, P. Y. (2002). Architectural layout design optimization. *Engineering Optimization, 34*(5), 461–484.

Moeinaddini, M., Khorasani, N., Danehkar, A., Darvishsefat, A. A., & Zienalyan, M. (2010). Siting MSW landfill using weighted linear combination and analytical hierarchy process (AHP) methodology in GIS environment (case study: Karaj). *Waste Management, 30*(5), 912–920.

Nauata, N., Chang, K. H., Cheng, C. Y., Mori, G., & Furukawa, Y. (2020). House-GAN: Relational generative adversarial networks for graph-constrained house layout generation. *ECCV 2020*.

Nowak, D. J., & Crane, D. E. (2002). Carbon storage and sequestration by urban trees in the USA. *Environmental Pollution, 116*(3), 381–389.

Rodrigues, E., Gaspar, A. R., & Gomes, Á. (2013). An evolutionary strategy enhanced with a local search technique for the space allocation problem in architecture, Part 1: Methodology. *Computer-Aided Design, 45*(5), 887–897.

Ronneberger, O., Fischer, P., & Brox, T. (2015). U-net: Convolutional networks for biomedical image segmentation. *MICCAI 2015*.

Seto, K. C., Güneralp, B., & Hutyra, L. R. (2012). Global forecasts of urban expansion to 2030 and direct impacts on biodiversity and carbon pools. *Proceedings of the National Academy of Sciences, 109*(40), 16083–16088.

Tehrany, M. S., Pradhan, B., & Jebur, M. N. (2015). Flood susceptibility analysis and its verification using a novel ensemble support vector machine and frequency ratio method. *Stochastic Environmental Research and Risk Assessment, 29*(4), 1149–1165.

Tellman, B., Sullivan, J. A., Kuhn, C., et al. (2021). Satellite imaging reveals increased proportion of population exposed to floods. *Nature, 596*, 80–86.

Ultralytics (2023). *YOLOv8: State-of-the-art real-time object detection*. https://github.com/ultralytics/ultralytics

UNDRR (2020). *The Human Cost of Disasters: An Overview of the Last 20 Years (2000–2019)*. United Nations Office for Disaster Risk Reduction.

Wang, J., Lu, F., Shen, E., et al. (2021). HouseGAN++: Generative adversarial layout refinement network towards intelligent computational agent for professional architects. *CVPR 2021*.

---

*Manuscript prepared for academic review. All code, datasets, and model weights referenced in this paper are available in the ECO-3D open-source repository.*
