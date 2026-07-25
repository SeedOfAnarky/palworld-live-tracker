import http from "node:http";
import { promises as fs } from "node:fs";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, timingSafeEqual } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.dirname(__filename);
const PUBLIC = path.join(ROOT, "public");
const CONFIG_FILE = path.join(ROOT, "config.json");
const MOCK = process.argv.includes("--mock");
const HOSTED_MODE = /^(1|true|yes)$/i.test(process.env.HOSTED_MODE || "");
const CONFIG_LOCKED = HOSTED_MODE || Object.keys(process.env).some((key) => key.startsWith("PALWORLD_"));
const TRACKER_USERNAME = process.env.TRACKER_USERNAME || "tracker";
const TRACKER_PASSWORD = process.env.TRACKER_PASSWORD || "";

const MAP_COMMIT = "0d99b04acba369ec88550d122794b9917bbf820e";
const MAP_REPO_RAW = `https://raw.githubusercontent.com/oMaN-Rod/palworld-save-pal/${MAP_COMMIT}/ui/src/lib/assets/img`;

const MAP_ASSETS = [
  {
    file: "t_worldmap.webp",
    url: `${MAP_REPO_RAW}/t_worldmap.webp`,
    fallbackUrl: `https://github.com/oMaN-Rod/palworld-save-pal/raw/${MAP_COMMIT}/ui/src/lib/assets/img/t_worldmap.webp`,
    gitBlobSha: "7bf20d19b0dbb627a0dbaa4354845699630df057"
  },
  {
    file: "t_treemap.webp",
    url: `${MAP_REPO_RAW}/t_treemap.webp`,
    fallbackUrl: `https://github.com/oMaN-Rod/palworld-save-pal/raw/${MAP_COMMIT}/ui/src/lib/assets/img/t_treemap.webp`,
    gitBlobSha: "58eb303a75f0b1160e0b25120a3b4bdfce419a7b"
  }
];

const PAL_DATA_REPO_RAW = `https://raw.githubusercontent.com/oMaN-Rod/palworld-save-pal/${MAP_COMMIT}/data/json`;
const PAL_DATA_ASSETS = [
  { file: "pals.json", url: `${PAL_DATA_REPO_RAW}/pals.json` },
  { file: "pal_names_en.json", url: `${PAL_DATA_REPO_RAW}/l10n/en/pals.json` }
];

const PAL_ICON_CACHE_DIR = path.join(PUBLIC, "assets", "pal-icons");
const palIconPending = new Map();

const ATLAS_DATA_BASE = "https://awy64.github.io/palworld-atlas-data/v1";
const SPAWN_DATA_CACHE_DIR = path.join(PUBLIC, "assets", "spawn-data");
const SPAWN_DATA_FILES = {
  palpagos: "palpagos.json",
  tree: "tree.json"
};

const DEFAULT_CONFIG = {
  palworld: {
    protocol: "http",
    host: "",
    port: 29148,
    username: "admin",
    password: "",
    pollIntervalMs: 750,
    requestTimeoutMs: 5000
  },
  local: { host: "127.0.0.1", port: 3030 }
};

let config = structuredClone(DEFAULT_CONFIG);
let clients = new Set();
let pollTimer = null;
let lastSnapshot = null;
let lastInfo = null;
let lastError = "";
let lastSuccessAt = null;
let mapAssetStatus = {};
let palDataStatus = {};
let palCatalogCache = null;
let spawnDataCache = null;
let spawnDataStatus = {
  ready: false,
  source: ATLAS_DATA_BASE,
  steamBuildId: null,
  generatedAt: null,
  gameVersion: null,
  error: ""
};

function deepMerge(base, incoming) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMerge(result[key] ?? {}, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}


function envNumber(name, fallback, min = 0) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

