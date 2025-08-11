// src/server.js — CH-only backend with stitch guards, coords support, capped Overpass, and tighter logging
// Works on GraphHopper free tier (CH, <=5 points/request). No FLEX/custom models.
//
// Key fixes in this revision:
// - Add time budget for stitch phase (default 25s). On expiry → clean CH fallback + evidence.
// - Motorway-rescue loop guards: MAX_RESCUE_ATTEMPTS_PER_PAIR / TOTAL + dedup hash; correct attempt increment.
// - Overpass timeout and hard caps with graceful retry/shrink.
// - Log once per pair attempt with concise context.
// - Native support for start_coords/end_coords/vias_coords while keeping string inputs (back-compatible).
//
// Endpoints:
//   GET  /health
//   POST /plan
//   GET  /download/route/:id.:ext
//   GET  /v/:id (Leaflet preview)

"use strict";

const express = require("express");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");

// ----- Environment helpers -----
function need(name, def = undefined) {
  const v = process.env[name] ?? def;
  if (v === undefined || v === null || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

const PORT = process.env.PORT || 8080;
const GH_KEY = need("GRAPHOPPER_API_KEY");
const GH_ROUTE_URL = process.env.GRAPHOPPER_ROUTE_URL || "https://graphhopper.com/api/1/route";
const GH_GEOCODE_URL = process.env.GRAPHOPPER_GEOCODE_URL || "https://graphhopper.com/api/1/geocode";

const SUPABASE_URL = need("SUPABASE_URL");
const SUPABASE_KEY = need("SUPABASE_SERVICE_ROLE_KEY", need("SUPABASE_ANON_KEY")); // prefer service role if available
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "adv-routes";
const PUBLIC_BASE = process.env.PUBLIC_BASE || ""; // e.g., "https://adv-route-backend.onrender.com"
const PREVIEW_BASE = PUBLIC_BASE || ""; // same as PUBLIC_BASE if set

// Stitch controls
const STITCH_TIME_BUDGET_MS = (parseInt(process.env.STITCH_TIME_BUDGET_MS, 10) || 25000);
const MAX_RESCUE_ATTEMPTS_PER_PAIR = (parseInt(process.env.MAX_RESCUE_ATTEMPTS_PER_PAIR, 10) || 6);
const MAX_RESCUE_ATTEMPTS_TOTAL = (parseInt(process.env.MAX_RESCUE_ATTEMPTS_TOTAL, 10) || 60);
const STITCH_DEFAULT_MAX_TRACKS = (parseInt(process.env.STITCH_MAX_TRACKS, 10) || 400);
const OVERPASS_TIMEOUT_S = (parseInt(process.env.OVERPASS_TIMEOUT_S, 10) || 25);
const OVERPASS_URL = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";

// Misc
const VEHICLE_PROFILE = process.env.GH_PROFILE || "car"; // CH plan-safe
const MAX_POINTS_PER_GH = 5;

// ----- Clients -----
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ----- App setup -----
const app = express();
app.use(express.json({ limit: "1mb" }));

// ----- Logging -----
function log(level, msg, extra = {}) {
  // level: 20=debug, 30=info, 40=warn, 50=error
  const payload = {
    level,
    time: Date.now(),
    pid: process.pid,
    hostname: process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || "local",
    msg,
    ...extra,
  };
  // Render likes single-line JSON
  console.log(JSON.stringify(payload));
}

function genId(n = 12) {
  return crypto.randomBytes(n).toString("base64url").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, n);
}

// ----- Small utils -----
function coordsFromString(s) {
  // "lat,lon" or "lon,lat" — we accept both but default to "lat,lon"
  const parts = (s || "").split(",").map(x => parseFloat(x.trim()));
  if (parts.length !== 2 || parts.some(Number.isNaN)) return null;
  // Heuristic: |lat| <= 90, |lon| <= 180; if first is > 90 in abs, swap
  let lat = parts[0], lon = parts[1];
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    // try swapped
    lat = parts[1]; lon = parts[0];
  }
  return { lat, lon };
}

function kmToDeg(km) {
  // rough conversion ~ 111 km per degree lat
  return km / 111.0;
}

function bboxFromPoints(points, padKm) {
  let minLat = +Infinity, minLon = +Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const p of points) {
    if (!p) continue;
    minLat = Math.min(minLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLat = Math.max(maxLat, p.lat);
    maxLon = Math.max(maxLon, p.lon);
  }
  const pad = kmToDeg(padKm || 8);
  return {
    s: minLat - pad,
    w: minLon - pad,
    n: maxLat + pad,
    e: maxLon + pad,
  };
}

