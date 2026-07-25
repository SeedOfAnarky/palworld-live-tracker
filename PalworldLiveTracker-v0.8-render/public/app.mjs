const MAP_SIZE = 8192;

// Current Palworld 1.0 bounds from DT_WorldMapUIData, mirrored by
// oMaN-Rod/palworld-save-pal.
const MAP_AREAS = {
  Tree: {
    file: "/assets/t_treemap.webp",
    min: { x: 347351.5, y: -818197.0 },
    max: { x: 689148.5, y: -476400.0 }
  },
  MainMap: {
    file: "/assets/t_worldmap.webp",
    min: { x: -1099400.0, y: -724400.0 },
    max: { x: 349400.0, y: 724400.0 }
  }
};

// Tree has priority where the rectangles overlap.
const AREA_PRIORITY = ["Tree", "MainMap"];
const PLAYER_COLORS = ["#43c7a1", "#58a6ff", "#c88cff", "#ffa657", "#ff6b8a", "#8fd14f"];

const el = (id) => document.getElementById(id);
const mapHost = el("mapHost");
const notice = el("mapNotice");
const hoverCard = el("hoverCard");

let activeArea = "MainMap";
let lastSnapshot = null;
let mapImage = null;
let mapReady = false;
let mapLoadToken = 0;
let mapLoadAttempts = 0;

let camera = { x: 0, y: 0, scale: 0.08 };
let dragging = false;
let dragStart = null;
let cameraStart = null;
let followPlayerId = "";

const markerById = new Map();
const playerColorById = new Map();
const alerts = [];
let previousWildIds = new Set();
let initialWorldAlerted = false;
let hoveredMarker = null;

let palCatalogReady = false;
let palCatalogRecords = [];
let palSpecies = [];
let palCatalogByKey = new Map();
let palCatalogByName = new Map();
let palCatalogKeysLongest = [];
const palMetaCache = new Map();
let selectedSpecies = new Set();
let selectedRarities = new Set();
let selectedElements = new Set();

const TRACKER_PREFS_KEY = "palworld-live-tracker-v0.7";
const DEFAULT_PAL_MARKER = {
  mode: "icon-ring",
  size: 22,
  color: "#43c7a1",
  alerts: true
};

let trackerPrefs = {
  autoScanEnabled: true,
  autoScanSeconds: 10,
  showPossibleSpawns: false,
  species: {}
};

try {
  const saved = JSON.parse(localStorage.getItem(TRACKER_PREFS_KEY) || "null");
  if (saved && typeof saved === "object") {
    trackerPrefs = {
      ...trackerPrefs,
      ...saved,
      species: saved.species && typeof saved.species === "object" ? saved.species : {}
    };
  }
} catch {}

let selectedSpeciesEditor = "";
let autoScanTimer = null;
let presentAlertedIds = new Set();
const palIconImages = new Map();

let possibleSpawnReady = false;
let possibleSpawnSource = null;
let possibleSpawnsByArea = {
  MainMap: [],
  Tree: []
};
let visiblePossibleSpawnMarkers = [];
let lastPossibleSpawnCount = -1;
let palCatalogByTribe = new Map();

function saveTrackerPrefs() {
  try {
    localStorage.setItem(TRACKER_PREFS_KEY, JSON.stringify(trackerPrefs));
  } catch {}
}

function speciesPreference(nameOrMeta) {
  const name = typeof nameOrMeta === "string" ? nameOrMeta : nameOrMeta?.name;
  const key = normalizedName(name);
  return {
    ...DEFAULT_PAL_MARKER,
    ...(trackerPrefs.species[key] || {})
  };
}

function updateSpeciesPreference(nameOrMeta, patch) {
  const name = typeof nameOrMeta === "string" ? nameOrMeta : nameOrMeta?.name;
  const key = normalizedName(name);
  if (!key) return;
  trackerPrefs.species[key] = {
    ...speciesPreference(key),
    ...patch
  };
  saveTrackerPrefs();
}

function resetSpeciesPreference(nameOrMeta) {
  const name = typeof nameOrMeta === "string" ? nameOrMeta : nameOrMeta?.name;
  const key = normalizedName(name);
  delete trackerPrefs.species[key];
  saveTrackerPrefs();
}

function palIconUrl(meta) {
  return meta?.key ? `/api/pal-icon?key=${encodeURIComponent(meta.key)}` : "";
}

function palIconImage(meta) {
  if (!meta?.key) return null;
  const key = meta.key;
  if (palIconImages.has(key)) return palIconImages.get(key);

  const state = { image: null, ready: false, failed: false };
  const image = new Image();
  state.image = image;
  image.onload = () => { state.ready = true; };
  image.onerror = () => { state.failed = true; };
  image.src = palIconUrl(meta);
  palIconImages.set(key, state);
  return state;
}

const mapCanvas = document.createElement("canvas");
mapCanvas.className = "map-canvas map-background-canvas";
const actorCanvas = document.createElement("canvas");
actorCanvas.className = "map-canvas map-actor-canvas";
mapHost.replaceChildren(mapCanvas, actorCanvas);

const mapCtx = mapCanvas.getContext("2d", { alpha: false });
const actorCtx = actorCanvas.getContext("2d", { alpha: true });

function cmPerPx(area) {
  const def = MAP_AREAS[area];
  return (def.max.x - def.min.x) / MAP_SIZE;
}

function mapOf(worldX, worldY) {
  for (const area of AREA_PRIORITY) {
    const def = MAP_AREAS[area];
    if (worldX >= def.min.x && worldX <= def.max.x &&
        worldY >= def.min.y && worldY <= def.max.y) {
      return area;
    }
  }
  return null;
}

// Source project's OpenLayers coordinates use a y-up map extent.
// Canvas source pixels are y-down, so y is inverted here.
function worldToImagePixel(worldX, worldY, area) {
  const def = MAP_AREAS[area];
  const cm = cmPerPx(area);
  const x = (worldY - def.min.y) / cm;
  const yUp = (worldX - def.min.x) / cm;
  return { x, y: MAP_SIZE - yUp };
}

function actorId(actor, index = 0) {
  return actor.InstanceID || actor.userid || `${actor.Type || actor.UnitType || "actor"}-${index}`;
}

function actorAlive(actor) {
  return actor.HP == null || Number(actor.HP) > 0;
}

function actorIsActive(actor) {
  if (actor.IsActive == null || actor.IsActive === "") return true;
  if (typeof actor.IsActive === "boolean") return actor.IsActive;
  return String(actor.IsActive).toLowerCase() === "true";
}