function applyEnvironmentOverrides() {
  if (process.env.PALWORLD_PROTOCOL) config.palworld.protocol = process.env.PALWORLD_PROTOCOL;
  if (process.env.PALWORLD_HOST) config.palworld.host = process.env.PALWORLD_HOST;
  if (process.env.PALWORLD_PORT) config.palworld.port = envNumber("PALWORLD_PORT", config.palworld.port, 1);
  if (process.env.PALWORLD_USERNAME) config.palworld.username = process.env.PALWORLD_USERNAME;
  if (process.env.PALWORLD_PASSWORD) config.palworld.password = process.env.PALWORLD_PASSWORD;
  if (process.env.PALWORLD_POLL_INTERVAL_MS) {
    config.palworld.pollIntervalMs = envNumber("PALWORLD_POLL_INTERVAL_MS", config.palworld.pollIntervalMs, 250);
  }
  if (process.env.PALWORLD_REQUEST_TIMEOUT_MS) {
    config.palworld.requestTimeoutMs = envNumber("PALWORLD_REQUEST_TIMEOUT_MS", config.palworld.requestTimeoutMs, 1000);
  }

  config.local.host = process.env.HOST || (HOSTED_MODE ? "0.0.0.0" : config.local.host);
  config.local.port = envNumber("PORT", config.local.port, 1);
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function trackerAuthValid(req) {
  if (!TRACKER_PASSWORD) return !HOSTED_MODE;
  const authorization = String(req.headers.authorization || "");
  if (!authorization.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    return secureEqual(decoded.slice(0, separator), TRACKER_USERNAME) &&
      secureEqual(decoded.slice(separator + 1), TRACKER_PASSWORD);
  } catch {
    return false;
  }
}

function requireTrackerAuth(req, res) {
  if (trackerAuthValid(req)) return true;
  res.writeHead(401, {
    "Content-Type": "text/plain; charset=utf-8",
    "WWW-Authenticate": 'Basic realm="Palworld Live Tracker", charset="UTF-8"',
    "Cache-Control": "no-store"
  });
  res.end("Authentication required");
  return false;
}

async function loadConfig() {
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf8");
    config = deepMerge(DEFAULT_CONFIG, JSON.parse(raw));
  } catch {
    config = structuredClone(DEFAULT_CONFIG);
    if (!HOSTED_MODE) await saveConfig();
  }
  applyEnvironmentOverrides();
}

async function saveConfig() {
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

function palBaseUrl(palConfig = config.palworld) {
  return `${palConfig.protocol}://${palConfig.host}:${palConfig.port}/v1/api`;
}

function authHeader(palConfig = config.palworld) {
  return "Basic " + Buffer.from(`${palConfig.username}:${palConfig.password}`, "utf8").toString("base64");
}

async function fetchPal(endpoint, palConfig = config.palworld) {
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Number(palConfig.requestTimeoutMs) || 5000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${palBaseUrl(palConfig)}${endpoint}`, {
      headers: {
        "Accept": "application/json",
        "Authorization": authHeader(palConfig),
        "User-Agent": "PalworldLiveTracker/0.8"
      },
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = text.trim() || response.statusText;
      throw new Error(`Palworld API ${response.status}: ${detail}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeWebP(bytes) {
  return bytes?.byteLength >= 12 &&
    Buffer.from(bytes.buffer, bytes.byteOffset, 4).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.buffer, bytes.byteOffset + 8, 4).toString("ascii") === "WEBP";
}

function gitBlobSha(bytes) {
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = Buffer.from(`blob ${buffer.length}\0`, "utf8");
  return createHash("sha1").update(header).update(buffer).digest("hex");
}

async function existingAssetStatus(dest, expectedGitBlobSha) {
  try {
    const bytes = await fs.readFile(dest);
    const stat = await fs.stat(dest);
    const riffWebP = bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP";
    const actualGitBlobSha = gitBlobSha(bytes);
    const exact = actualGitBlobSha === expectedGitBlobSha;

    return {
      exists: true,
      valid: stat.size > 100_000 && riffWebP && exact,
      bytes: stat.size,
      riffWebP,
      gitBlobSha: actualGitBlobSha,
      expectedGitBlobSha,
      verified: exact
    };
  } catch {
    return {
      exists: false,
      valid: false,
      bytes: 0,
      riffWebP: false,
      gitBlobSha: null,
      expectedGitBlobSha,
      verified: false
    };
  }
}

async function ensureMapAsset(asset, force = false) {
  const dest = path.join(PUBLIC, "assets", asset.file);
  const temp = `${dest}.download`;

  const existing = await existingAssetStatus(dest, asset.gitBlobSha);
  if (!force && existing.valid) {
    mapAssetStatus[asset.file] = {
      ready: true,
      verified: true,
      source: "verified-local-cache",
      bytes: existing.bytes,
      gitBlobSha: existing.gitBlobSha
    };
    return;
  }

  // Important for upgrades: v0.5 accidentally shipped valid-looking WebP noise.
  // A file that does not exactly match GitHub's blob SHA is removed automatically.
  if (existing.exists) {
    try { await fs.unlink(dest); } catch {}
  }
  try { await fs.unlink(temp); } catch {}

  mapAssetStatus[asset.file] = {
    ready: false,
    verified: false,
    downloading: true,
    source: asset.url
  };
  broadcast({ kind: "map-assets", mapAssetStatus });

  try {
    let response = null;
    let sourceUrl = asset.url;
    let lastError = "";

    for (const candidate of [asset.url, asset.fallbackUrl].filter(Boolean)) {
      sourceUrl = candidate;
      try {
        response = await fetch(candidate, {
          headers: {
            "Accept": "image/webp,image/*;q=0.8,*/*;q=0.5",
            "User-Agent": "PalworldLiveTracker/0.8"
          },
          redirect: "follow"
        });
        if (response.ok) break;
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = String(error?.message ?? error);
      }
    }

    if (!response?.ok) {
      throw new Error(lastError || "Map download failed");
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < 100_000) {
      throw new Error(`Downloaded file is unexpectedly small (${bytes.byteLength} bytes)`);
    }
    if (!looksLikeWebP(bytes)) {
      throw new Error(`Downloaded ${asset.file} is not a WebP image`);
    }

    const actualGitBlobSha = gitBlobSha(bytes);
    if (actualGitBlobSha !== asset.gitBlobSha) {
      throw new Error(
        `Integrity check failed for ${asset.file}. Expected ${asset.gitBlobSha}, got ${actualGitBlobSha}`
      );
    }

    await fs.writeFile(temp, bytes);
    await fs.rename(temp, dest);

    mapAssetStatus[asset.file] = {
      ready: true,
      verified: true,
      downloading: false,
      bytes: bytes.byteLength,
      source: sourceUrl,
      gitBlobSha: actualGitBlobSha
    };
    broadcast({ kind: "map-assets", mapAssetStatus });
  } catch (error) {
    try { await fs.unlink(temp); } catch {}
    mapAssetStatus[asset.file] = {
      ready: false,
      verified: false,
      downloading: false,
      error: String(error?.message ?? error),
      source: asset.url
    };
    broadcast({ kind: "map-assets", mapAssetStatus });
  }
}

async function ensureMapAssets(force = false) {
  await fs.mkdir(path.join(PUBLIC, "assets"), { recursive: true });
  await Promise.all(MAP_ASSETS.map((asset) => ensureMapAsset(asset, force)));
}


async function existingJsonAssetStatus(dest) {
  try {
    const stat = await fs.stat(dest);
    if (stat.size < 1000) return { exists: true, valid: false, bytes: stat.size };
    const text = await fs.readFile(dest, "utf8");
    const parsed = JSON.parse(text);
    return {
      exists: true,
      valid: Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed)),
      bytes: stat.size
    };
  } catch {
    return { exists: false, valid: false, bytes: 0 };
  }
}