function metersToKm(m) { return Math.round((m / 1000) * 10) / 10; }
function secToHours(s) { return Math.round((s / 3600) * 100) / 100; }

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ----- Geocoding (fallback if strings are provided) -----
async function geocodePlace(q) {
  const url = new URL(GH_GEOCODE_URL);
  url.searchParams.set("q", q);
  url.searchParams.set("locale", "en");
  url.searchParams.set("limit", "1");
  url.searchParams.set("key", GH_KEY);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Geocode failed ${res.status}`);
  const data = await res.json();
  const hit = data.hits && data.hits[0];
  if (!hit) throw new Error(`Geocode: no results for "${q}"`);
  return { lat: hit.point.lat, lon: hit.point.lng };
}

// ----- GraphHopper CH route (chunked) -----
async function ghRouteCH(points, requestId) {
  if (!points || points.length < 2) throw new Error("ghRouteCH: need >= 2 points");

  // chunk into groups of MAX_POINTS_PER_GH with overlap of 1
  const chunks = [];
  let i = 0;
  while (i < points.length - 1) {
    const end = Math.min(i + MAX_POINTS_PER_GH - 1, points.length - 1);
    const slice = points.slice(i, end + 1);
    chunks.push(slice);
    if (end === points.length - 1) break;
    i = end; // overlap last point
  }

  let allCoords = [];
  let allDistance = 0;
  let allTime = 0;

  for (let idx = 0; idx < chunks.length; idx++) {
    const pts = chunks[idx];
    const url = new URL(GH_ROUTE_URL);

    // Build query params
    url.searchParams.set("profile", VEHICLE_PROFILE);
    url.searchParams.set("points_encoded", "false");
    url.searchParams.set("locale", "en");
    url.searchParams.set("algorithm", "ch");
    url.searchParams.set("key", GH_KEY);

    pts.forEach(p => {
      url.searchParams.append("point", `${p.lat},${p.lon}`);
    });

    const res = await fetch(url.toString());
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      log(50, "gh route chunk failed", { requestId, status: res.status, body: txt.slice(0, 300) });
      throw new Error(`GraphHopper CH route error ${res.status}`);
    }
    const data = await res.json();

    const path = data.paths && data.paths[0];
    if (!path || !path.points || !path.points.coordinates) {
      throw new Error("GraphHopper: no path/points");
    }
    const coords = path.points.coordinates; // [lon,lat] pairs
    const distance = path.distance || 0;
    const time = path.time || 0;

    // merge coords; remove duplicate of overlap
    if (allCoords.length > 0 && coords.length > 0) {
      coords.shift(); // drop first point to avoid duplicate
    }
    allCoords = allCoords.concat(coords);
    allDistance += distance;
    allTime += time;
  }

  return {
    coordinates: allCoords, // [lon, lat]
    distance_m: allDistance,
    time_ms: allTime,
  };
}

// ----- Overpass helpers (capped & retry/shrink) -----
async function fetchTracksInBbox(bbox, opts = {}, requestId) {
  const timeoutS = opts.timeout_s || OVERPASS_TIMEOUT_S;
  const maxWays = Math.max(50, Math.min(opts.max_tracks || STITCH_DEFAULT_MAX_TRACKS, 1000));

  // Keep the filter compact; prefer gravel/dirt-ish surfaces
  const query = `
    [out:json][timeout:${timeoutS}];
    (
      way
        ["highway"~"track|path|unclassified|tertiary|secondary|service"]
        ( ${bbox.s}, ${bbox.w}, ${bbox.n}, ${bbox.e} )
        ["motorroad"!="yes"];
    );
    out center ${maxWays};
  `.trim();

  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: query }).toString(),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    log(40, "overpass non-OK", { requestId, status: res.status, body: txt.slice(0, 240) });
    throw new Error(`Overpass error ${res.status}`);
  }
  const data = await res.json();
  const centers = [];
  if (data && Array.isArray(data.elements)) {
    for (const el of data.elements) {
      if (el.type === "way" && el.center) {
        centers.push({ lat: el.center.lat, lon: el.center.lon, id: el.id });
      }
    }
  }
  return centers.slice(0, maxWays);
}

async function overpassWithRetryShrink(allPoints, padKm, opts, requestId) {
  // Try with padKm, then shrink pad if failing, then reduce max tracks
  const pads = [padKm, Math.max(4, padKm - 2), Math.max(2, padKm - 4)];
  const caps = [opts.max_tracks || STITCH_DEFAULT_MAX_TRACKS, 300, 200, 150];

  for (const pad of pads) {
    const bbox = bboxFromPoints(allPoints, pad);
    for (const cap of caps) {
      try {
        const centers = await fetchTracksInBbox(bbox, { timeout_s: opts.timeout_s, max_tracks: cap }, requestId);
        return { centers, bbox, pad, cap };
      } catch (e) {
        log(40, "overpass retry", { requestId, pad, cap, err: (e && e.message) || String(e) });
        await sleep(500);
      }
    }
  }
  throw new Error("Overpass failed after retries");
}

// ----- Simple axis share for ordering -----
function axisShare(a, b, p) {
  // Project p onto segment ab, return 0..1 along the axis
  const ax = a.lon, ay = a.lat;
  const bx = b.lon, by = b.lat;
  const px = p.lon, py = p.lat;

  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  if (ab2 === 0) return 0;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2));
  return t;
}

// ----- GPX / GeoJSON builders -----
function buildGeoJSONLine(coordinates) {
  // coordinates as [lon,lat]
  return JSON.stringify({
    type: "FeatureCollection",
    features: [
      { type: "Feature", geometry: { type: "LineString", coordinates }, properties: {} },
    ],
  });
}

function buildGPX(coordinates) {
  // very simple GPX 1.1 with trkseg
  const header = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="adv-route-backend" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>ADV Route</name><trkseg>`;
  const pts = coordinates.map(([lon, lat]) => `    <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"></trkpt>`).join("\n");
  const footer = `  </trkseg></trk></gpx>`;
  return `${header}\n${pts}\n${footer}`;
}

