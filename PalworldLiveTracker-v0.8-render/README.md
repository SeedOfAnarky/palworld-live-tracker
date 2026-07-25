# Palworld Live Tracker

A local live tactical map for a Palworld 1.0 dedicated server using the official REST Game Data API.

## Your server is preconfigured

- Game: `lakeshore.dathost.net:29145`
- REST API: `lakeshore.dathost.net:29148`
- REST username: `admin`
- REST AdminPassword is preconfigured to the value confirmed working with direct `curl` during setup.
- Polling: 750 ms

The app does **not** use RCON.

## Run it

1. Make sure Node.js 18+ is installed.
2. Double-click `start.bat`.
3. Your browser opens `http://127.0.0.1:3030`.
4. Open **Connection settings** and press **Test connection**.

The **Test connection** button now tests the credentials currently typed into the form against both `/info` and `/game-data`; on success it saves them and immediately restarts live polling.

## What it tracks

The official `/v1/api/game-data` snapshot is polled by the local Node server. The browser receives the snapshot from the local tracker and renders:

- all online `Player` actors, with smooth interpolated movement
- `WildPal` actors
- companion (`OtomoPal`) actors
- base (`BaseCampPal`) actors
- NPCs
- Palboxes
- full Wild Pal species/variant filtering from the current Pal catalog
- all numeric Pal rarity filters (R1–R10 and any additional rarity values present in the catalog)
- elemental filters across the Palworld element set
- Normal, Boss/Alpha, Raid Boss, Predator, and Unknown/unmatched special-type filters
- alerts for tracked Pals already present in the first/current snapshot
- new WildPal `InstanceID` spawn alerts after the initial snapshot
- optional desktop notifications
- click an alert to focus that Pal's map location
- catalog-match diagnostics so new/unrecognized Pal classes are visible instead of silently dropped
- server FPS and actor counts

The browser never talks to DatHost directly and never receives the saved REST password.

## Current Palworld 1.0 map

No manual map setup is required.

The tracker downloads and caches the current Palpagos and World Tree WebP textures from the pinned Palworld Save Pal v1.2.0 source revision. It validates the downloaded files as real WebP images before exposing them to the browser and writes downloads atomically so the browser cannot read a half-written map.

### Renderer in v0.5

v0.5 keeps the stable Canvas 2D renderer from v0.4 and adds the full Pal tracker/alert system without changing the map renderer.

Research showed the current Palworld Save Pal map uses a static 8192×8192 image in a custom pixel projection. This build mirrors that coordinate model but renders the map with a normal browser Image decoded into a **viewport-sized Canvas 2D crop**.

That means:
- the GPU is never asked to hold the entire Palworld map as one Pixi texture;
- the canvas backing store is only the size of the visible browser map;
- zooming redraws only the visible crop of the source image;
- if the image is missing/corrupt, the UI shows an explicit map error instead of a black screen.

## Demo mode

Double-click `start-demo.bat`.

It simulates four moving players and hundreds of Wild Pals so you can test the live UI without touching the Palworld server.

## Security

Pocketpair warns that the REST API is administrative and should not be broadly exposed. This tracker keeps credentials in the local Node process and only exposes its viewer on `127.0.0.1`.

Do not forward port 3030 to the public Internet.


## Pal catalog and rarity data

v0.5 joins the live `/game-data` actors to the pinned Palworld Save Pal v1.2.0 game-data catalog:

- `data/json/pals.json` — internal Pal IDs, raw rarity, elements, Paldeck number, boss/raid/predator flags
- `data/json/l10n/en/pals.json` — English localized Pal names

The tracker downloads/caches those JSON files on first use. The browser only receives a normalized local catalog from the Node server.

The REST snapshot itself does not expose a Lucky/Shiny flag, so v0.5 deliberately does not claim to detect Lucky Pals.


## v0.6 map integrity repair

v0.5 accidentally packaged invalid/noise WebP files in place of the Palworld map textures.

v0.6 ships without cached map textures. On startup it downloads the exact map files from the pinned Palworld Save Pal v1.2.0 commit and validates each complete file against GitHub's Git blob SHA before the browser is allowed to use it.

Expected Git blob hashes:
- t_worldmap.webp: 7bf20d19b0dbb627a0dbaa4354845699630df057
- t_treemap.webp: 58eb303a75f0b1160e0b25120a3b4bdfce419a7b

This also repairs an existing v0.5 folder: any local map file with a different hash is deleted and replaced automatically.


## v0.7 Pal marker customization

- Click any Pal name in the Pal species list to open its marker settings.
- Clicking a Wild Pal marker directly on the map opens the same per-species settings.
- Per Pal: choose real icon + colored ring, real icon only, or colored dot.
- Per Pal: marker size from 6–56 px.
- Per Pal: custom marker/ring color.
- Per Pal: enable/disable alerts while still keeping the Pal visible.
- Preferences persist in the browser on this PC.
- Auto-scan current-world interval is configurable from 2–3600 seconds.
- Immediate spawn detection still runs on every REST snapshot; auto-scan is for re-checking currently loaded Pals.

### Real Pal icons

The app fetches the same Pal WebP artwork/icon names used by Palworld Save Pal from the pinned v1.2.0 commit and caches them locally under `public/assets/pal-icons/`.

The lookup mirrors Palworld Save Pal's current asset loader:
1. catalog-provided icon name
2. `t_<cleansed-pal-key>_icon_normal.webp`
3. `<cleansed-pal-key>.webp`

If an icon is unavailable, the map falls back to the configured colored dot.


## v0.8 Possible Spawn Locations

The Pal Tracker filter panel now includes **Possible spawn locations**.

When enabled:
- live `/game-data` Wild Pals remain fully opaque;
- possible locations are rendered underneath as faded real Pal icons with a dashed ring;
- the existing species, rarity, element, special-type, and search filters apply to the possible-spawn layer;
- clicking a ghost marker opens that Pal's per-species marker settings;
- hovering a ghost marker shows day/night/both availability, level range, spawn weight, and world coordinates.

The possible-spawn layer works even when that world chunk is not currently loaded by a player because it comes from static game spawn tables rather than the live REST actor snapshot.

### Spawn database source

v0.8 reads the current normalized spawn database published by:
`Awy64/palworld-atlas-data`

The local Node backend resolves `v1/latest.json`, then downloads:
- `maps/palpagos/spawns.json`
- `maps/tree/spawns.json`

The source project's extractor joins the Palworld wild-spawner definitions to exact spawner placements from the dedicated-server game package. Its records include Pal ID/name, world coordinates, wild/alpha type, day/night availability, min/max level, and spawn weight.

The tracker caches the last successful database locally and can be manually refreshed from Connection settings.


## Koyeb-hosted build

This package is deployment-safe: `config.json` contains no credentials. Palworld connection settings are read from environment variables, the service binds to `0.0.0.0:$PORT`, `/healthz` is available for platform checks, and the complete site is protected with HTTP Basic authentication. See `KOYEB_SETUP.md`.


## Render deployment

Use `RENDER_SETUP.md`. The included `render.yaml` creates a free Docker Web
Service with `/healthz` and prompts for the three user-specific values rather
than storing them in GitHub.