async function ensurePalDataAsset(asset, force = false) {
  const dest = path.join(PUBLIC, "assets", asset.file);
  const temp = `${dest}.download`;
  const existing = await existingJsonAssetStatus(dest);

  if (!force && existing.valid) {
    palDataStatus[asset.file] = { ready: true, source: "local-cache", bytes: existing.bytes };
    return;
  }

  if (existing.exists && !existing.valid) {
    try { await fs.unlink(dest); } catch {}
  }
  try { await fs.unlink(temp); } catch {}

  palDataStatus[asset.file] = { ready: false, downloading: true, source: asset.url };
  broadcast({ kind: "pal-data", palDataStatus });

  try {
    const response = await fetch(asset.url, {
      headers: {
        "Accept": "application/json,text/plain;q=0.8,*/*;q=0.5",
        "User-Agent": "PalworldLiveTracker/0.8"
      },
      redirect: "follow"
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.length < 1000) throw new Error(`Downloaded JSON is unexpectedly small (${text.length} chars)`);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Downloaded JSON is not an object");
    }
    await fs.writeFile(temp, text, "utf8");
    await fs.rename(temp, dest);
    palDataStatus[asset.file] = {
      ready: true,
      downloading: false,
      bytes: Buffer.byteLength(text),
      source: asset.url
    };
    palCatalogCache = null;
    broadcast({ kind: "pal-data", palDataStatus });
  } catch (error) {
    try { await fs.unlink(temp); } catch {}
    palDataStatus[asset.file] = {
      ready: false,
      downloading: false,
      error: String(error?.message ?? error),
      source: asset.url
    };
    broadcast({ kind: "pal-data", palDataStatus });
  }
}

async function ensurePalDataAssets(force = false) {
  await fs.mkdir(path.join(PUBLIC, "assets"), { recursive: true });
  await Promise.all(PAL_DATA_ASSETS.map((asset) => ensurePalDataAsset(asset, force)));
}

function normalizeElement(element) {
  const aliases = {
    Normal: "Neutral",
    Earth: "Ground",
    Leaf: "Grass",
    Electricity: "Electric"
  };
  return aliases[element] || element;
}