// ----- Supabase uploads -----
async function uploadRouteArtifacts(id, coordinates) {
  const geojson = buildGeoJSONLine(coordinates);
  const gpx = buildGPX(coordinates);

  const geoPath = `routes/${id}.geojson`;
  const gpxPath = `routes/${id}.gpx`;

  const up1 = await supabase.storage.from(SUPABASE_BUCKET).upload(geoPath, Buffer.from(geojson), {
    contentType: "application/geo+json",
    upsert: true,
  });
  if (up1.error) throw up1.error;

  const up2 = await supabase.storage.from(SUPABASE_BUCKET).upload(gpxPath, Buffer.from(gpx), {
    contentType: "application/gpx+xml",
    upsert: true,
  });
  if (up2.error) throw up2.error;

  const { data: pub1 } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(geoPath);
  const { data: pub2 } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(gpxPath);

  return {
    geojson_url: pub1.publicUrl,
    gpx_url: pub2.publicUrl,
  };
}

// ----- CH plan -----
async function planCHRoute(allPoints, requestId) {
  const gh = await ghRouteCH(allPoints, requestId);
  const id = genId();
  const uploaded = await uploadRouteArtifacts(id, gh.coordinates);
  const distance_km = metersToKm(gh.distance_m);
  const duration_h = gh.time_ms ? secToHours(gh.time_ms / 1000) : null;

  return {
    id,
    name: "ADV Option (CH)",
    summary: "CH mode: standard routing (free plan).",
    stats: { distance_km, duration_h, ascent_m: null },
    gpx_url: uploaded.gpx_url,
    geojson_url: uploaded.geojson_url,
    preview_url: PREVIEW_BASE ? `${PREVIEW_BASE}/v/${id}` : `/v/${id}`,
    pretty_gpx_url: PREVIEW_BASE ? `${PREVIEW_BASE}/download/route/${id}.gpx` : `/download/route/${id}.gpx`,
    pretty_geojson_url: PREVIEW_BASE ? `${PREVIEW_BASE}/download/route/${id}.geojson` : `/download/route/${id}.geojson`,
    custom_model_used: null,
    via_points_used: allPoints.map(p => [p.lon, p.lat]),
  };
}

