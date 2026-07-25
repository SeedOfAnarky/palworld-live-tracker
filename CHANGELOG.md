# Changelog

## v0.8 Render package
- Added `render.yaml` for one-click Blueprint deployment.
- Added Render-specific setup guide.
- Uses Render's supplied `PORT` and binds to `0.0.0.0`.
- Includes unauthenticated `/healthz` for Render health checks.
- Keeps Palworld and tracker passwords out of the repository.

## v0.8
- Added Possible spawn locations checkbox inside Pal Tracker filters.
- Possible locations use faded real Pal icons with dashed rings; live actors remain solid.
- Possible-spawn layer obeys species, rarity, element, special-type, and search filters.
- Added Palpagos + World Tree static spawn database from current game-derived atlas data.
- Ghost-marker hover shows availability, level range, spawn weight, and coordinates.
- Clicking a ghost marker opens that Pal's marker settings.
- Cached spawn database works if a later refresh is temporarily unavailable.
- Added manual Refresh possible spawn database button.

## v0.7
- Added real Pal icons using the current game-derived WebP asset naming used by Palworld Save Pal.
- Added per-Pal marker editor: icon/dot mode, size, color, and alert toggle.
- Clicking a Wild Pal marker opens its species marker settings.
- Clicking a Pal species name opens its marker settings.
- Added persistent browser-side marker preferences.
- Added configurable auto-scan interval for currently loaded Pals.
- Auto-scan deduplicates by InstanceID so it does not alert the same loaded Pal every interval.
- New spawn detection remains immediate on each REST snapshot.

## v0.6
- Removed the invalid/noise map files accidentally packaged in v0.5.
- Downloads the real pinned v1.2.0 Palpagos and World Tree textures at startup.
- Verifies the entire files against their exact GitHub Git blob SHAs.
- Automatically repairs stale/bad map files when extracted over an older folder.
- Added a second GitHub raw download URL as fallback.
- Keeps all v0.5 Pal species, rarity, element, special-type, and spawn alert features.

## v0.5
- Added searchable all-Pal species/variant filter with All/None controls.
- Added every raw rarity value present in the current Pal catalog.
- Added element filters.
- Added Normal, Boss/Alpha, Raid Boss, Predator, and Unknown/unmatched filters.
- Added startup/current-world alerts for matching Pals already loaded.
- Added per-InstanceID new-spawn alerts after the initial snapshot.
- Added optional desktop notifications.
- Added click-to-focus from Pal alerts.
- Added Catalog matched / Unmatched live diagnostics.
- Added local cached Pal metadata sourced from current Palworld Save Pal v1.2.0 data.
- Added Pal catalog refresh control.
- Keeps the stable Canvas 2D map renderer from v0.4.

## v0.4
- Replaced PixiJS map rendering completely.
- New dependency-free Canvas 2D viewport renderer.
- Base map is drawn as a visible crop only; no 8192x8192 WebGL texture.
- Added explicit map loading/error UI so a failure cannot appear as an unexplained black screen.
- Added `/api/map-diagnostics`.
- Map downloads now validate RIFF/WEBP headers and minimum size.
- Map downloads use a temporary file + atomic rename.
- Kept live REST polling, smooth player interpolation, filters, follow mode, and spawn alerts.
- Uses current Palworld Save Pal 1.0/World Tree coordinate bounds.

## v0.3
- Experimental Pixi tiling renderer. Superseded by v0.4.