async function loadPalCatalog() {
  if (palCatalogCache) return palCatalogCache;
  await ensurePalDataAssets(false);

  const palsPath = path.join(PUBLIC, "assets", "pals.json");
  const namesPath = path.join(PUBLIC, "assets", "pal_names_en.json");
  const [palsRaw, namesRaw] = await Promise.all([
    fs.readFile(palsPath, "utf8"),
    fs.readFile(namesPath, "utf8")
  ]);
  const pals = JSON.parse(palsRaw);
  const names = JSON.parse(namesRaw);

  const records = [];
  for (const [key, data] of Object.entries(pals)) {
    if (!data || data.is_pal !== true || data.disabled === true) continue;
    const localized = names[key]?.localized_name || key;
    records.push({
      key,
      name: localized,
      tribe: data.tribe || key,
      palDeckIndex: Number.isFinite(Number(data.pal_deck_index)) ? Number(data.pal_deck_index) : -1,
      rarity: Number.isFinite(Number(data.rarity)) ? Number(data.rarity) : null,
      elements: Array.isArray(data.element_types) ? data.element_types.map(normalizeElement).filter(Boolean) : [],
      boss: Boolean(data.is_boss),
      towerBoss: Boolean(data.is_tower_boss),
      raidBoss: Boolean(data.is_raid_boss),
      predator: Boolean(data.predator),
      nocturnal: Boolean(data.nocturnal),
      size: data.size || null,
      icon: typeof data.icon === "string" && data.icon ? data.icon : null
    });
  }

  // The raw catalog also contains quest/friend/boss helper definitions.  The
  // species picker should show one normal Paldeck entry per localized Pal name,
  // while matching still uses every record above.
  const preferred = records
    .filter((record) => record.palDeckIndex > 0)
    .sort((a, b) => {
      const aPenalty = Number(a.boss || a.towerBoss || a.raidBoss) + (/_Quest_|_NPC|_Friend|_Enemy/i.test(a.key) ? 2 : 0);
      const bPenalty = Number(b.boss || b.towerBoss || b.raidBoss) + (/_Quest_|_NPC|_Friend|_Enemy/i.test(b.key) ? 2 : 0);
      return aPenalty - bPenalty || a.palDeckIndex - b.palDeckIndex || a.name.localeCompare(b.name);
    });
  const seenNames = new Set();
  const species = [];
  for (const record of preferred) {
    const nameKey = record.name.trim().toLowerCase();
    if (!nameKey || seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);
    species.push(record);
  }

  const rarities = [...new Set(records.map((record) => record.rarity).filter((value) => value != null))].sort((a, b) => a - b);
  const elements = [...new Set(records.flatMap((record) => record.elements))].sort();

  palCatalogCache = {
    sourceCommit: MAP_COMMIT,
    records,
    species,
    rarities,
    elements,
    generatedAt: new Date().toISOString()
  };
  return palCatalogCache;
}


function cleansePalCharacterKey(characterId) {
  return String(characterId || "")
    .toLowerCase()
    .replace("predator_", "")
    .replace("_oilrig", "")
    .replace("raid_", "")
    .replace("summon_", "")
    .replace("_max", "")
    .replace(/_\d+$/, "")
    .replace("boss_", "")
    .replace("quest_farmer03_", "")
    .replace("_otomo", "");
}

async function validCachedWebP(filePath) {
  try {
    const bytes = await fs.readFile(filePath);
    return bytes.length > 100 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP";
  } catch {
    return false;
  }
}

async function ensurePalIcon(characterKey) {
  const catalog = await loadPalCatalog();
  const record = catalog.records.find((entry) => entry.key === characterKey);
  if (!record) throw new Error("Unknown Pal catalog key");

  const cleansed = cleansePalCharacterKey(record.key);
  if (!/^[a-z0-9_-]+$/i.test(cleansed)) {
    throw new Error("Unsafe Pal icon key");
  }

  await fs.mkdir(PAL_ICON_CACHE_DIR, { recursive: true });
  const dest = path.join(PAL_ICON_CACHE_DIR, `${cleansed}.webp`);

  if (await validCachedWebP(dest)) return dest;

  if (palIconPending.has(cleansed)) {
    return palIconPending.get(cleansed);
  }

  const promise = (async () => {
    const filenames = [];
    if (record.icon) filenames.push(`${String(record.icon).toLowerCase()}.webp`);
    filenames.push(`t_${cleansed}_icon_normal.webp`);
    filenames.push(`${cleansed}.webp`);

    const unique = [...new Set(filenames)];
    let lastError = "No icon candidate succeeded";

    for (const filename of unique) {
      const url = `${MAP_REPO_RAW}/${filename}`;
      try {
        const response = await fetch(url, {
          headers: {
            "Accept": "image/webp,image/*;q=0.8,*/*;q=0.5",
            "User-Agent": "PalworldLiveTracker/0.8"
          },
          redirect: "follow"
        });

        if (!response.ok) {
          lastError = `HTTP ${response.status} for ${filename}`;
          continue;
        }

        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!looksLikeWebP(bytes)) {
          lastError = `${filename} was not a WebP`;
          continue;
        }

        const temp = `${dest}.download`;
        await fs.writeFile(temp, bytes);
        await fs.rename(temp, dest);
        return dest;
      } catch (error) {
        lastError = String(error?.message ?? error);
      }
    }

    throw new Error(lastError);
  })();

  palIconPending.set(cleansed, promise);
  try {
    return await promise;
  } finally {
    palIconPending.delete(cleansed);
  }
}