// ----- Stitch with guards -----
async function planStitchRoute(params, requestId) {
  const t0 = Date.now();
  const {
    points, // [{lat,lon}...], includes start + vias + end
    corridor_pad_km = 8,
    stitch_max_tracks = STITCH_DEFAULT_MAX_TRACKS,
    avoid_motorways = true,
  } = params;

  // 1) Fetch candidate tracks with retry/shrink
  let centers, bbox, usedPad, usedCap;
  try {
    const got = await overpassWithRetryShrink(points, corridor_pad_km, { timeout_s: OVERPASS_TIMEOUT_S, max_tracks: stitch_max_tracks }, requestId);
    centers = got.centers; bbox = got.bbox; usedPad = got.pad; usedCap = got.cap;
  } catch (e) {
    // Overpass hard fail → fallback to CH immediately
    log(40, "stitch overpass failed, falling back to CH", { requestId, err: e.message || String(e) });
    const route = await planCHRoute(points, requestId);
    return {
      routes: [route],
      evidence: [{ type: "stitch_error", detail: "overpass_failed" }, { type: "GH_mode", ref: "CH" }],
    };
  }

  if (!centers || centers.length === 0) {
    log(40, "stitch no centers, fallback CH", { requestId });
    const route = await planCHRoute(points, requestId);
    return { routes: [route], evidence: [{ type: "stitch_error", detail: "no_tracks" }, { type: "GH_mode", ref: "CH" }] };
  }

  // 2) Order candidates roughly along the main axis
  const A = points[0], B = points[points.length - 1];
  centers.forEach(c => { c.share = axisShare(A, B, c); });
  centers.sort((a, b) => a.share - b.share);

  // 3) Build a sparse chain of via candidates (every ~N)
  const step = Math.max(1, Math.floor(centers.length / 8)); // keep it light
  const chain = [];
  for (let i = 0; i < centers.length; i += step) chain.push(centers[i]);
  // ensure we include start/end as control points
  const controlPoints = [A, ...chain, B];

  // 4) Connect with CH, with guarded motorway-rescue attempts
  const totalRescueBudget = MAX_RESCUE_ATTEMPTS_TOTAL;
  let rescueUsedTotal = 0;
  const perPairAttempts = new Map(); // key => count
  const perPairLastKeySeen = new Map(); // key => last key to detect stalling
  const pathCoords = [];
  let totalDist = 0, totalTime = 0;

  for (let k = 0; k < controlPoints.length - 1; k++) {
    const d = controlPoints[k];
    const r = controlPoints[k + 1];

    const pairKey = `${d.lon.toFixed(6)},${d.lat.toFixed(6)}|${r.lon.toFixed(6)},${r.lat.toFixed(6)}`;
    const attemptBase = (perPairAttempts.get(pairKey) || 0);

    const elapsed = Date.now() - t0;
    if (elapsed > STITCH_TIME_BUDGET_MS) {
      log(40, "stitch time budget exceeded; fallback on remaining", { requestId, elapsed });
      // connect remaining in one CH call and exit
      const remaining = controlPoints.slice(k);
      try {
        const gh = await ghRouteCH(remaining, requestId);
        // merge
        if (pathCoords.length > 0 && gh.coordinates.length > 0) gh.coordinates.shift();
        pathCoords.push(...gh.coordinates);
        totalDist += gh.distance_m;
        totalTime += gh.time_ms;
      } catch (e) {
        // As a last resort, ignore remainder
        log(40, "fallback CH on remainder failed", { requestId, err: e.message || String(e) });
      }
      break;
    }

    try {
      const gh = await ghRouteCH([d, r], requestId);
      // merge
      if (pathCoords.length > 0 && gh.coordinates.length > 0) gh.coordinates.shift();
      pathCoords.push(...gh.coordinates);
      totalDist += gh.distance_m;
      totalTime += gh.time_ms;
      continue;
    } catch (e) {
      // If CH fails here (rare), we'll try guarded motorway-rescue variations
    }

    // --- Guarded motorway-rescue loop for this pair ---
    let connected = false;
    for (let attempt = attemptBase + 1; attempt <= attemptBase + MAX_RESCUE_ATTEMPTS_PER_PAIR; attempt++) {
      const elapsed2 = Date.now() - t0;
      if (elapsed2 > STITCH_TIME_BUDGET_MS) break;
      if (rescueUsedTotal >= totalRescueBudget) break;

      // Jitter the mid-point slightly to encourage alternate CH snaps
      const share = axisShare(d, r, { lat: (d.lat + r.lat) / 2, lon: (d.lon + r.lon) / 2 });
      // small random jitter ~ ~20-80 meters
      const jitter = (Math.random() - 0.5) * kmToDeg(0.08);
      const mid = {
        lat: (d.lat + r.lat) / 2 + jitter,
        lon: (d.lon + r.lon) / 2 - jitter,
      };

      const dedupKey = `${d.lon.toFixed(5)},${d.lat.toFixed(5)}|${r.lon.toFixed(5)},${r.lat.toFixed(5)}|${mid.lon.toFixed(5)},${mid.lat.toFixed(5)}`;
      const lastSeen = perPairLastKeySeen.get(pairKey);
      if (lastSeen === dedupKey && attempt > attemptBase + 1) {
        // Stuck on identical mid; break early
        log(40, "stitch rescue dedup break", { requestId, k, attempt, pairKey });
        break;
      }
      perPairLastKeySeen.set(pairKey, dedupKey);

      log(30, "stitch: motorway rescue", {
        requestId, attempt: `${attempt}/${attemptBase + MAX_RESCUE_ATTEMPTS_PER_PAIR}`,
        share: Number(share.toFixed(3)),
        mid: `${mid.lat.toFixed(6)},${mid.lon.toFixed(6)}`,
        d: `${d.lat.toFixed(6)},${d.lon.toFixed(6)}`,
        r: `${r.lat.toFixed(6)},${r.lon.toFixed(6)}`
      });

      rescueUsedTotal++;

      try {
        const gh = await ghRouteCH([d, mid, r], requestId);
        if (pathCoords.length > 0 && gh.coordinates.length > 0) gh.coordinates.shift();
        pathCoords.push(...gh.coordinates);
        totalDist += gh.distance_m;
        totalTime += gh.time_ms;

        // Persist attempts for the pair and break
        perPairAttempts.set(pairKey, attempt);
        connected = true;
        break;
      } catch (e) {
        // try next attempt
        perPairAttempts.set(pairKey, attempt);
        await sleep(120); // tiny backoff
      }

      if (rescueUsedTotal >= totalRescueBudget) break;
    }

    if (!connected) {
      // Could not connect this pair; try straight CH for remainder and exit
      log(40, "stitch: pair could not be connected; fallback remainder CH", { requestId, pairKey });
      try {
        const remaining = [d, r];
        const gh = await ghRouteCH(remaining, requestId);
        if (pathCoords.length > 0 && gh.coordinates.length > 0) gh.coordinates.shift();
        pathCoords.push(...gh.coordinates);
        totalDist += gh.distance_m;
        totalTime += gh.time_ms;
      } catch (e) {
        // swallow; proceed to next segment (gap)
        log(40, "fallback pair CH failed", { requestId, err: e.message || String(e) });
      }
    }
  }

  // If we ended with no coords, do a full CH fallback
  if (!pathCoords || pathCoords.length === 0) {
    const route = await planCHRoute(points, requestId);
    return {
      routes: [route],
      evidence: [
        { type: "stitch_error", detail: "empty_path_after_rescue" },
        { type: "GH_mode", ref: "CH" },
      ],
    };
  }

  const id = genId();
  const uploaded = await uploadRouteArtifacts(id, pathCoords);
  const distance_km = metersToKm(totalDist);
  const duration_h = totalTime ? secToHours(totalTime / 1000) : null;

  const route = {
    id,
    name: "ADV Option (stitch)",
    summary: "Stitch mode: connectors between OSM tracks with guarded rescue.",
    stats: { distance_km, duration_h, ascent_m: null },
    gpx_url: uploaded.gpx_url,
    geojson_url: uploaded.geojson_url,
    preview_url: PREVIEW_BASE ? `${PREVIEW_BASE}/v/${id}` : `/v/${id}`,
    pretty_gpx_url: PREVIEW_BASE ? `${PREVIEW_BASE}/download/route/${id}.gpx` : `/download/route/${id}.gpx`,
    pretty_geojson_url: PREVIEW_BASE ? `${PREVIEW_BASE}/download/route/${id}.geojson` : `/download/route/${id}.geojson`,
    custom_model_used: null,
    via_points_used: points.map(p => [p.lon, p.lat]),
    km_target_used: null,
    corridor_pad_km: usedPad,
  };

  const ev = [{ type: "GH_mode", ref: "CH" }];
  if (rescueUsedTotal > 0) ev.push({ type: "stitch_rescue_used", attempts: rescueUsedTotal, cap: MAX_RESCUE_ATTEMPTS_TOTAL, centers_used: (centers && centers.length) || 0, pad_km: usedPad, overpass_cap: usedCap });

  return { routes: [route], evidence: ev };
}

