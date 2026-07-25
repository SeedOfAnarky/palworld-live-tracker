# Sources and coordinate notes

## Official Palworld 1.0 Game Data API

- https://docs.palworldgame.com/api/rest-api/game-data/
- Endpoint: `/v1/api/game-data`
- Actor unit types include `Player`, `OtomoPal`, `BaseCampPal`, `WildPal`, and `NPC`.
- Actor position fields: `LocationX`, `LocationY`, `LocationZ`.
- Unique actor field: `InstanceID`.

REST API authentication is HTTP Basic Auth. Common server tooling confirms the username is `admin` with `AdminPassword`.

## Current 1.0 map textures and exact bounds

Project:
- https://github.com/oMaN-Rod/palworld-save-pal

Pinned source revision used by this tracker:
- `0d99b04acba369ec88550d122794b9917bbf820e`

Map implementation:
- `ui/src/lib/components/map/Map.svelte`
- `ui/src/lib/components/map/utils.ts`
- `ui/src/lib/components/map/styles.ts`

Map textures:
- `ui/src/lib/assets/img/t_worldmap.webp`
- `ui/src/lib/assets/img/t_treemap.webp`

Current bounds:

MainMap:
- min world X: -1099400.0
- min world Y: -724400.0
- max world X: 349400.0
- max world Y: 724400.0

Tree:
- min world X: 347351.5
- min world Y: -818197.0
- max world X: 689148.5
- max world Y: -476400.0

Texture size used by the source implementation: 8192 x 8192.

The source notes these values come from the game's `DT_WorldMapUIData`.

## Historical cross-check

Project:
- https://github.com/fa0311/palworld-map

File:
- `src/app/leaflet.tsx`

That older tracker independently converted Palworld server world coordinates into a flat game map and is useful as a historical cross-check. The current app prefers the newer 1.0 bounds above because they include the World Tree projection.

## v0.4 renderer research

OpenLayers official static-image example:
- https://openlayers.org/en/latest/examples/static-image.html
- Treats a non-geographic static image as a pixel-coordinate projection.

Current Palworld Save Pal map:
- `ui/src/lib/components/map/Map.svelte`
- Uses an 8192x8192 `[0,0,MAP_SIZE,MAP_SIZE]` custom pixel projection.
- Renders the world maps as static image layers.
- `ui/src/lib/components/map/utils.ts` defines the current Palpagos and World Tree bounds from `DT_WorldMapUIData`.

v0.4 uses the same map/bounds model but a dependency-free Canvas 2D renderer to minimize runtime failure modes.


## v0.5 Pal catalog / filters

Official live actor schema:
- https://docs.palworldgame.com/api/rest-api/game-data/
- Provides live `InstanceID`, `UnitType`, `NickName`, `Class`, level/HP, location, rotation, stage and activity state.
- It does not provide rarity, elements, boss metadata, or a Lucky flag.

Pinned Pal metadata source:
- https://github.com/oMaN-Rod/palworld-save-pal
- revision `0d99b04acba369ec88550d122794b9917bbf820e` (v1.2.0 merge)
- `data/json/pals.json`
- `data/json/l10n/en/pals.json`

The source project's `PalData` model contains `rarity`, `element_types`, Paldeck index, boss/raid/predator flags and other Pal metadata.

Rarity interpretation cross-check (game-file documentation):
- https://palworld.wiki.gg/wiki/Game_Files/Reading/Creature_Parameters
- Rarity 1–4 corresponds to regular eggs, 5–7 to large eggs, and 8–10 or 20 to huge eggs.


## v0.7 real Pal icons
Pinned source: oMaN-Rod/palworld-save-pal v1.2.0 / commit 0d99b04acba369ec88550d122794b9917bbf820e

Relevant source files:
- `ui/src/lib/utils/assetLoader.ts`
  - `loadMenuImage()` resolves `t_<character_id>_icon_normal.webp`
  - `loadPalImage()` tries direct Pal artwork then the menu-icon fallback.
- `psp-core/tests/pal_images.rs`
  - verifies every real `is_pal == true` catalog entry has matching WebP art, except a small allow-list of internal raid-boss body-part entities.


## v0.8 possible spawn source

Awy64/palworld-atlas-data
- https://github.com/Awy64/palworld-atlas-data
- Published pointer: https://awy64.github.io/palworld-atlas-data/v1/latest.json
- Runtime files: `<buildPath>/maps/palpagos/spawns.json` and `<buildPath>/maps/tree/spawns.json`

The extractor publishes normalized factual data from the Palworld Dedicated Server package. Its AtlasSpawn contract includes PalId, PalName, Region, Kind, WorldX/Y, MapX/Y, ImageX/Y, Availability, MinLevel, MaxLevel, and Weight.
