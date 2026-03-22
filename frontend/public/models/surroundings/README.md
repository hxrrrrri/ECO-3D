# Blender Surroundings Assets

Place exported `.glb` files here to override procedural surroundings per profile.

## Profile manifest

Use [frontend/public/models/surroundings/manifest.json](frontend/public/models/surroundings/manifest.json) to control which files load for each profile.

Each profile can use one or many assets with transforms:

- `url`: model path under `public`
- `position`: `[x, y, z]`
- `rotationDeg`: `[xDeg, yDeg, zDeg]`
- `scale`: number or `[x, y, z]`
- `castShadow`: boolean
- `receiveShadow`: boolean
- `textureMode`: `auto | pixelated | smooth`
- `material.roughnessMin / roughnessMax`
- `material.metalnessMin / metalnessMax`
- `material.envMapIntensity`
- `material.normalScale`
- `material.saturation`
- `material.brightness`

## Recommended realistic pack layout

Per profile, split Blender exports into 2-3 files for better tuning and performance:

- `<profile>_terrain.glb`: ground, cliffs, large static geometry
- `<profile>_foliage.glb` or `<profile>_props.glb`: trees, vegetation, props
- `<profile>.glb`: optional full fallback all-in-one scene

Examples already prepared in [frontend/public/models/surroundings/manifest.json](frontend/public/models/surroundings/manifest.json).

If no manifest entry exists, runtime falls back to legacy single-file names:

- `minecraft.glb`
- `sakura-blooms.glb`
- `valorant.glb`
- `wuthering-waves.glb`

## Export recommendations (Blender -> glTF 2.0)

- Format: `glTF Binary (.glb)`
- Apply transforms before export (`Ctrl+A` -> Rotation & Scale)
- Keep world origin centered around the build zone (`0,0,0`)
- Use PBR materials (`Principled BSDF`)
- Include textures in the GLB
- Limit texture size to 2K where possible for runtime performance

## Runtime behavior

If valid GLB entries exist for a profile, they are loaded automatically.
If assets are missing, the app falls back to the current procedural surroundings.