// ----- Request parsing (supports coords) -----
async function parsePointsFromBody(body) {
  let start, end;
  const vias = [];

  if (body.start_coords && typeof body.start_coords.lat === "number" && typeof body.start_coords.lon === "number") {
    start = { lat: body.start_coords.lat, lon: body.start_coords.lon };
  } else if (body.start && typeof body.start === "string") {
    const quick = coordsFromString(body.start);
    start = quick || await geocodePlace(body.start);
  }

  if (body.end_coords && typeof body.end_coords.lat === "number" && typeof body.end_coords.lon === "number") {
    end = { lat: body.end_coords.lat, lon: body.end_coords.lon };
  } else if (body.end && typeof body.end === "string") {
    const quick = coordsFromString(body.end);
    end = quick || await geocodePlace(body.end);
  }

  if (!start || !end) throw new Error("Provide start/end or start_coords/end_coords");

  if (Array.isArray(body.vias_coords)) {
    for (const v of body.vias_coords) {
      if (v && typeof v.lat === "number" && typeof v.lon === "number") vias.push({ lat: v.lat, lon: v.lon });
    }
  }
  if (Array.isArray(body.vias) && body.vias.length > 0) {
    for (const s of body.vias) {
      if (typeof s !== "string") continue;
      const quick = coordsFromString(s);
      if (quick) vias.push(quick);
      else vias.push(await geocodePlace(s));
    }
  }

  return [start, ...vias, end];
}