function normalizedName(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function rarityTier(value) {
  const r = Number(value);
  if (!Number.isFinite(r)) return "Unknown";
  if (r >= 1 && r <= 4) return "Regular";
  if (r >= 5 && r <= 7) return "Large";
  if ((r >= 8 && r <= 10) || r === 20) return "Huge";
  return `Rarity ${r}`;
}

function resolvePalMeta(actor) {
  if (!palCatalogReady || !actor) return null;
  const cacheKey = `${actor.Class || ""}|${actor.NickName || ""}`;
  if (palMetaCache.has(cacheKey)) return palMetaCache.get(cacheKey);

  const rawClass = String(actor.Class || "");
  const classLower = rawClass.toLowerCase();
  const tail = rawClass.split(/[/.\\]/).pop()?.replace(/_c$/i, "") || rawClass;
  const candidates = new Set([
    rawClass,
    tail,
    tail.replace(/^bp_/i, ""),
    tail.replace(/^pal_/i, ""),
    tail.replace(/^palmonstercharacter_/i, ""),
    tail.replace(/^palmonster_/i, ""),
    tail.replace(/^character_/i, "")
  ].map(v => String(v || "").replace(/_c$/i, "").toLowerCase()).filter(Boolean));

  let match = null;
  for (const candidate of candidates) {
    if (palCatalogByKey.has(candidate)) {
      match = palCatalogByKey.get(candidate);
      break;
    }
  }

  if (!match && classLower) {
    for (const record of palCatalogKeysLongest) {
      const key = record.key.toLowerCase();
      if (key.length >= 4 && classLower.includes(key)) {
        match = record;
        break;
      }
    }
  }

  if (!match) {
    const byName = palCatalogByName.get(normalizedName(actor.NickName));
    if (byName?.length) {
      if (classLower) {
        match = byName.find(record => classLower.includes(record.key.toLowerCase())) || null;
      }
      match ||= byName.find(record => record.palDeckIndex > 0 && !record.boss && !record.towerBoss && !record.raidBoss) || byName[0];
    }
  }

  palMetaCache.set(cacheKey, match);
  return match;
}

function specialTypeAllowed(meta) {
  if (!meta) return el("typeUnknown").checked;
  const flags = [];
  if (meta.boss || meta.towerBoss) flags.push(el("typeBoss").checked);
  if (meta.raidBoss) flags.push(el("typeRaid").checked);
  if (meta.predator) flags.push(el("typePredator").checked);
  if (!meta.boss && !meta.towerBoss && !meta.raidBoss && !meta.predator) flags.push(el("typeNormal").checked);
  return flags.some(Boolean);
}

function matchesPalFilters(actor, meta = resolvePalMeta(actor)) {
  if (actor?.UnitType !== "WildPal") return true;
  if (!meta) return el("typeUnknown").checked;

  if (!selectedSpecies.has(normalizedName(meta.name))) return false;
  if (meta.rarity != null && !selectedRarities.has(Number(meta.rarity))) return false;
  if (meta.rarity == null && selectedRarities.size !== new Set(palCatalogRecords.map(r => r.rarity).filter(v => v != null)).size) return false;
  if (meta.elements?.length && !meta.elements.some(element => selectedElements.has(element))) return false;
  if (!specialTypeAllowed(meta)) return false;
  return true;
}


function palAlertsEnabled(meta) {
  if (!meta) return true;
  return speciesPreference(meta).alerts !== false;
}

function matchesPalAlertFilters(actor, meta = resolvePalMeta(actor)) {
  return matchesPalFilters(actor, meta) && palAlertsEnabled(meta);
}

function speciesRecordByNameKey(nameKey) {
  return palSpecies.find((record) => normalizedName(record.name) === normalizedName(nameKey)) || null;
}

function openSpeciesEditor(nameKey) {
  const record = speciesRecordByNameKey(nameKey);
  if (!record) return;

  selectedSpeciesEditor = normalizedName(record.name);
  const pref = speciesPreference(record);
  const editor = el("speciesEditor");

  el("speciesEditorName").textContent = record.name;
  el("speciesEditorMeta").textContent =
    `${record.palDeckIndex > 0 ? `#${record.palDeckIndex} · ` : ""}R${record.rarity ?? "?"} · ${(record.elements || []).join("/") || "Unknown element"}`;

  const img = el("speciesEditorIcon");
  img.src = palIconUrl(record);
  img.alt = record.name;

  el("speciesMarkerMode").value = pref.mode;
  el("speciesMarkerSize").value = String(pref.size);
  el("speciesMarkerSizeValue").textContent = `${pref.size} px`;
  el("speciesMarkerColor").value = pref.color;
  el("speciesMarkerColorValue").textContent = pref.color;
  el("speciesAlertsEnabled").checked = pref.alerts !== false;

  editor.classList.remove("hidden");
  editor.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function applySpeciesEditorChange() {
  if (!selectedSpeciesEditor) return;
  const size = Math.max(6, Math.min(56, Number(el("speciesMarkerSize").value) || DEFAULT_PAL_MARKER.size));
  const color = el("speciesMarkerColor").value || DEFAULT_PAL_MARKER.color;
  updateSpeciesPreference(selectedSpeciesEditor, {
    mode: el("speciesMarkerMode").value,
    size,
    color,
    alerts: el("speciesAlertsEnabled").checked
  });
  el("speciesMarkerSizeValue").textContent = `${size} px`;
  el("speciesMarkerColorValue").textContent = color;
  renderSpeciesList();
}

function markerHitRadius(marker) {
  if (marker.type === "Player") return 18;
  if (marker.type === "WildPal" && marker.meta) {
    return Math.max(9, Number(speciesPreference(marker.meta).size) / 2 + 5);
  }
  return 9;
}

function restartAutoScan() {
  if (autoScanTimer) {
    clearInterval(autoScanTimer);
    autoScanTimer = null;
  }

  trackerPrefs.autoScanEnabled = el("autoScanEnabled")?.checked ?? trackerPrefs.autoScanEnabled;
  trackerPrefs.autoScanSeconds = Math.max(2, Math.min(3600, Number(el("autoScanSeconds")?.value) || 10));
  saveTrackerPrefs();

  if (!trackerPrefs.autoScanEnabled) return;

  autoScanTimer = setInterval(() => {
    scanCurrentWorld({ automatic: true, dedupe: true });
  }, trackerPrefs.autoScanSeconds * 1000);
}

function renderSpeciesList() {
  const list = el("speciesList");
  const q = normalizedName(el("speciesSearch").value);
  const filtered = palSpecies.filter(record => {
    if (!q) return true;
    return normalizedName(record.name).includes(q) ||
      normalizedName(record.key).includes(q) ||
      String(record.palDeckIndex).includes(q);
  });

  if (!filtered.length) {
    list.className = "filter-scroll muted";
    list.textContent = "No matching Pals.";
  } else {
    list.className = "filter-scroll";
    list.innerHTML = filtered.map(record => {
      const nameKey = normalizedName(record.name);
      const rarity = record.rarity == null ? "R?" : `R${record.rarity}`;
      const deck = record.palDeckIndex > 0 ? `#${record.palDeckIndex}` : "";
      const pref = speciesPreference(record);
      const configured = trackerPrefs.species[nameKey] ? " configured" : "";
      const styleHint = pref.mode === "dot" ? "dot" : "icon";
      return `<div class="species-option${configured}">
        <input type="checkbox" data-species="${escapeAttr(nameKey)}" ${selectedSpecies.has(nameKey) ? "checked" : ""} aria-label="Track ${escapeAttr(record.name)}">
        <button class="species-config-button" type="button" data-config-species="${escapeAttr(nameKey)}" title="Open marker settings">
          ${escapeHtml(record.name)}
        </button>
        <span class="species-swatch" style="background:${escapeAttr(pref.color)}" title="${escapeAttr(styleHint)} · ${escapeAttr(pref.size)} px"></span>
        <span class="pal-meta">${escapeHtml(deck)} ${escapeHtml(rarity)}</span>
      </div>`;
    }).join("");
  }

  el("speciesSelectedCount").textContent =
    selectedSpecies.size === palSpecies.length ? `All ${palSpecies.length}` : `${selectedSpecies.size}/${palSpecies.length}`;
}

function renderRarityFilters(rarities) {
  const host = el("rarityFilters");
  host.className = "filter-grid";
  host.innerHTML = rarities.map(rarity => `
    <label class="filter-chip"><input type="checkbox" data-rarity="${rarity}" checked><span>R${rarity} · ${escapeHtml(rarityTier(rarity))}</span></label>
  `).join("");
  el("raritySelectedCount").textContent = `All ${rarities.length}`;
}

function renderElementFilters(elements) {
  const host = el("elementFilters");
  host.className = "filter-grid";
  host.innerHTML = elements.map(element => `
    <label class="filter-chip"><input type="checkbox" data-element="${escapeAttr(element)}" checked><span>${escapeHtml(element)}</span></label>
  `).join("");
  el("elementSelectedCount").textContent = `All ${elements.length}`;
}

async function loadPalCatalog() {
  el("speciesList").textContent = "Loading full Palworld 1.0 catalog…";
  try {
    const response = await fetch("/api/pal-catalog", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);

    palCatalogRecords = Array.isArray(result.records) ? result.records : [];
    palSpecies = Array.isArray(result.species) ? result.species : [];
    palCatalogByKey = new Map(palCatalogRecords.map(record => [record.key.toLowerCase(), record]));
    palCatalogByTribe = new Map();
    for (const record of palCatalogRecords) {
      const tribeKey = String(record.tribe || "").toLowerCase();
      if (tribeKey && !palCatalogByTribe.has(tribeKey)) palCatalogByTribe.set(tribeKey, record);
    }
    palCatalogByName = new Map();
    for (const record of palCatalogRecords) {
      const key = normalizedName(record.name);
      if (!palCatalogByName.has(key)) palCatalogByName.set(key, []);
      palCatalogByName.get(key).push(record);
    }
    palCatalogKeysLongest = [...palCatalogRecords].sort((a, b) => b.key.length - a.key.length);
    palMetaCache.clear();

    selectedSpecies = new Set(palSpecies.map(record => normalizedName(record.name)));
    selectedRarities = new Set((result.rarities || []).map(Number));
    selectedElements = new Set(result.elements || []);
    palCatalogReady = true;

    renderSpeciesList();
    updatePossibleSpawnState();
    renderRarityFilters([...selectedRarities]);
    renderElementFilters([...selectedElements]);
    el("alertSummary").textContent = `Loaded ${palSpecies.length} Pal species/variants · ${palCatalogRecords.length} live-match definitions.`;

    // If a snapshot arrived while the catalog was downloading, perform the
    // requested initial current-world scan now.
    if (lastSnapshot) {
      initialWorldAlerted = false;
      previousWildIds = new Set();
      renderSnapshot(lastSnapshot);
    }
  } catch (error) {
    palCatalogReady = false;
    el("speciesList").className = "filter-scroll muted";
    el("speciesList").textContent = `Pal catalog unavailable: ${error?.message || error}`;
    el("alertSummary").textContent = "Live actors still work, but rarity/element matching needs the Pal catalog.";
  }
}


function resolvePossibleSpawnMeta(spawn) {
  if (!palCatalogReady || !spawn) return null;

  const id = String(spawn.palId || "").toLowerCase();
  if (id && palCatalogByKey.has(id)) return palCatalogByKey.get(id);
  if (id && palCatalogByTribe.has(id)) return palCatalogByTribe.get(id);

  const byName = palCatalogByName.get(normalizedName(spawn.palName));
  if (byName?.length) {
    return byName.find(record => record.palDeckIndex > 0 && !record.boss && !record.towerBoss && !record.raidBoss) || byName[0];
  }
  return null;
}

function possibleSpawnMatchesFilters(spawn, meta = resolvePossibleSpawnMeta(spawn)) {
  if (!el("showPossibleSpawns").checked) return false;

  if (!meta) {
    if (!el("typeUnknown").checked) return false;
  } else {
    if (!selectedSpecies.has(normalizedName(meta.name))) return false;
    if (meta.rarity != null && !selectedRarities.has(Number(meta.rarity))) return false;
    if (meta.elements?.length && !meta.elements.some(element => selectedElements.has(element))) return false;

    if (String(spawn.kind || "").toLowerCase() === "alpha") {
      if (!el("typeBoss").checked) return false;
    } else if (!specialTypeAllowed(meta)) {
      return false;
    }
  }

  const q = el("searchInput").value.trim().toLowerCase();
  if (q) {
    const haystack = `${spawn.palName || ""} ${spawn.palId || ""} ${meta?.name || ""}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }

  return true;
}

function possibleSpawnPixel(spawn, area) {
  const wx = Number(spawn.worldX);
  const wy = Number(spawn.worldY);
  if (!Number.isFinite(wx) || !Number.isFinite(wy)) return null;
  const pos = worldToImagePixel(wx, wy, area);
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return null;
  return pos;
}

function updatePossibleSpawnState() {
  const state = el("possibleSpawnState");
  if (!state) return;

  if (!possibleSpawnReady) {
    state.textContent = possibleSpawnSource?.error
      ? `Spawn database unavailable: ${possibleSpawnSource.error}`
      : "Loading spawn database…";
    return;
  }

  const areaSpawns = possibleSpawnsByArea[activeArea] || [];
  const matching = areaSpawns.filter(spawn => possibleSpawnMatchesFilters(spawn)).length;
  const sourceBits = [
    possibleSpawnSource?.gameVersion ? `game ${possibleSpawnSource.gameVersion}` : null,
    possibleSpawnSource?.steamBuildId ? `build ${possibleSpawnSource.steamBuildId}` : null,
    possibleSpawnSource?.cached ? "cached" : "current"
  ].filter(Boolean);

  state.textContent = el("showPossibleSpawns").checked
    ? `${matching.toLocaleString()} matching possible spawn entries on this map · ${sourceBits.join(" · ")}`
    : `Ready · ${areaSpawns.length.toLocaleString()} spawn entries · turn on to display · ${sourceBits.join(" · ")}`;
}

async function loadPossibleSpawnData(force = false) {
  possibleSpawnReady = false;
  possibleSpawnSource = null;
  updatePossibleSpawnState();

  try {
    const response = await fetch(force ? "/api/spawn-data-refresh" : "/api/spawn-data", {
      method: force ? "POST" : "GET",
      cache: "no-store"
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);

    possibleSpawnsByArea = {
      MainMap: Array.isArray(result.regions?.MainMap) ? result.regions.MainMap : [],
      Tree: Array.isArray(result.regions?.Tree) ? result.regions.Tree : []
    };
    possibleSpawnSource = {
      source: result.source,
      steamBuildId: result.steamBuildId,
      generatedAt: result.generatedAt,
      gameVersion: result.gameVersion,
      cached: Boolean(result.cached)
    };
    possibleSpawnReady = true;
    lastPossibleSpawnCount = -1;
    updatePossibleSpawnState();
  } catch (error) {
    possibleSpawnReady = false;
    possibleSpawnSource = { error: String(error?.message || error) };
    updatePossibleSpawnState();
  }
}

function possibleSpawnHitRadius(marker) {
  const pref = marker?.meta ? speciesPreference(marker.meta) : DEFAULT_PAL_MARKER;
  const size = Math.max(8, Math.min(44, (Number(pref.size) || DEFAULT_PAL_MARKER.size) * 0.78));
  return Math.max(8, size / 2 + 4);
}


function filters() {
  return {
    Player: el("showPlayers").checked,
    WildPal: el("showWild").checked,
    OtomoPal: el("showCompanions").checked,
    BaseCampPal: el("showBasePals").checked,
    NPC: el("showNpcs").checked,
    PalBox: el("showPalboxes").checked
  };
}

function actorVisible(actor) {
  const type = actor.UnitType || actor.Type;
  if (!filters()[type]) return false;
  if (el("aliveOnly").checked && !actorAlive(actor)) return false;
  if (el("activeOnly").checked && !actorIsActive(actor)) return false;
  if (type === "WildPal" && palCatalogReady && !matchesPalFilters(actor)) return false;

  const q = el("searchInput").value.trim().toLowerCase();
  if (!q) return true;
  const meta = type === "WildPal" ? resolvePalMeta(actor) : null;
  const haystack = `${actor.NickName || ""} ${actor.Class || ""} ${actor.GuildName || ""} ${actor.userid || ""} ${meta?.name || ""} ${meta?.elements?.join(" ") || ""} ${meta?.rarity ?? ""}`.toLowerCase();
  return haystack.includes(q);
}

function resizeCanvases() {
  const rect = mapHost.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (const [canvas, ctx] of [[mapCanvas, mapCtx], [actorCanvas, actorCtx]]) {
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  clampCamera();
  drawMap();
}

function fitMap() {
  const rect = mapHost.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  camera.scale = Math.min(rect.width / MAP_SIZE, rect.height / MAP_SIZE) * 0.96;
  camera.x = (rect.width - MAP_SIZE * camera.scale) / 2;
  camera.y = (rect.height - MAP_SIZE * camera.scale) / 2;
  followPlayerId = "";
  el("followSelect").value = "";
  drawMap();
}

function clampCamera() {
  const rect = mapHost.getBoundingClientRect();
  const mapW = MAP_SIZE * camera.scale;
  const mapH = MAP_SIZE * camera.scale;
  const marginX = Math.min(rect.width * 0.35, 240);
  const marginY = Math.min(rect.height * 0.35, 180);

  if (mapW <= rect.width) {
    camera.x = (rect.width - mapW) / 2;
  } else {
    camera.x = Math.min(marginX, Math.max(rect.width - mapW - marginX, camera.x));
  }

  if (mapH <= rect.height) {
    camera.y = (rect.height - mapH) / 2;
  } else {
    camera.y = Math.min(marginY, Math.max(rect.height - mapH - marginY, camera.y));
  }
}

function clearMapCanvas() {
  const rect = mapHost.getBoundingClientRect();
  mapCtx.fillStyle = "#0a131c";
  mapCtx.fillRect(0, 0, rect.width, rect.height);

  // Visible loading/error grid so failure can never look like an unexplained black screen.
  mapCtx.strokeStyle = "rgba(104, 135, 158, 0.12)";
  mapCtx.lineWidth = 1;
  const step = 48;
  for (let x = 0; x < rect.width; x += step) {
    mapCtx.beginPath();
    mapCtx.moveTo(x, 0);
    mapCtx.lineTo(x, rect.height);
    mapCtx.stroke();
  }
  for (let y = 0; y < rect.height; y += step) {
    mapCtx.beginPath();
    mapCtx.moveTo(0, y);
    mapCtx.lineTo(rect.width, y);
    mapCtx.stroke();
  }
}

function drawMap() {
  clearMapCanvas();
  if (!mapReady || !mapImage?.naturalWidth || !mapImage?.naturalHeight) return;

  const rect = mapHost.getBoundingClientRect();
  const scale = camera.scale;

  const viewLeft = Math.max(0, -camera.x / scale);
  const viewTop = Math.max(0, -camera.y / scale);
  const viewRight = Math.min(MAP_SIZE, (rect.width - camera.x) / scale);
  const viewBottom = Math.min(MAP_SIZE, (rect.height - camera.y) / scale);

  if (viewRight <= viewLeft || viewBottom <= viewTop) return;

  const logicalW = viewRight - viewLeft;
  const logicalH = viewBottom - viewTop;
  const sourceScaleX = mapImage.naturalWidth / MAP_SIZE;
  const sourceScaleY = mapImage.naturalHeight / MAP_SIZE;

  const sx = viewLeft * sourceScaleX;
  const sy = viewTop * sourceScaleY;
  const sw = logicalW * sourceScaleX;
  const sh = logicalH * sourceScaleY;

  const dx = camera.x + viewLeft * scale;
  const dy = camera.y + viewTop * scale;
  const dw = logicalW * scale;
  const dh = logicalH * scale;

  try {
    mapCtx.imageSmoothingEnabled = true;
    mapCtx.drawImage(mapImage, sx, sy, sw, sh, dx, dy, dw, dh);
  } catch (error) {
    showMapError(`Canvas draw failed: ${error?.message || error}`);
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(Number(bytes))) return "unknown size";
  const b = Number(bytes);
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

function showMapLoading(message) {
  notice.className = "map-notice";
  notice.innerHTML = `<strong>Map loading</strong><span>${escapeHtml(message)}</span>`;
}

function showMapError(message) {
  notice.className = "map-notice error";
  notice.innerHTML = `<strong>Map error</strong><span>${escapeHtml(message)}</span>
    <span>Use “Re-download current maps” or check Map diagnostics below.</span>`;
}

function hideMapNotice() {
  notice.classList.add("hidden");
}

async function getMapDiagnostics() {
  try {
    const response = await fetch("/api/map-diagnostics", { cache: "no-store" });
    return await response.json();
  } catch {
    return null;
  }
}

async function waitForMapFile(area, token) {
  const def = MAP_AREAS[area];
  mapLoadAttempts = 0;

  while (token === mapLoadToken && mapLoadAttempts < 45) {
    mapLoadAttempts += 1;
    const diagnostics = await getMapDiagnostics();
    const file = diagnostics?.files?.[def.file.split("/").pop()];

    if (file?.valid) {
      showMapLoading(`${def.file.split("/").pop()} ready (${formatBytes(file.bytes)}). Decoding image…`);
      return true;
    }

    const runtime = file?.runtime;
    if (runtime?.error) {
      showMapError(`${runtime.error}`);
      return false;
    }

    const status = runtime?.downloading
      ? `Downloading ${def.file.split("/").pop()}${runtime.bytes ? ` (${formatBytes(runtime.bytes)})` : ""}…`
      : `Waiting for ${def.file.split("/").pop()}…`;
    showMapLoading(status);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}

async function loadArea(area) {
  activeArea = area;
  mapReady = false;
  mapImage = null;
  const token = ++mapLoadToken;

  for (const btn of document.querySelectorAll(".tab")) {
    btn.classList.toggle("active", btn.dataset.area === area);
  }

  markerById.clear();
  showMapLoading(`Preparing ${area === "Tree" ? "World Tree" : "Palpagos"} map…`);
  clearMapCanvas();

  const ready = await waitForMapFile(area, token);
  if (!ready || token !== mapLoadToken) return;

  const def = MAP_AREAS[area];
  const img = new Image();
  img.decoding = "async";

  const loaded = await new Promise((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = `${def.file}?v=${Date.now()}`;
  });

  if (token !== mapLoadToken) return;
  if (!loaded) {
    showMapError(`Browser could not decode ${def.file.split("/").pop()}.`);
    return;
  }

  if (!img.naturalWidth || !img.naturalHeight) {
    showMapError(`Map decoded with invalid dimensions ${img.naturalWidth}×${img.naturalHeight}.`);
    return;
  }

  mapImage = img;
  mapReady = true;
  hideMapNotice();
  fitMap();
  if (lastSnapshot) renderSnapshot(lastSnapshot);

  el("mapAssetState").textContent =
    `✓ ${def.file.split("/").pop()} decoded ${img.naturalWidth}×${img.naturalHeight}\n` +
    `Renderer: Canvas 2D viewport crop (no WebGL map texture)`;
}

function playerColor(id) {
  if (!playerColorById.has(id)) {
    playerColorById.set(id, PLAYER_COLORS[playerColorById.size % PLAYER_COLORS.length]);
  }
  return playerColorById.get(id);
}

function addAlert(alert, desktop = true) {
  alerts.unshift(alert);
  if (alerts.length > 600) alerts.length = 600;
  renderAlerts();

  if (desktop && el("desktopNotifications").checked && "Notification" in window && Notification.permission === "granted") {
    const title = alert.kind === "spawn" ? `Pal spawned: ${alert.name}` : `Pal present: ${alert.name}`;
    const body = `${alert.count > 1 ? `${alert.count} present · ` : ""}${alert.rarityLabel}${alert.elements?.length ? ` · ${alert.elements.join("/")}` : ""}${alert.level != null ? ` · Lv ${alert.level}` : ""}`;
    try { new Notification(title, { body }); } catch {}
  }
}

function alertForActor(actor, kind = "spawn") {
  const meta = resolvePalMeta(actor);
  return {
    kind,
    id: actorId(actor),
    name: meta?.name || actor.NickName || actor.Class || "Unknown Wild Pal",
    className: actor.Class || "",
    rarity: meta?.rarity ?? null,
    rarityLabel: meta?.rarity == null ? "Rarity unknown" : `R${meta.rarity} · ${rarityTier(meta.rarity)}`,
    elements: meta?.elements || [],
    special: meta ? [
      meta.boss || meta.towerBoss ? "Boss" : null,
      meta.raidBoss ? "Raid" : null,
      meta.predator ? "Predator" : null
    ].filter(Boolean) : ["Unmatched"],
    level: actor.level,
    x: Number(actor.LocationX) || 0,
    y: Number(actor.LocationY) || 0,
    z: Number(actor.LocationZ) || 0,
    count: 1,
    time: new Date().toLocaleTimeString()
  };
}

function scanCurrentWorld({ automatic = false, dedupe = false } = {}) {
  if (!lastSnapshot || !palCatalogReady) return;

  const actors = Array.isArray(lastSnapshot.ActorData) ? lastSnapshot.ActorData : [];
  const allWild = actors.filter(actor =>
    actor.UnitType === "WildPal" &&
    actorAlive(actor) &&
    actorIsActive(actor)
  );

  // Allow a despawned InstanceID to alert again if it later returns.
  const loadedIds = new Set(allWild.map((actor, index) => actorId(actor, index)));
  for (const id of [...presentAlertedIds]) {
    if (!loadedIds.has(id)) presentAlertedIds.delete(id);
  }

  let matches = allWild.filter(actor => matchesPalAlertFilters(actor));

  if (dedupe) {
    matches = matches.filter((actor, index) => !presentAlertedIds.has(actorId(actor, index)));
  }

  const groups = new Map();
  for (let i = 0; i < matches.length; i++) {
    const actor = matches[i];
    const id = actorId(actor, i);
    presentAlertedIds.add(id);

    const entry = alertForActor(actor, "present");
    const groupKey = `${normalizedName(entry.name)}|${entry.rarity}|${entry.elements.join(",")}`;
    if (!groups.has(groupKey)) groups.set(groupKey, entry);
    else groups.get(groupKey).count += 1;
  }

  const grouped = [...groups.values()]
    .sort((a, b) => (b.rarity ?? -1) - (a.rarity ?? -1) || a.name.localeCompare(b.name));

  for (const entry of [...grouped].reverse()) addAlert(entry, false);

  if (
    el("desktopNotifications").checked &&
    "Notification" in window &&
    Notification.permission === "granted" &&
    grouped.length
  ) {
    const total = grouped.reduce((sum, entry) => sum + entry.count, 0);
    try {
      new Notification(`Palworld tracker: ${total} matching Pals present`, {
        body: `${grouped.length} Pal types matched your current filters.`
      });
    } catch {}
  }

  const totalMatching = allWild.filter(actor => matchesPalAlertFilters(actor)).length;
  const scanText = automatic
    ? `Auto-scan: ${totalMatching} matching loaded Pals · ${grouped.length} newly reportable types.`
    : `${totalMatching} matching Wild Pals currently loaded · ${grouped.length} Pal types reported.`;
  el("alertSummary").textContent = scanText;

  if (!grouped.length && !automatic) {
    addAlert({
      kind: "present",
      name: "No new matching Pals",
      rarityLabel: "Current-world scan",
      elements: [],
      special: [],
      level: null,
      x: 0, y: 0, z: 0,
      count: 0,
      time: new Date().toLocaleTimeString(),
      nonSpatial: true
    }, false);
  }
}

function updatePalAlerts(actors) {
  const wild = actors.filter(actor => actor.UnitType === "WildPal" && actorAlive(actor) && actorIsActive(actor));
  const currentIds = new Set(wild.map((actor, index) => actorId(actor, index)));

  if (!palCatalogReady) {
    previousWildIds = currentIds;
    return;
  }

  if (!initialWorldAlerted) {
    previousWildIds = currentIds;
    initialWorldAlerted = true;
    if (el("alertCurrent").checked) scanCurrentWorld({ automatic: true });
    return;
  }

  if (el("alertSpawns").checked) {
    for (let i = 0; i < wild.length; i++) {
      const actor = wild[i];
      const id = actorId(actor, i);
      if (!previousWildIds.has(id) && matchesPalAlertFilters(actor)) {
        presentAlertedIds.add(id);
        addAlert(alertForActor(actor, "spawn"), true);
      }
    }
  }
  previousWildIds = currentIds;

  for (const id of [...presentAlertedIds]) {
    if (!currentIds.has(id)) presentAlertedIds.delete(id);
  }

  const matching = wild.filter(actor => matchesPalAlertFilters(actor)).length;
  el("alertSummary").textContent = `${matching}/${wild.length} loaded Wild Pals match your tracker filters.`;
}

function renderAlerts() {
  const list = el("alertsList");
  if (!alerts.length) {
    list.className = "alerts-list muted";
    list.textContent = "No matching Pal alerts yet.";
    return;
  }

  list.className = "alerts-list";
  list.innerHTML = alerts.map((a, index) => {
    const rarityClass = Number(a.rarity) >= 8 || Number(a.rarity) === 20 ? " rare" : "";
    const spatialHint = a.nonSpatial ? "" : `<span>${escapeHtml(a.time)} · X ${Math.round(a.x)} Y ${Math.round(a.y)}</span>`;
    return `<div class="alert ${escapeAttr(a.kind || "present")}${rarityClass}" data-alert-index="${index}">
      <div class="alert-line"><strong>${escapeHtml(a.name)}${a.count > 1 ? ` ×${a.count}` : ""}${a.level != null ? ` · Lv ${a.level}` : ""}</strong><span class="rarity-tag">${escapeHtml(a.rarityLabel || "")}</span></div>
      <span class="elements">${escapeHtml([...(a.elements || []), ...(a.special || [])].join(" · "))}</span>
      ${spatialHint}
    </div>`;
  }).join("");
}

async function focusAlert(alert) {
  if (!alert || alert.nonSpatial) return;
  const area = mapOf(Number(alert.x), Number(alert.y));
  if (!area) return;
  if (area !== activeArea) await loadArea(area);
  const pos = worldToImagePixel(Number(alert.x), Number(alert.y), area);
  camera.scale = Math.max(camera.scale, 0.45);
  camera.x = mapHost.clientWidth / 2 - pos.x * camera.scale;
  camera.y = mapHost.clientHeight / 2 - pos.y * camera.scale;
  clampCamera();
  drawMap();
}

function renderSnapshot(snapshot) {
  lastSnapshot = snapshot;
  const actors = Array.isArray(snapshot?.ActorData) ? snapshot.ActorData : [];
  updatePalAlerts(actors);

  const present = new Set();
  const players = [];

  for (let i = 0; i < actors.length; i++) {
    const actor = actors[i];
    if (actor.UnitType === "Player") players.push(actor);

    const wx = Number(actor.LocationX);
    const wy = Number(actor.LocationY);
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) continue;
    if (mapOf(wx, wy) !== activeArea) continue;

    const id = actorId(actor, i);
    if (!actorVisible(actor)) continue;

    const pos = worldToImagePixel(wx, wy, activeArea);
    if (pos.x < -100 || pos.x > MAP_SIZE + 100 || pos.y < -100 || pos.y > MAP_SIZE + 100) continue;

    present.add(id);
    let marker = markerById.get(id);
    if (!marker) {
      marker = {
        id,
        type: actor.UnitType || actor.Type || "Unknown",
        actor,
        meta: actor.UnitType === "WildPal" ? resolvePalMeta(actor) : null,
        x: pos.x,
        y: pos.y,
        targetX: pos.x,
        targetY: pos.y
      };
      markerById.set(id, marker);
    } else {
      marker.actor = actor;
      marker.meta = actor.UnitType === "WildPal" ? resolvePalMeta(actor) : null;
      marker.type = actor.UnitType || actor.Type || marker.type;
      marker.targetX = pos.x;
      marker.targetY = pos.y;
    }
  }

  for (const id of [...markerById.keys()]) {
    if (!present.has(id)) markerById.delete(id);
  }

  updateStats(actors, snapshot);
  updatePlayers(players);
}

function updateStats(actors, snapshot) {
  const players = actors.filter(a => a.UnitType === "Player");
  const wild = actors.filter(a => a.UnitType === "WildPal" && actorAlive(a));
  const matched = palCatalogReady ? wild.filter(actor => Boolean(resolvePalMeta(actor))).length : 0;
  el("countPlayers").textContent = players.length;
  el("countWild").textContent = wild.length;
  el("countMatchedPals").textContent = palCatalogReady ? matched : "—";
  el("countUnmatchedPals").textContent = palCatalogReady ? wild.length - matched : "—";
  el("countActors").textContent = actors.length;
  el("snapshotTime").textContent = snapshot?.Time ? String(snapshot.Time).split(" ").pop() : "—";
}

function updatePlayers(players) {
  const list = el("playersList");
  if (!players.length) {
    list.className = "players-list muted";
    list.textContent = "No players in snapshot.";
  } else {
    list.className = "players-list";
    list.innerHTML = players.map((p, i) => `
      <div class="player-row">
        <div class="name">${escapeHtml(p.NickName || `Player ${i + 1}`)}</div>
        <div class="coords">Lv ${p.level ?? "—"} · X ${Math.round(Number(p.LocationX) || 0)} · Y ${Math.round(Number(p.LocationY) || 0)}</div>
      </div>
    `).join("");
  }

  const select = el("followSelect");
  const selected = select.value;
  select.innerHTML = `<option value="">Free camera</option>` + players.map((p, i) => {
    const id = actorId(p, i);
    return `<option value="${escapeAttr(id)}">${escapeHtml(p.NickName || `Player ${i + 1}`)}</option>`;
  }).join("");
  if ([...select.options].some(o => o.value === selected)) select.value = selected;
}

function markerScreenPosition(marker) {
  return {
    x: camera.x + marker.x * camera.scale,
    y: camera.y + marker.y * camera.scale
  };
}


function drawPossibleSpawns() {
  visiblePossibleSpawnMarkers = [];
  if (!possibleSpawnReady || !el("showPossibleSpawns").checked || !palCatalogReady) {
    if (lastPossibleSpawnCount !== 0 && !el("showPossibleSpawns").checked) {
      lastPossibleSpawnCount = 0;
      updatePossibleSpawnState();
    }
    return;
  }

  const rect = mapHost.getBoundingClientRect();
  const source = possibleSpawnsByArea[activeArea] || [];
  let matchingCount = 0;

  for (let index = 0; index < source.length; index++) {
    const spawn = source[index];
    const meta = resolvePossibleSpawnMeta(spawn);
    if (!possibleSpawnMatchesFilters(spawn, meta)) continue;
    matchingCount += 1;

    const pos = possibleSpawnPixel(spawn, activeArea);
    if (!pos) continue;

    const p = {
      x: camera.x + pos.x * camera.scale,
      y: camera.y + pos.y * camera.scale
    };
    if (p.x < -60 || p.x > rect.width + 60 || p.y < -60 || p.y > rect.height + 60) continue;

    const pref = meta ? speciesPreference(meta) : DEFAULT_PAL_MARKER;
    const size = Math.max(8, Math.min(44, (Number(pref.size) || DEFAULT_PAL_MARKER.size) * 0.78));
    const color = pref.color || DEFAULT_PAL_MARKER.color;
    const alpha = String(spawn.kind || "").toLowerCase() === "alpha" ? 0.42 : 0.30;
    const iconState = meta ? palIconImage(meta) : null;

    actorCtx.save();
    actorCtx.globalAlpha = alpha;

    // Dashed ring is the visual language for "possible, not live".
    actorCtx.setLineDash([Math.max(2, size * 0.14), Math.max(2, size * 0.12)]);
    actorCtx.beginPath();
    actorCtx.arc(p.x, p.y, size / 2 + 3, 0, Math.PI * 2);
    actorCtx.strokeStyle = color;
    actorCtx.lineWidth = Math.max(1.5, size * 0.09);
    actorCtx.stroke();
    actorCtx.setLineDash([]);

    if (iconState?.ready && !iconState.failed) {
      actorCtx.drawImage(iconState.image, p.x - size / 2, p.y - size / 2, size, size);
    } else {
      actorCtx.beginPath();
      actorCtx.arc(p.x, p.y, Math.max(3, size * 0.30), 0, Math.PI * 2);
      actorCtx.fillStyle = color;
      actorCtx.fill();
    }

    actorCtx.restore();

    visiblePossibleSpawnMarkers.push({
      id: `possible-${spawn.id || index}`,
      type: "PossibleSpawn",
      spawn,
      meta,
      x: pos.x,
      y: pos.y,
      screenX: p.x,
      screenY: p.y
    });
  }

  if (lastPossibleSpawnCount !== matchingCount) {
    lastPossibleSpawnCount = matchingCount;
    updatePossibleSpawnState();
  }
}


function drawActors() {
  const rect = mapHost.getBoundingClientRect();
  actorCtx.clearRect(0, 0, rect.width, rect.height);

  drawPossibleSpawns();

  const visibleMarkers = [];
  for (const marker of markerById.values()) {
    const p = markerScreenPosition(marker);
    if (p.x < -50 || p.x > rect.width + 50 || p.y < -50 || p.y > rect.height + 50) continue;
    visibleMarkers.push({ marker, p });
  }

  // Draw lightweight entities first.
  for (const { marker, p } of visibleMarkers) {
    if (marker.type === "Player") continue;

    const actor = marker.actor;

    if (marker.type === "WildPal" && marker.meta) {
      const pref = speciesPreference(marker.meta);
      const size = Math.max(6, Math.min(56, Number(pref.size) || DEFAULT_PAL_MARKER.size));
      const color = pref.color || DEFAULT_PAL_MARKER.color;
      const iconState = palIconImage(marker.meta);

      if (pref.mode === "dot") {
        actorCtx.beginPath();
        actorCtx.arc(p.x, p.y, size / 2, 0, Math.PI * 2);
        actorCtx.fillStyle = actorAlive(actor) ? color : "#747b82";
        actorCtx.fill();
        actorCtx.strokeStyle = "rgba(0,0,0,.70)";
        actorCtx.lineWidth = Math.max(1, size * 0.08);
        actorCtx.stroke();
      } else if (iconState?.ready && !iconState.failed) {
        const half = size / 2;

        if (pref.mode === "icon-ring") {
          actorCtx.beginPath();
          actorCtx.arc(p.x, p.y, half + 2, 0, Math.PI * 2);
          actorCtx.fillStyle = "rgba(5,12,18,.88)";
          actorCtx.fill();
          actorCtx.strokeStyle = color;
          actorCtx.lineWidth = Math.max(2, size * 0.10);
          actorCtx.stroke();
        }

        actorCtx.drawImage(iconState.image, p.x - half, p.y - half, size, size);
      } else {
        // Immediate fallback while the real Pal icon downloads.
        actorCtx.beginPath();
        actorCtx.arc(p.x, p.y, Math.max(3, size * 0.28), 0, Math.PI * 2);
        actorCtx.fillStyle = actorAlive(actor) ? color : "#747b82";
        actorCtx.fill();
        actorCtx.strokeStyle = "rgba(0,0,0,.70)";
        actorCtx.lineWidth = 1.2;
        actorCtx.stroke();
      }

      if (
        Number(marker.meta.rarity) >= 8 ||
        Number(marker.meta.rarity) === 20 ||
        Number(actor.level) >= 50
      ) {
        actorCtx.beginPath();
        actorCtx.arc(p.x, p.y, size / 2 + 5, 0, Math.PI * 2);
        actorCtx.strokeStyle = "#f0bb55";
        actorCtx.lineWidth = 1.5;
        actorCtx.stroke();
      }
      continue;
    }

    let fill = "#8bc47a";
    let radius = 3.2;
    if (marker.type === "NPC") fill = "#e0a95b";
    else if (marker.type === "BaseCampPal") fill = "#84a9ff";
    else if (marker.type === "OtomoPal") fill = "#d48cff";
    else if (marker.type === "PalBox") { fill = "#ffffff"; radius = 6; }

    if (!actorAlive(actor)) fill = "#747b82";

    actorCtx.beginPath();
    actorCtx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    actorCtx.fillStyle = fill;
    actorCtx.fill();
  }

  // Players on top.
  for (const { marker, p } of visibleMarkers) {
    if (marker.type !== "Player") continue;
    const actor = marker.actor;
    const color = playerColor(marker.id);
    const angle = ((Number(actor.RotationZ) || 0) - 90) * Math.PI / 180;

    actorCtx.save();
    actorCtx.translate(p.x, p.y);

    actorCtx.beginPath();
    actorCtx.arc(0, 0, 13, 0, Math.PI * 2);
    actorCtx.fillStyle = "rgba(7,16,25,.9)";
    actorCtx.fill();
    actorCtx.strokeStyle = color;
    actorCtx.lineWidth = 3;
    actorCtx.stroke();

    actorCtx.rotate(angle);
    actorCtx.beginPath();
    actorCtx.moveTo(13, 0);
    actorCtx.lineTo(-6, -6);
    actorCtx.lineTo(-2, 0);
    actorCtx.lineTo(-6, 6);
    actorCtx.closePath();
    actorCtx.fillStyle = color;
    actorCtx.fill();

    actorCtx.restore();

    const label = actor.NickName || "Player";
    actorCtx.font = "600 12px Segoe UI, Arial, sans-serif";
    actorCtx.textAlign = "center";
    actorCtx.textBaseline = "top";
    actorCtx.lineWidth = 4;
    actorCtx.strokeStyle = "rgba(0,0,0,.82)";
    actorCtx.strokeText(label, p.x, p.y + 17);
    actorCtx.fillStyle = "#ffffff";
    actorCtx.fillText(label, p.x, p.y + 17);
  }

  return visibleMarkers;
}

function updateHover(pointerX, pointerY) {
  let best = null;
  let bestDistance = Infinity;

  for (const marker of markerById.values()) {
    const p = markerScreenPosition(marker);
    const dx = p.x - pointerX;
    const dy = p.y - pointerY;
    const d = Math.hypot(dx, dy);
    const hit = markerHitRadius(marker);
    if (d <= hit && d < bestDistance) {
      best = marker;
      bestDistance = d;
    }
  }

  if (!best) {
    for (const marker of visiblePossibleSpawnMarkers) {
      const dx = marker.screenX - pointerX;
      const dy = marker.screenY - pointerY;
      const d = Math.hypot(dx, dy);
      const hit = possibleSpawnHitRadius(marker);
      if (d <= hit && d < bestDistance) {
        best = marker;
        bestDistance = d;
      }
    }
  }

  hoveredMarker = best;
  if (!best) {
    hoverCard.classList.add("hidden");
    actorCanvas.style.cursor = dragging ? "grabbing" : "grab";
    return;
  }

  actorCanvas.style.cursor = "pointer";

  if (best.type === "PossibleSpawn") {
    const spawn = best.spawn;
    const meta = best.meta;
    const name = meta?.name || spawn.palName || spawn.palId || "Possible Pal spawn";
    const levelText = Number(spawn.minLevel) === Number(spawn.maxLevel)
      ? `Lv ${Number(spawn.minLevel) || "—"}`
      : `Lv ${Number(spawn.minLevel) || "—"}–${Number(spawn.maxLevel) || "—"}`;
    const availability = String(spawn.availability || "both");
    const kind = String(spawn.kind || "wild").toLowerCase() === "alpha" ? "Possible Alpha spawn" : "Possible spawn";
    const weight = Number(spawn.weight);

    hoverCard.innerHTML = `<strong>${escapeHtml(name)}</strong>
      <span>${escapeHtml(kind)} · faded ghost marker</span>
      ${meta ? `<span>${escapeHtml(`R${meta.rarity} · ${rarityTier(meta.rarity)}`)}${meta.elements?.length ? ` · ${escapeHtml(meta.elements.join("/"))}` : ""}</span>` : ""}
      <span>${escapeHtml(levelText)} · ${escapeHtml(availability)}${Number.isFinite(weight) ? ` · spawn weight ${escapeHtml(weight)}` : ""}</span>
      <span>X ${Math.round(Number(spawn.worldX) || 0)} · Y ${Math.round(Number(spawn.worldY) || 0)}</span>
      <span class="muted">Spawn weight is relative game data, not a guaranteed percentage.</span>`;
    hoverCard.classList.remove("hidden");
    hoverCard.style.left = `${Math.min(pointerX + 14, mapHost.clientWidth - 245)}px`;
    hoverCard.style.top = `${Math.min(pointerY + 14, mapHost.clientHeight - 145)}px`;
    return;
  }

  const actor = best.actor;
  const meta = best.meta || (best.type === "WildPal" ? resolvePalMeta(actor) : null);
  const name = meta?.name || actor.NickName || actor.Class || best.type || "Actor";
  const palDetails = meta
    ? `<span>${escapeHtml(`R${meta.rarity} · ${rarityTier(meta.rarity)}`)}${meta.elements?.length ? ` · ${escapeHtml(meta.elements.join("/"))}` : ""}</span>
       <span>${escapeHtml([meta.boss || meta.towerBoss ? "Boss" : null, meta.raidBoss ? "Raid" : null, meta.predator ? "Predator" : null].filter(Boolean).join(" · ") || "Normal Pal")}</span>`
    : best.type === "WildPal" ? `<span>Pal metadata unmatched · ${escapeHtml(actor.Class || "unknown class")}</span>` : "";
  hoverCard.innerHTML = `<strong>${escapeHtml(name)}</strong>
    <span>${escapeHtml(best.type)}</span>
    ${palDetails}
    <span>Lv ${escapeHtml(actor.level ?? "—")} · HP ${escapeHtml(actor.HP ?? "—")}/${escapeHtml(actor.MaxHP ?? "—")}</span>
    <span>X ${Math.round(Number(actor.LocationX) || 0)} · Y ${Math.round(Number(actor.LocationY) || 0)} · Z ${Math.round(Number(actor.LocationZ) || 0)}</span>`;
  hoverCard.classList.remove("hidden");
  hoverCard.style.left = `${Math.min(pointerX + 14, mapHost.clientWidth - 220)}px`;
  hoverCard.style.top = `${Math.min(pointerY + 14, mapHost.clientHeight - 110)}px`;
}

function animationLoop() {
  let cameraMoved = false;
  const smoothing = 0.18;

  for (const marker of markerById.values()) {
    marker.x += (marker.targetX - marker.x) * smoothing;
    marker.y += (marker.targetY - marker.y) * smoothing;
  }

  if (followPlayerId) {
    const marker = markerById.get(followPlayerId);
    if (marker) {
      camera.x = mapHost.clientWidth / 2 - marker.x * camera.scale;
      camera.y = mapHost.clientHeight / 2 - marker.y * camera.scale;
      clampCamera();
      cameraMoved = true;
    }
  }

  if (cameraMoved) drawMap();
  drawActors();
  requestAnimationFrame(animationLoop);
}

function pointerInHost(event) {
  const rect = mapHost.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

actorCanvas.addEventListener("pointerdown", (event) => {
  const p = pointerInHost(event);
  updateHover(p.x, p.y);
  if (hoveredMarker) return;

  dragging = true;
  actorCanvas.setPointerCapture(event.pointerId);
  actorCanvas.style.cursor = "grabbing";
  followPlayerId = "";
  el("followSelect").value = "";
  dragStart = p;
  cameraStart = { x: camera.x, y: camera.y };
});

actorCanvas.addEventListener("pointermove", (event) => {
  const p = pointerInHost(event);

  if (dragging) {
    camera.x = cameraStart.x + (p.x - dragStart.x);
    camera.y = cameraStart.y + (p.y - dragStart.y);
    clampCamera();
    drawMap();
    hoverCard.classList.add("hidden");
  } else {
    updateHover(p.x, p.y);
  }
});

function stopDrag(event) {
  dragging = false;
  try { actorCanvas.releasePointerCapture(event.pointerId); } catch {}
  actorCanvas.style.cursor = hoveredMarker ? "pointer" : "grab";
}

actorCanvas.addEventListener("pointerup", stopDrag);
actorCanvas.addEventListener("pointercancel", stopDrag);
actorCanvas.addEventListener("pointerleave", () => {
  if (!dragging) hoverCard.classList.add("hidden");
});

actorCanvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  followPlayerId = "";
  el("followSelect").value = "";

  const p = pointerInHost(event);
  const oldScale = camera.scale;
  const factor = Math.exp(-event.deltaY * 0.0014);
  const minScale = Math.min(mapHost.clientWidth, mapHost.clientHeight) / MAP_SIZE * 0.35;
  const newScale = Math.max(Math.max(0.02, minScale), Math.min(4, oldScale * factor));

  const worldX = (p.x - camera.x) / oldScale;
  const worldY = (p.y - camera.y) / oldScale;
  camera.scale = newScale;
  camera.x = p.x - worldX * newScale;
  camera.y = p.y - worldY * newScale;
  clampCamera();
  drawMap();
}, { passive: false });

actorCanvas.addEventListener("click", () => {
  if (hoveredMarker?.type === "Player") {
    followPlayerId = hoveredMarker.id;
    el("followSelect").value = hoveredMarker.id;
    return;
  }

  if (hoveredMarker?.type === "WildPal" && hoveredMarker.meta) {
    openSpeciesEditor(normalizedName(hoveredMarker.meta.name));
    return;
  }

  if (hoveredMarker?.type === "PossibleSpawn" && hoveredMarker.meta) {
    openSpeciesEditor(normalizedName(hoveredMarker.meta.name));
  }
});

for (const btn of document.querySelectorAll(".tab")) {
  btn.addEventListener("click", async () => {
    await loadArea(btn.dataset.area);
    lastPossibleSpawnCount = -1;
    updatePossibleSpawnState();
  });
}

el("fitButton").addEventListener("click", fitMap);
el("followSelect").addEventListener("change", (event) => {
  followPlayerId = event.target.value;
});

el("speciesSearch").addEventListener("input", renderSpeciesList);
el("speciesAll").addEventListener("click", () => {
  selectedSpecies = new Set(palSpecies.map(record => normalizedName(record.name)));
  renderSpeciesList();
  if (lastSnapshot) renderSnapshot(lastSnapshot);
  lastPossibleSpawnCount = -1;
  updatePossibleSpawnState();
});
el("speciesNone").addEventListener("click", () => {
  selectedSpecies.clear();
  renderSpeciesList();
  if (lastSnapshot) renderSnapshot(lastSnapshot);
  lastPossibleSpawnCount = -1;
  updatePossibleSpawnState();
});
el("speciesList").addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-config-species]");
  if (!button) return;
  openSpeciesEditor(button.dataset.configSpecies);
});

el("speciesList").addEventListener("change", (event) => {
  const input = event.target.closest?.("input[data-species]");
  if (!input) return;
  if (input.checked) selectedSpecies.add(input.dataset.species);
  else selectedSpecies.delete(input.dataset.species);
  el("speciesSelectedCount").textContent = selectedSpecies.size === palSpecies.length ? `All ${palSpecies.length}` : `${selectedSpecies.size}/${palSpecies.length}`;
  if (lastSnapshot) renderSnapshot(lastSnapshot);
  lastPossibleSpawnCount = -1;
  updatePossibleSpawnState();
});
for (const id of ["speciesMarkerMode", "speciesMarkerSize", "speciesMarkerColor", "speciesAlertsEnabled"]) {
  el(id).addEventListener("input", applySpeciesEditorChange);
  el(id).addEventListener("change", applySpeciesEditorChange);
}

el("speciesResetStyle").addEventListener("click", () => {
  if (!selectedSpeciesEditor) return;
  resetSpeciesPreference(selectedSpeciesEditor);
  openSpeciesEditor(selectedSpeciesEditor);
  renderSpeciesList();
});

el("speciesCloseEditor").addEventListener("click", () => {
  selectedSpeciesEditor = "";
  el("speciesEditor").classList.add("hidden");
});

el("showPossibleSpawns").checked = trackerPrefs.showPossibleSpawns === true;
el("showPossibleSpawns").addEventListener("change", (event) => {
  trackerPrefs.showPossibleSpawns = event.target.checked;
  saveTrackerPrefs();
  lastPossibleSpawnCount = -1;
  updatePossibleSpawnState();
});

el("autoScanEnabled").checked = trackerPrefs.autoScanEnabled !== false;
el("autoScanSeconds").value = String(Math.max(2, Math.min(3600, Number(trackerPrefs.autoScanSeconds) || 10)));

el("autoScanEnabled").addEventListener("change", restartAutoScan);
el("autoScanSeconds").addEventListener("change", restartAutoScan);

el("rarityFilters").addEventListener("change", (event) => {
  const input = event.target.closest?.("input[data-rarity]");
  if (!input) return;
  const rarity = Number(input.dataset.rarity);
  if (input.checked) selectedRarities.add(rarity); else selectedRarities.delete(rarity);
  const total = el("rarityFilters").querySelectorAll("input[data-rarity]").length;
  el("raritySelectedCount").textContent = selectedRarities.size === total ? `All ${total}` : `${selectedRarities.size}/${total}`;
  if (lastSnapshot) renderSnapshot(lastSnapshot);
  lastPossibleSpawnCount = -1;
  updatePossibleSpawnState();
});
el("elementFilters").addEventListener("change", (event) => {
  const input = event.target.closest?.("input[data-element]");
  if (!input) return;
  if (input.checked) selectedElements.add(input.dataset.element); else selectedElements.delete(input.dataset.element);
  const total = el("elementFilters").querySelectorAll("input[data-element]").length;
  el("elementSelectedCount").textContent = selectedElements.size === total ? `All ${total}` : `${selectedElements.size}/${total}`;
  if (lastSnapshot) renderSnapshot(lastSnapshot);
  lastPossibleSpawnCount = -1;
  updatePossibleSpawnState();
});
for (const id of ["typeNormal", "typeBoss", "typeRaid", "typePredator", "typeUnknown"]) {
  el(id).addEventListener("change", () => {
    if (lastSnapshot) renderSnapshot(lastSnapshot);
    lastPossibleSpawnCount = -1;
    updatePossibleSpawnState();
  });
}
el("scanCurrent").addEventListener("click", () => {
  presentAlertedIds.clear();
  scanCurrentWorld({ automatic: false, dedupe: false });
});
el("clearAlerts").addEventListener("click", () => { alerts.length = 0; renderAlerts(); });
el("alertsList").addEventListener("click", (event) => {
  const row = event.target.closest?.("[data-alert-index]");
  if (!row) return;
  focusAlert(alerts[Number(row.dataset.alertIndex)]);
});
el("desktopNotifications").addEventListener("change", async (event) => {
  if (!event.target.checked) return;
  if (!("Notification" in window)) {
    event.target.checked = false;
    el("alertSummary").textContent = "Desktop notifications are not supported by this browser.";
    return;
  }
  if (Notification.permission !== "granted") {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      event.target.checked = false;
      el("alertSummary").textContent = "Desktop notification permission was not granted.";
    }
  }
});

for (const id of ["showPlayers", "showWild", "showCompanions", "showBasePals", "showNpcs", "showPalboxes", "aliveOnly", "activeOnly"]) {
  el(id).addEventListener("change", () => lastSnapshot && renderSnapshot(lastSnapshot));
}
el("searchInput").addEventListener("input", () => {
  if (lastSnapshot) renderSnapshot(lastSnapshot);
  lastPossibleSpawnCount = -1;
  updatePossibleSpawnState();
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[c]);
}
function escapeAttr(value) { return escapeHtml(value); }

async function loadStatus() {
  const response = await fetch("/api/status", { cache: "no-store" });
  const status = await response.json();
  applyStatus(status);
}

function applyStatus(status) {
  if (!status) return;

  const online = Boolean(status.connected);
  el("statusDot").classList.toggle("online", online);
  el("statusDot").classList.toggle("offline", !online);
  el("statusText").textContent = status.mock
    ? "Demo mode"
    : online
      ? `Connected · ${status.info?.servername || "Palworld server"}`
      : status.lastError || "Connecting…";
  el("fpsBadge").textContent = status.fps != null ? `FPS ${Number(status.fps).toFixed(1)}` : "FPS —";

  if (status.config?.palworld) {
    const cfg = status.config.palworld;
    if (!el("cfgHost").value) el("cfgHost").value = cfg.host ?? "";
    if (!el("cfgPort").value) el("cfgPort").value = cfg.port ?? "";
    if (!el("cfgUser").value) el("cfgUser").value = cfg.username ?? "admin";
    if (!el("cfgPoll").value) el("cfgPoll").value = cfg.pollIntervalMs ?? 750;

    if (status.config.configLocked) {
      for (const id of ["cfgHost", "cfgPort", "cfgUser", "cfgPassword", "cfgPoll", "saveConfig"]) {
        el(id).disabled = true;
      }
      el("cfgPassword").placeholder = "Managed by Koyeb secret";
      el("testConnection").textContent = "Test deployed connection";
      const notice = el("deploymentConfigNotice");
      if (notice) {
        notice.classList.remove("hidden");
        notice.textContent = "Connection settings are managed by Koyeb environment variables.";
      }
    }
  }

  if (status.mapAssetStatus && !mapReady) {
    const lines = Object.entries(status.mapAssetStatus).map(([file, s]) => {
      if (s.ready) return `✓ ${file} ${s.bytes ? formatBytes(s.bytes) : "cached"}`;
      if (s.downloading) return `… ${file} downloading`;
      return `× ${file}: ${s.error || "not ready"}`;
    });
    el("mapAssetState").textContent = lines.join("\n") || "Map download starting…";
  }
}

const events = new EventSource("/events");
events.onmessage = (event) => {
  try {
    const msg = JSON.parse(event.data);
    if (msg.kind === "snapshot") renderSnapshot(msg.snapshot);
    else if (msg.kind === "status") applyStatus(msg);
    else if (msg.kind === "map-assets") applyStatus({ mapAssetStatus: msg.mapAssetStatus });
    else if (msg.kind === "pal-data" && !palCatalogReady) {
      const ready = Object.values(msg.palDataStatus || {}).every(status => status.ready);
      if (ready) loadPalCatalog();
    }
  } catch (error) {
    console.error(error);
  }
};
events.onerror = () => {
  el("statusDot").classList.remove("online");
  el("statusText").textContent = "Local tracker connection interrupted";
};

function currentConnectionPayload() {
  return {
    palworld: {
      host: el("cfgHost").value.trim(),
      port: Number(el("cfgPort").value),
      username: el("cfgUser").value.trim(),
      password: el("cfgPassword").value,
      pollIntervalMs: Number(el("cfgPoll").value)
    }
  };
}

el("saveConfig").addEventListener("click", async () => {
  const response = await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(currentConnectionPayload())
  });
  const result = await response.json();
  el("connectionResult").textContent = JSON.stringify(result, null, 2);
  el("cfgPassword").value = "";
});

el("testConnection").addEventListener("click", async () => {
  const out = el("connectionResult");
  out.textContent = "Testing the deployed Palworld /info and /game-data connection…";

  try {
    const payload = currentConnectionPayload();
    payload.persist = true;
    const response = await fetch("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    out.textContent = JSON.stringify(result, null, 2);
    if (result.ok) el("cfgPassword").value = "";
  } catch (error) {
    out.textContent = String(error?.message || error);
  }
});

el("refreshMap").addEventListener("click", async () => {
  mapReady = false;
  showMapLoading("Deleting bad cache and downloading fresh current maps…");
  await fetch("/api/map-refresh", { method: "POST" });
  setTimeout(() => loadArea(activeArea), 800);
});

el("refreshPalCatalog").addEventListener("click", async () => {
  const out = el("connectionResult");
  out.textContent = "Downloading the current pinned Palworld 1.0 Pal catalog…";
  try {
    const response = await fetch("/api/pal-catalog-refresh", { method: "POST" });
    const result = await response.json();
    out.textContent = JSON.stringify(result, null, 2);
    palCatalogReady = false;
    palMetaCache.clear();
    await loadPalCatalog();
  } catch (error) {
    out.textContent = String(error?.message || error);
  }
});


el("refreshSpawnData").addEventListener("click", async () => {
  const out = el("connectionResult");
  out.textContent = "Refreshing current Palworld possible-spawn database…";
  await loadPossibleSpawnData(true);

  if (possibleSpawnReady) {
    out.textContent = JSON.stringify({
      ok: true,
      steamBuildId: possibleSpawnSource?.steamBuildId,
      gameVersion: possibleSpawnSource?.gameVersion,
      generatedAt: possibleSpawnSource?.generatedAt,
      counts: {
        MainMap: possibleSpawnsByArea.MainMap.length,
        Tree: possibleSpawnsByArea.Tree.length
      }
    }, null, 2);
  } else {
    out.textContent = JSON.stringify({
      ok: false,
      error: possibleSpawnSource?.error || "Spawn database refresh failed"
    }, null, 2);
  }
});

const resizeObserver = new ResizeObserver(() => resizeCanvases());
resizeObserver.observe(mapHost);

resizeCanvases();
await loadStatus();
loadPalCatalog();
loadPossibleSpawnData(false);
loadArea(activeArea);
restartAutoScan();
requestAnimationFrame(animationLoop);