async function readJsonFileIfValid(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function fetchJsonUrl(url, userAgent = "PalworldLiveTracker/0.8") {
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json,text/plain;q=0.8,*/*;q=0.5",
      "User-Agent": userAgent
    },
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  const text = await response.text();
  const parsed = JSON.parse(text);
  return { parsed, text };
}

function validSpawnCollection(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    Array.isArray(value.spawns) &&
    value.spawns.every((spawn) =>
      spawn &&
      typeof spawn === "object" &&
      Number.isFinite(Number(spawn.worldX)) &&
      Number.isFinite(Number(spawn.worldY)) &&
      typeof spawn.palId === "string"
    )
  );
}

async function loadCachedSpawnData() {
  const latestPath = path.join(SPAWN_DATA_CACHE_DIR, "latest.json");
  const latest = await readJsonFileIfValid(latestPath);
  if (!latest) return null;

  const palpagos = await readJsonFileIfValid(path.join(SPAWN_DATA_CACHE_DIR, SPAWN_DATA_FILES.palpagos));
  const tree = await readJsonFileIfValid(path.join(SPAWN_DATA_CACHE_DIR, SPAWN_DATA_FILES.tree));
  if (!validSpawnCollection(palpagos) || !validSpawnCollection(tree)) return null;

  return {
    latest,
    palpagos,
    tree,
    cached: true
  };
}

async function loadSpawnData(force = false) {
  if (spawnDataCache && !force) return spawnDataCache;

  await fs.mkdir(SPAWN_DATA_CACHE_DIR, { recursive: true });

  try {
    spawnDataStatus = {
      ...spawnDataStatus,
      ready: false,
      error: "",
      downloading: true
    };

    const latestUrl = `${ATLAS_DATA_BASE}/latest.json`;
    const { parsed: latest, text: latestText } = await fetchJsonUrl(latestUrl);

    const buildPath = String(latest?.buildPath || "").replace(/^\/+|\/+$/g, "");
    if (!buildPath || !latest?.steamBuildId) {
      throw new Error("Spawn database latest.json did not contain buildPath/steamBuildId");
    }

    const regions = {};
    for (const region of ["palpagos", "tree"]) {
      const url = `${ATLAS_DATA_BASE}/${buildPath}/maps/${region}/spawns.json`;
      const { parsed, text } = await fetchJsonUrl(url);
      if (!validSpawnCollection(parsed)) {
        throw new Error(`Invalid ${region} spawn collection`);
      }
      regions[region] = parsed;

      const dest = path.join(SPAWN_DATA_CACHE_DIR, SPAWN_DATA_FILES[region]);
      const temp = `${dest}.download`;
      await fs.writeFile(temp, text, "utf8");
      await fs.rename(temp, dest);
    }

    const latestDest = path.join(SPAWN_DATA_CACHE_DIR, "latest.json");
    const latestTemp = `${latestDest}.download`;
    await fs.writeFile(latestTemp, latestText, "utf8");
    await fs.rename(latestTemp, latestDest);

    spawnDataCache = {
      source: ATLAS_DATA_BASE,
      schemaVersion: latest.schemaVersion ?? 1,
      steamBuildId: String(latest.steamBuildId),
      generatedAt: latest.generatedAt ?? null,
      gameVersion: latest.gameVersion ?? null,
      buildPath,
      cached: false,
      palpagos: regions.palpagos,
      tree: regions.tree
    };

    spawnDataStatus = {
      ready: true,
      downloading: false,
      source: ATLAS_DATA_BASE,
      steamBuildId: spawnDataCache.steamBuildId,
      generatedAt: spawnDataCache.generatedAt,
      gameVersion: spawnDataCache.gameVersion,
      palpagosCount: regions.palpagos.spawns.length,
      treeCount: regions.tree.spawns.length,
      error: ""
    };
    return spawnDataCache;
  } catch (error) {
    const cached = await loadCachedSpawnData();
    if (cached) {
      spawnDataCache = {
        source: ATLAS_DATA_BASE,
        schemaVersion: cached.latest.schemaVersion ?? 1,
        steamBuildId: String(cached.latest.steamBuildId || "cached"),
        generatedAt: cached.latest.generatedAt ?? null,
        gameVersion: cached.latest.gameVersion ?? null,
        buildPath: cached.latest.buildPath ?? null,
        cached: true,
        palpagos: cached.palpagos,
        tree: cached.tree
      };
      spawnDataStatus = {
        ready: true,
        downloading: false,
        source: ATLAS_DATA_BASE,
        steamBuildId: spawnDataCache.steamBuildId,
        generatedAt: spawnDataCache.generatedAt,
        gameVersion: spawnDataCache.gameVersion,
        palpagosCount: cached.palpagos.spawns.length,
        treeCount: cached.tree.spawns.length,
        error: `Using cached spawn data because refresh failed: ${String(error?.message ?? error)}`
      };
      return spawnDataCache;
    }

    spawnDataStatus = {
      ...spawnDataStatus,
      ready: false,
      downloading: false,
      error: String(error?.message ?? error)
    };
    throw error;
  }
}

function spawnDataPayload(data) {
  return {
    ok: true,
    source: data.source,
    schemaVersion: data.schemaVersion,
    steamBuildId: data.steamBuildId,
    generatedAt: data.generatedAt,
    gameVersion: data.gameVersion,
    cached: Boolean(data.cached),
    regions: {
      MainMap: data.palpagos.spawns,
      Tree: data.tree.spawns
    },
    counts: {
      MainMap: data.palpagos.spawns.length,
      Tree: data.tree.spawns.length
    }
  };
}


function safeConfig() {
  return {
    palworld: {
      ...config.palworld,
      password: "",
      passwordSaved: Boolean(config.palworld.password)
    },
    local: config.local,
    hostedMode: HOSTED_MODE,
    configLocked: CONFIG_LOCKED,
    trackerAuthEnabled: Boolean(TRACKER_PASSWORD)
  };
}

function statusPayload() {
  const actors = Array.isArray(lastSnapshot?.ActorData) ? lastSnapshot.ActorData : [];
  const counts = {};
  for (const actor of actors) {
    const key = actor.UnitType || actor.Type || "Unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return {
    kind: "status",
    mock: MOCK,
    connected: Boolean(lastSuccessAt) && !lastError,
    lastSuccessAt,
    lastError,
    info: lastInfo,
    counts,
    snapshotTime: lastSnapshot?.Time ?? null,
    fps: lastSnapshot?.FPS ?? null,
    averageFps: lastSnapshot?.AverageFPS ?? null,
    mapAssetStatus,
    palDataStatus,
    spawnDataStatus,
    config: safeConfig()
  };
}

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(data); } catch {}
  }
}

let demoTick = 0;
function mockSnapshot() {
  demoTick += 1;
  const t = demoTick / 12;
  const players = [
    ["Seed", -220000, 110000],
    ["Player 2", -175000, 50000],
    ["Player 3", -280000, 210000],
    ["Player 4", -90000, -20000]
  ].map(([name, x, y], i) => ({
    Type: "Character",
    InstanceID: `DEMO-PLAYER-${i}`,
    UnitType: "Player",
    NickName: name,
    userid: `demo_${i}`,
    level: 55 + i,
    HP: 4000,
    MaxHP: 4000,
    Class: "Player",
    LocationX: x + Math.cos(t + i * 0.9) * (12000 + i * 3000),
    LocationY: y + Math.sin(t * 0.8 + i) * (15000 + i * 2500),
    LocationZ: 1000,
    RotationZ: ((t * 40 + i * 70) % 360),
    IsActive: "true"
  }));

  const pals = Array.from({ length: 350 }, (_, i) => ({
    Type: "Character",
    InstanceID: `DEMO-PAL-${i}`,
    UnitType: "WildPal",
    NickName: i % 37 === 0 ? "Jetragon" : `Wild Pal ${i + 1}`,
    Class: i % 37 === 0 ? "Pal_JetDragon" : `Pal_Demo_${i % 40}`,
    level: 5 + (i % 70),
    HP: 300 + (i % 40) * 50,
    MaxHP: 2500,
    LocationX: -980000 + ((i * 48671) % 1260000),
    LocationY: -660000 + ((i * 79301) % 1310000),
    LocationZ: 500,
    RotationZ: 0,
    IsActive: "true"
  }));

  return {
    Time: new Date().toISOString(),
    FPS: 60,
    AverageFPS: 59.7,
    ActorData: [...players, ...pals]
  };
}

async function pollOnce() {
  try {
    if (MOCK) {
      lastInfo = {
        version: "DEMO",
        servername: "Palworld Live Tracker Demo",
        description: "Mock data mode",
        worldguid: "DEMO"
      };
      lastSnapshot = mockSnapshot();
    } else {
      lastSnapshot = await fetchPal("/game-data");
      if (!lastInfo) {
        try { lastInfo = await fetchPal("/info"); } catch {}
      }
    }
    lastError = "";
    lastSuccessAt = new Date().toISOString();
    broadcast({ kind: "snapshot", snapshot: lastSnapshot });
    broadcast(statusPayload());
  } catch (error) {
    lastError = error?.name === "AbortError"
      ? `Connection timed out after ${config.palworld.requestTimeoutMs}ms`
      : String(error?.message ?? error);
    broadcast(statusPayload());
  }
}

function restartPoller() {
  if (pollTimer) clearInterval(pollTimer);
  const ms = Math.max(250, Number(config.palworld.pollIntervalMs) || 750);
  pollTimer = setInterval(pollOnce, ms);
  pollOnce();
}

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 256_000) throw new Error("Request body too large");
  }
  return body ? JSON.parse(body) : {};
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === "/") rel = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC, rel));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error("Not a file");
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".webp" ? "public, max-age=86400" : "no-cache"
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/healthz" && req.method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        service: "palworld-live-tracker",
        upstreamConnected: Boolean(lastSuccessAt) && !lastError
      });
    }

    if (!requireTrackerAuth(req, res)) return;

    if (url.pathname === "/api/status" && req.method === "GET") {
      return sendJson(res, 200, statusPayload());
    }

    if (url.pathname === "/api/test" && (req.method === "GET" || req.method === "POST")) {
      const incoming = req.method === "POST" ? await readJsonBody(req) : {};
      const testConfig = CONFIG_LOCKED
        ? structuredClone(config.palworld)
        : deepMerge(config.palworld, incoming.palworld ?? {});
      // An empty password field means "use the currently saved password".
      if (!CONFIG_LOCKED && incoming.palworld && incoming.palworld.password === "") {
        testConfig.password = config.palworld.password;
      }

      const result = {
        ok: false,
        baseUrl: palBaseUrl(testConfig),
        username: testConfig.username,
        passwordProvided: Boolean(testConfig.password),
        info: null,
        gameData: null
      };

      try {
        result.info = MOCK ? {
          ok: true,
          data: {
            version: "DEMO",
            servername: "Palworld Live Tracker Demo",
            description: "Mock mode",
            worldguid: "DEMO"
          }
        } : { ok: true, data: await fetchPal("/info", testConfig) };
      } catch (error) {
        result.info = { ok: false, error: String(error?.message ?? error) };
      }

      try {
        const snapshot = MOCK ? mockSnapshot() : await fetchPal("/game-data", testConfig);
        const actors = Array.isArray(snapshot?.ActorData) ? snapshot.ActorData : [];
        const unitCounts = actors.reduce((acc, actor) => {
          const key = actor.UnitType || actor.Type || "Unknown";
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        }, {});
        result.gameData = {
          ok: true,
          snapshotTime: snapshot?.Time ?? null,
          fps: snapshot?.FPS ?? null,
          actorCount: actors.length,
          unitCounts
        };
        if (result.info?.ok) {
          lastInfo = result.info.data;
          lastSnapshot = snapshot;
        }
      } catch (error) {
        result.gameData = { ok: false, error: String(error?.message ?? error) };
      }

      result.ok = Boolean(result.info?.ok && result.gameData?.ok);

      if (result.ok && incoming.persist === true && !CONFIG_LOCKED) {
        config.palworld = deepMerge(config.palworld, testConfig);
        await saveConfig();
        lastError = "";
        lastSuccessAt = new Date().toISOString();
        restartPoller();
        result.saved = true;
      } else {
        result.saved = false;
        if (CONFIG_LOCKED) result.configLocked = true;
      }

      return sendJson(res, result.ok ? 200 : 502, result);
    }

    if (url.pathname === "/api/snapshot" && req.method === "GET") {
      if (!lastSnapshot) await pollOnce();
      return sendJson(res, lastSnapshot ? 200 : 503, lastSnapshot ?? { error: lastError });
    }

    if (url.pathname === "/api/config" && req.method === "POST") {
      if (CONFIG_LOCKED) {
        return sendJson(res, 403, {
          ok: false,
          configLocked: true,
          error: "Connection settings are managed by deployment environment variables."
        });
      }
      const incoming = await readJsonBody(req);
      const next = structuredClone(config);
      if (incoming.palworld) {
        for (const key of ["protocol", "host", "port", "username", "pollIntervalMs", "requestTimeoutMs"]) {
          if (incoming.palworld[key] !== undefined && incoming.palworld[key] !== "") {
            next.palworld[key] = incoming.palworld[key];
          }
        }
        if (typeof incoming.palworld.password === "string" && incoming.palworld.password.length > 0) {
          next.palworld.password = incoming.palworld.password;
        }
      }
      config = deepMerge(DEFAULT_CONFIG, next);
      await saveConfig();
      lastInfo = null;
      lastSnapshot = null;
      lastError = "";
      lastSuccessAt = null;
      restartPoller();
      return sendJson(res, 200, { ok: true, config: safeConfig() });
    }

    if (url.pathname === "/api/map-refresh" && req.method === "POST") {
      ensureMapAssets(true);
      return sendJson(res, 202, { ok: true, message: "Map download started." });
    }

    if (url.pathname === "/api/map-diagnostics" && req.method === "GET") {
      const files = {};
      for (const asset of MAP_ASSETS) {
        const dest = path.join(PUBLIC, "assets", asset.file);
        files[asset.file] = {
          ...(await existingAssetStatus(dest, asset.gitBlobSha)),
          runtime: mapAssetStatus[asset.file] ?? null
        };
      }
      return sendJson(res, 200, { ok: true, files });
    }

    if (url.pathname === "/api/spawn-data" && req.method === "GET") {
      try {
        const data = await loadSpawnData(false);
        return sendJson(res, 200, spawnDataPayload(data));
      } catch (error) {
        return sendJson(res, 503, {
          ok: false,
          error: String(error?.message ?? error),
          spawnDataStatus
        });
      }
    }

    if (url.pathname === "/api/spawn-data-refresh" && req.method === "POST") {
      try {
        spawnDataCache = null;
        const data = await loadSpawnData(true);
        return sendJson(res, 200, {
          ...spawnDataPayload(data),
          message: "Possible spawn database refreshed."
        });
      } catch (error) {
        return sendJson(res, 503, {
          ok: false,
          error: String(error?.message ?? error),
          spawnDataStatus
        });
      }
    }

    if (url.pathname === "/api/pal-icon" && req.method === "GET") {
      const key = url.searchParams.get("key") || "";
      try {
        const filePath = await ensurePalIcon(key);
        res.writeHead(200, {
          "Content-Type": "image/webp",
          "Cache-Control": "public, max-age=604800, immutable"
        });
        createReadStream(filePath).pipe(res);
        return;
      } catch (error) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Pal icon unavailable: ${String(error?.message ?? error)}`);
        return;
      }
    }

    if (url.pathname === "/api/pal-catalog" && req.method === "GET") {
      try {
        const catalog = await loadPalCatalog();
        return sendJson(res, 200, { ok: true, ...catalog });
      } catch (error) {
        return sendJson(res, 503, {
          ok: false,
          error: String(error?.message ?? error),
          palDataStatus
        });
      }
    }

    if (url.pathname === "/api/pal-catalog-refresh" && req.method === "POST") {
      palCatalogCache = null;
      await ensurePalDataAssets(true);
      const catalog = await loadPalCatalog();
      return sendJson(res, 200, {
        ok: true,
        message: "Pal catalog refreshed.",
        speciesCount: catalog.species.length,
        recordCount: catalog.records.length
      });
    }

    if (url.pathname === "/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      });
      res.write(`retry: 1500\n`);
      res.write(`data: ${JSON.stringify(statusPayload())}\n\n`);
      if (lastSnapshot) {
        res.write(`data: ${JSON.stringify({ kind: "snapshot", snapshot: lastSnapshot })}\n\n`);
      }
      clients.add(res);
      const keepAlive = setInterval(() => {
        try { res.write(`: keepalive ${Date.now()}\n\n`); } catch {}
      }, 15000);
      req.on("close", () => {
        clearInterval(keepAlive);
        clients.delete(res);
      });
      return;
    }

    return serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: String(error?.message ?? error) });
  }
});

await loadConfig();

if (HOSTED_MODE && !TRACKER_PASSWORD) {
  console.error("TRACKER_PASSWORD is required when HOSTED_MODE=1.");
  process.exit(1);
}
if (!MOCK && (!config.palworld.host || !config.palworld.password)) {
  console.error("PALWORLD_HOST and PALWORLD_PASSWORD are required for live mode.");
  process.exit(1);
}

ensureMapAssets(false);
restartPoller();

server.listen(config.local.port, config.local.host, () => {
  const url = `http://${config.local.host}:${config.local.port}`;
  console.log("");
  console.log("Palworld Live Tracker");
  console.log("====================");
  console.log(`Mode: ${MOCK ? "DEMO / mock data" : "LIVE"}`);
  console.log(`Open: ${url}`);
  console.log(`Palworld REST: ${palBaseUrl()}`);
  console.log("Press Ctrl+C to stop.");
  console.log("");

  if (!HOSTED_MODE && !process.argv.includes("--no-open")) {
    if (process.platform === "win32") exec(`start "" "${url}"`);
    else if (process.platform === "darwin") exec(`open "${url}"`);
    else exec(`xdg-open "${url}" >/dev/null 2>&1`);
  }
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`Received ${signal}; shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