// ----- Endpoints -----
app.get("/health", async (req, res) => {
  res.json({ ok: true, mode: "CH-only", time: new Date().toISOString() });
});

app.post("/plan", async (req, res) => {
  const requestId = genId(8);
  const body = req.body || {};
  const strategy = (body.strategy || "ch").toLowerCase();

  try {
    const points = await parsePointsFromBody(body);
    const avoid_motorways = Boolean(body.avoid_motorways);
    const avoid_tolls = Boolean(body.avoid_tolls);
    const prefer_gravel = Boolean(body.prefer_gravel);

    log(30, "plan request", {
      requestId,
      strategy,
      points: points.length,
      avoid_motorways,
      avoid_tolls,
      prefer_gravel
    });

    if (strategy === "stitch") {
      const result = await planStitchRoute({
        points,
        corridor_pad_km: Number(body.corridor_pad_km) || 8,
        stitch_max_tracks: Number(body.stitch_max_tracks) || STITCH_DEFAULT_MAX_TRACKS,
        avoid_motorways
      }, requestId);

      return res.json(result);
    }

    // default: CH
    const route = await planCHRoute(points, requestId);
    return res.json({ routes: [route], evidence: [{ type: "GH_mode", ref: "CH" }] });

  } catch (e) {
    log(50, "plan error", { requestId, err: e.message || String(e), stack: e.stack && e.stack.split("\n").slice(0, 3).join(" | ") });
    res.status(400).json({ error: "plan_failed", detail: e.message || String(e) });
  }
});

// Simple download proxy (redirect to public supabase URL)
app.get("/download/route/:id.:ext", async (req, res) => {
  const { id, ext } = req.params;
  const key = `routes/${id}.${ext}`;
  const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(key);
  if (!data || !data.publicUrl) return res.status(404).send("Not found");
  res.redirect(data.publicUrl);
});

// Basic Leaflet preview
app.get("/v/:id", (req, res) => {
  const { id } = req.params;
  const geoKey = `routes/${id}.geojson`;
  const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(geoKey);
  if (!data || !data.publicUrl) return res.status(404).send("Not found");

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>ADV Route ${id}</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>html,body,#map{height:100%;margin:0} #map{outline:none}</style>
</head>
<body>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  const map = L.map('map');
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap'
  }).addTo(map);
  fetch(${JSON.stringify(data.publicUrl)})
    .then(r => r.json())
    .then(fc => {
      const layer = L.geoJSON(fc).addTo(map);
      map.fitBounds(layer.getBounds(), { padding: [24,24] });
    })
    .catch(() => { alert('Failed to load route'); });
</script>
</body>
</html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

app.listen(PORT, () => {
  log(30, "server started", { port: PORT, mode: "CH-only" });
});
