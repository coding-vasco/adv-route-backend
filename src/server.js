// src/server.js — CH + STITCH + geocoding + rate limiting/backoff
// Patch A: time_budget_h/distance_km_target -> kmTarget + corridor limit
// Patch B: auto-anchors from Overpass tracks (evenly spaced along axis)
// Patch A' (this commit): rich connector logging + bubble up GH error text
// Patch B' (this commit): guard badly-formed anchors & tiny segments + cleaning summary
// Patch C (this commit): JOIN_RADIUS_M, de-dup & loop jitter, CH fallback when stitching fails
// Also: pretty download redirects + Leaflet preview page.

import 'dotenv/config';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { customAlphabet } from 'nanoid';
import pino from 'pino';
import { corridorBBox, bboxAreaKm2, distKm } from './lib/bbox.js';
import { validatePlan } from './lib/normalize.js';
import { ZodError } from 'zod';

const app = express();
app.use(express.json({ limit: '2mb' }));

/* ========= ENV ========= */
const need = (k, hard = true) => {
  if (!process.env[k] || String(process.env[k]).trim() === '') {
    const msg = `[ENV] Missing ${k}`;
    if (hard) { console.error(msg); process.exit(1); }
    else { console.warn(msg); }
  }
};
need('GH_KEY');
need('OVERPASS_URL');
need('STORAGE');
need('SUPABASE_URL');
need('SUPABASE_SERVICE_ROLE');
need('SUPABASE_BUCKET');
need('PUBLIC_BASE_URL', false); // optional, for pretty links

if (process.env.STORAGE !== 'SUPABASE') {
  console.error('[ENV] STORAGE must be SUPABASE for this build.');
  process.exit(1);
}

const GH_KEY = process.env.GH_KEY;
const OVERPASS_URL = process.env.OVERPASS_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET;
const SUPABASE_PUBLIC_BUCKET =
  String(process.env.SUPABASE_PUBLIC_BUCKET || 'true').toLowerCase() === 'true';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

const PAD_KM_MIN = Number(process.env.PAD_KM_MIN || 8);
const PAD_KM_MAX = Number(process.env.PAD_KM_MAX || 25);
const BBOX_AREA_MAX_KM2 = Number(process.env.BBOX_AREA_MAX_KM2 || 2500);

// GH rate limiting (safe for free plan)
const GH_MAX_RPS = Math.max(0.5, Number(process.env.GH_MAX_RPS || 2));   // ≈120/min
const GH_MIN_GAP_MS = Math.max(50, Math.floor(1000 / GH_MAX_RPS));
const GH_JITTER_MS = Math.max(0, Number(process.env.GH_JITTER_MS || 60));

// Join/attach thresholds
const JOIN_RADIUS_M = parseInt(process.env.JOIN_RADIUS_M || '300', 10); // default 300 m
const JOIN_RADIUS_KM = Math.max(0.05, JOIN_RADIUS_M / 1000);            // never below 50 m

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });
const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);
const logger = pino();

/* ========= RATE-LIMITED FETCH ========= */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let lastTs = 0;
async function rlFetch(url, opts) {
  const now = Date.now();
  const wait = Math.max(0, (lastTs + GH_MIN_GAP_MS) - now) + Math.floor(Math.random() * GH_JITTER_MS);
  if (wait) await sleep(wait);
  lastTs = Date.now();

  const res = await fetch(url, opts);
  if (res.status === 429) {
    const ra = res.headers.get('retry-after');
    const waitMs = ra ? Math.max(0, Number(ra) * 1000) : 1200;
    await sleep(Math.max(waitMs, 800));
    return rlFetch(url, opts);
  }
  return res;
}

/* ========= UTIL ========= */
const polylineLenKm = (coords)=> coords.reduce((s,c,i)=> i ? s + distKm(coords[i-1], c) : 0, 0);

const tryParseCommaPair = (s) => {
  const m = String(s).trim().match(/^\s*(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)\s*$/);
  if (!m) return null;
  let a = parseFloat(m[1]), b = parseFloat(m[3]);
  const looksLatLon = Math.abs(a) <= 90 && Math.abs(b) <= 180;
  const looksLonLat = Math.abs(a) <= 180 && Math.abs(b) <= 90;
  if (looksLatLon && !looksLonLat) return [b, a];
  return [a, b];
};

const isFiniteNum = (n) => Number.isFinite(n) && !Number.isNaN(n);
const isPt = (p) => Array.isArray(p) && p.length === 2 && isFiniteNum(+p[0]) && isFiniteNum(+p[1]);
const fmtPt = (p) => isPt(p) ? `${(+p[0]).toFixed(5)},${(+p[1]).toFixed(5)}` : String(p);

function sameCoordinate(a, b, meters = 15) {
  if (!isPt(a) || !isPt(b)) return false;
  return distKm(a, b) <= meters / 1000;
}
function jitterPoint(p, meters = 10) {
  const dx = (Math.random() - 0.5) * (meters / 111320) * 2; // ~ meters to lon deg at equator
  const dy = (Math.random() - 0.5) * (meters / 110540) * 2; // ~ meters to lat deg
  return [p[0] + dx, p[1] + dy];
}
function collapseNearDuplicates(points, meters = 30) {
  const out = [];
  for (const p of points) {
    if (!isPt(p)) continue;
    if (!out.length) { out.push(p); continue; }
    if (distKm(out[out.length - 1], p) < meters / 1000) continue;
    out.push(p);
  }
  return out;
}

/** Remove bad points, collapse near-duplicates, and skip micro-hops.
 *  Returns {cleaned, summary} for logging.
 */
function cleanAnchors(rawAnchors, { minSegKm = 0.05 } = {}) {
  const cleaned = [];
  const summary = { malformed: 0, tooClose: 0, kept: 0 };
  let lastKept = null;
  for (const p of rawAnchors) {
    if (!isPt(p)) { summary.malformed++; continue; }
    const pt = [Number(p[0]), Number(p[1])];
    if (lastKept && distKm(lastKept, pt) < minSegKm) { summary.tooClose++; continue; }
    cleaned.push(pt);
    summary.kept++;
    lastKept = pt;
  }
  return { cleaned, summary };
}

// small caches to reduce calls
const geocodeCache = new Map();   // text -> [lon,lat]
const routeCache   = new Map();   // "lon1,lat1|lon2,lat2" -> GH JSON

/* ========= Geocoding ========= */
async function geocodeGH(text) {
  const u = `https://graphhopper.com/api/1/geocode?q=${encodeURIComponent(text)}&limit=1&locale=en&key=${GH_KEY}`;
  const r = await rlFetch(u, { headers: { 'User-Agent': 'adv-route/1.0' }});
  if (!r.ok) throw new Error(`GH geocode HTTP ${r.status}`);
  const j = await r.json();
  const h = j.hits?.[0];
  if (!h?.point) throw new Error('GH geocode: no hits');
  return { lon: h.point.lng, lat: h.point.lat };
}

async function geocodeNominatim(text) {
  const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(text)}`;
  const r = await fetch(u, { headers: { 'User-Agent': 'adv-route/1.0' }});
  if (!r.ok) throw new Error(`Nominatim HTTP ${r.status}`);
  const j = await r.json();
  const h = j?.[0];
  if (!h) throw new Error('Nominatim: no hits');
  return { lon: parseFloat(h.lon), lat: parseFloat(h.lat) };
}

async function parsePointOrGeocode(input) {
  if (Array.isArray(input)) return [Number(input[0]), Number(input[1])];
  if (input && typeof input === 'object' && 'lon' in input && 'lat' in input)
    return [Number(input.lon), Number(input.lat)];
  const s = String(input).trim();
  const pair = tryParseCommaPair(s);
  if (pair) return pair;
  if (geocodeCache.has(s)) return geocodeCache.get(s);
  try {
    const g = await geocodeGH(s); const out = [g.lon, g.lat];
    geocodeCache.set(s, out); return out;
  } catch {
    const g2 = await geocodeNominatim(s); const out = [g2.lon, g2.lat];
    geocodeCache.set(s, out); return out;
  }
}

/* ========= Overpass, GH CH, Supabase ========= */
async function overpassTracks(bbox) {
  if (!bbox) return [];
  const [south, west, north, east] = bbox;
  const q = `
[out:json][timeout:60];
way["highway"="track"]
  (${south},${west},${north},${east})
  ["surface"~"gravel|compacted|fine_gravel|ground|dirt"]
  ["tracktype"~"grade1|grade2|grade3"];
out geom;`;
  const r = await fetch(OVERPASS_URL, { method: 'POST', body: q });
  if (!r.ok) throw new Error(`Overpass error: ${await r.text()}`);
  const j = await r.json();
  return (j.elements || []).map((w) => ({
    id: String(w.id),
    coords: (w.geometry || []).map((g) => [g.lon, g.lat])
  }));
}

async function ghRouteCH(points, profile = 'car') {
  let cacheKey = null;
  if (points.length === 2) {
    const a = points[0], b = points[1];
    const keyA = `${a[0].toFixed(5)},${a[1].toFixed(5)}`;
    const keyB = `${b[0].toFixed(5)},${b[1].toFixed(5)}`;
    cacheKey = `${keyA}|${keyB}`;
    if (routeCache.has(cacheKey)) return routeCache.get(cacheKey);
  }
  const body = {
    profile,
    points: points.map(p => ({ lon:p[0], lat:p[1] })),
    points_encoded: false,
    locale: 'en',
    instructions: false
  };
  const url = `https://graphhopper.com/api/1/route?key=${GH_KEY}`;
  const r = await rlFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'adv-route/1.0' },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    // Bubble up GH error text (kept & hardened)
    let msg = `GH route HTTP ${r.status}`;
    try {
      const txt = await r.text();
      if (txt) {
        try { msg += `: ${JSON.parse(txt)?.message || txt}`; }
        catch { msg += `: ${txt}`; }
      }
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  const j = await r.json();
  if (cacheKey) routeCache.set(cacheKey, j);
  return j;
}

function toGPX(name, coords) {
  const trkpts = coords.map(c => `<trkpt lon="${c[0]}" lat="${c[1]}"></trkpt>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="adv-route"><trk><name>${name}</name><trkseg>${trkpts}</trkseg></trk></gpx>`;
}

async function uploadToSupabase(path, data, contentType) {
  const { data: res, error } = await supabase.storage.from(SUPABASE_BUCKET).upload(path, data, {
    contentType,
    upsert: true
  });
  if (error) throw error;
  if (!SUPABASE_PUBLIC_BUCKET) {
    const { data: signed } = await supabase.storage.from(SUPABASE_BUCKET).createSignedUrl(path, 60 * 60 * 24 * 30);
    return signed?.signedUrl || null;
  }
  const { data: pub } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(path);
  return pub.publicUrl || null;
}

async function storageUrlFor(path) {
  if (!SUPABASE_PUBLIC_BUCKET) {
    const { data } = await supabase.storage.from(SUPABASE_BUCKET).createSignedUrl(path, 60 * 60);
    return data?.signedUrl || null;
  }
  const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(path);
  return data?.publicUrl || null;
}

/* ========= Helpers ========= */
async function buildCHOnlyRoute(a, b, viaPts, log) {
  const points = collapseNearDuplicates([a, ...viaPts, b], 30);
  if (points.length >= 2 && sameCoordinate(points[0], points[points.length - 1], 10)) {
    // tiny jitter to avoid CH "same point" quirks in loops
    points[points.length - 1] = jitterPoint(points[points.length - 1], 11);
  }
  const gh = await ghRouteCH(points, 'car');
  const coords = gh.paths[0].points.coordinates.map(c=>[c[0],c[1]]);
  log?.info({ pts: points.length, km: +polylineLenKm(coords).toFixed(1) }, 'CH-only route built');
  return { coords, evidence: [{ type:'GH_mode', ref:'CH' }], autoAnchors: [] };
}

/* ========= Stitch builder ========= */
async function buildStitchedRoute(start, end, vias, tracks, dynMaxTracks, axisKm, parentLog) {
  const requestId = nanoid();
  const log = (parentLog || logger).child({ requestId });

  // --- choose a small set of candidate tracks ---
  const selected = [];
  for (const t of tracks) {
    if (!t?.coords?.length) continue;
    selected.push(t);
    if (selected.length >= dynMaxTracks) break;
  }
  log.info({ selected_track_ids: selected.map(t => t.id), dynMaxTracks }, 'stitch: selected tracks');

  // --- clean anchors (Patch B + summary) ---
  const rawAnchors = [start, ...vias, end];
  const { cleaned: anchors, summary } = cleanAnchors(rawAnchors, { minSegKm: 0.05 });
  log.info({ cleaning: summary, anchors: anchors.map(fmtPt) }, 'stitch: cleaned anchors');

  if (anchors.length < 2) {
    log.warn({ count: anchors.length }, 'anchors insufficient; falling back to CH-only');
    return buildCHOnlyRoute(start, end, vias, log);
  }

  // --- build CH connectors with rich logging ---
  const segments = [];
  let last = anchors[0];

  for (let i = 1; i < anchors.length; i++) {
    let next = anchors[i];
    const hopKm = distKm(last, next);
    if (hopKm < 0.05) {
      log.warn({ i, from: fmtPt(last), to: fmtPt(next), hopKm }, 'stitch: skip tiny connector');
      continue;
    }
    // collapse consecutive near-duplicates to keep GH happy
    const pair = collapseNearDuplicates([last, next], 30);
    if (pair.length < 2) continue;
    try {
      const ghSeg = await ghRouteCH(pair, 'car');
      const segCoords = ghSeg.paths[0].points.coordinates.map(c=>[c[0],c[1]]);
      const segKm = polylineLenKm(segCoords);
      log.info({ i, from: fmtPt(last), to: fmtPt(next), segKm }, 'stitch: connector');
      segments.push({ type:'connector', coords: segCoords });
      last = next;
    } catch (err) {
      log.error({ i, from: fmtPt(last), to: fmtPt(next), err: String(err) }, 'stitch: connector failed');
      // try to salvage by skipping this anchor once
      if (i + 1 < anchors.length) {
        const skipTo = anchors[i + 1];
        try {
          const ghSeg2 = await ghRouteCH(collapseNearDuplicates([last, skipTo], 30), 'car');
          const segCoords2 = ghSeg2.paths[0].points.coordinates.map(c=>[c[0],c[1]]);
          const segKm2 = polylineLenKm(segCoords2);
          log.warn({ i, skippedTo: fmtPt(skipTo), segKm2 }, 'stitch: recovered by skipping one anchor');
          segments.push({ type:'connector', coords: segCoords2 });
          last = skipTo;
          i++; // skip one anchor
          continue;
        } catch (err2) {
          log.error({ i, err2: String(err2) }, 'stitch: recovery failed; falling back to CH-only');
          return buildCHOnlyRoute(start, end, vias, log);
        }
      } else {
        log.error({ i }, 'stitch: last connector failed; falling back to CH-only');
        return buildCHOnlyRoute(start, end, vias, log);
      }
    }
  }

  if (!segments.length) {
    log.warn('stitch: no connectors built; falling back to CH-only');
    return buildCHOnlyRoute(start, end, vias, log);
  }

  // --- append track segments when endpoints are close ---
  const merged=[]; let selIdx=0;
  for (const seg of segments){
    merged.push(seg);
    const track = selected[selIdx];
    const endPt = seg.coords[seg.coords.length-1];
    if (track && distKm(endPt, track.coords[0]) < JOIN_RADIUS_KM) {
      const trackKm = polylineLenKm(track.coords);
      log.info({ id: track.id, km: trackKm, attach_radius_km: JOIN_RADIUS_KM }, 'stitch: attach track');
      merged.push({type:'track', id:track.id, coords:track.coords});
      selIdx++;
    }
  }

  // --- merge to one polyline + collect autoAnchors for evidence ---
  const coords = [];
  const autoAnchors = [];
  if (merged.length) coords.push(merged[0].coords[0]);
  for (const seg of merged) {
    const c = seg.coords.slice(1);
    coords.push(...c);
    if (seg.type === 'track' && seg.coords?.length) autoAnchors.push(seg.coords[0]);
  }

  const evidence = [{ type:'GH_mode', ref:'STITCH' }];
  if (autoAnchors.length) evidence.push({ type:'auto_anchors', ref:String(autoAnchors.length) });

  return { coords, evidence, autoAnchors };
}

/* ========= API ========= */
app.post('/plan', async (req, res) => {
  const requestId = nanoid();
  const log = logger.child({ requestId });
  try {
    const {
      start,
      end,
      vias = [],
      distance_km_target,
      time_budget_h,
      region_hint_bbox,
      strategy = 'ch',
      off_pavement_target,
      loop
    } = validatePlan(req.body);

    let a = await parsePointOrGeocode(start);
    let b = await parsePointOrGeocode(end);
    const viaPts = [];
    for (const v of vias) viaPts.push(await parsePointOrGeocode(v));

    // loop-friendly: avoid identical start/end for CH
    if (loop && sameCoordinate(a, b, 10)) {
      b = jitterPoint(b, 11);
    }

    const off = Math.max(0, Math.min(0.9, Number(off_pavement_target ?? 0.3)));
    const avgSpeedKmh = (1 - off) * 50 + off * 30;
    const kmTarget = Number(distance_km_target) > 0
      ? Number(distance_km_target)
      : (Number(time_budget_h) > 0 ? Math.max(15, Math.min(400, Number(time_budget_h) * avgSpeedKmh)) : 80);

    const { bbox: autoBbox, padKm, areaKm2, shrunk } = corridorBBox(a, b, { PAD_KM_MIN, PAD_KM_MAX, BBOX_AREA_MAX_KM2 });
    let bbox = autoBbox;
    if (Array.isArray(region_hint_bbox) && region_hint_bbox.length === 4) {
      const userBbox = region_hint_bbox.map(Number);
      const userArea = bboxAreaKm2(userBbox);
      if (userArea <= areaKm2 && userArea <= BBOX_AREA_MAX_KM2) {
        bbox = userBbox;
      } else {
        log.info({ clamped: true, userArea }, 'supplied bbox too large');
      }
    }
    log.info({ pad_km: padKm, bbox_area_km2: bboxAreaKm2(bbox), shrunk }, 'corridor');

    const tracks = await overpassTracks(bbox).catch((e) => {
      log.warn({ err: String(e) }, 'overpass failed; proceeding without tracks');
      return [];
    });

    const dynMaxTracks =
      kmTarget <= 60 ? 1 :
      kmTarget <= 120 ? 2 :
      kmTarget <= 180 ? 3 : 4;

    const axisKm = Math.max(4, Math.min(8, kmTarget / 25));

    let coords, note;
    let evidence = [];

    if (strategy === 'stitch') {
      try {
        const built = await buildStitchedRoute(a, b, viaPts, tracks, dynMaxTracks, axisKm, log);
        coords = built.coords;
        evidence = built.evidence;
        note = `STITCH mode: CH connectors + OSM tracks. Corridor ~${padKm.toFixed(0)}km pad, kmTarget≈${kmTarget.toFixed(0)}.`;
      } catch (err) {
        log.error({ err: String(err) }, 'stitch failed; falling back to CH-only');
        const built = await buildCHOnlyRoute(a, b, viaPts, log);
        coords = built.coords;
        evidence = built.evidence.concat([{ type:'auto_anchors', ref:'0' }]);
        note = `CH fallback: connectors only. Corridor ~${padKm.toFixed(0)}km pad, kmTarget≈${kmTarget.toFixed(0)}.`;
      }
    } else {
      const built = await buildCHOnlyRoute(a, b, viaPts, log);
      coords = built.coords;
      evidence = built.evidence;
      note = 'CH mode: standard routing (free plan).';
    }

    const routeId = nanoid();
    const gpx = toGPX('ADV Route', coords);
    const gpxUrl = await uploadToSupabase(`routes/${routeId}.gpx`, Buffer.from(gpx), 'application/gpx+xml');
    const geojsonBlob = Buffer.from(JSON.stringify({ type:'Feature', properties:{ name:'ADV Route' }, geometry:{ type:'LineString', coordinates: coords }}));
    const geojsonUrl = await uploadToSupabase(`routes/${routeId}.geojson`, geojsonBlob, 'application/geo+json');

    const previewUrl  = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/v/${routeId}` : null;
    const prettyGpx   = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/download/route/${routeId}.gpx` : gpxUrl;
    const prettyGeo   = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/download/route/${routeId}.geojson` : geojsonUrl;

    res.json({
      routes: [{
        id: routeId,
        name: strategy === 'stitch' ? 'ADV Option (Stitched)' : 'ADV Option (CH)',
        summary: note,
        stats: { distance_km: +polylineLenKm(coords).toFixed(1), duration_h: null, ascent_m: null },
        gpx_url: gpxUrl,
        geojson_url: geojsonUrl,
        preview_url: previewUrl,
        pretty_gpx_url: prettyGpx,
        pretty_geojson_url: prettyGeo,
        custom_model_used: null,
        via_points_used: [a, ...viaPts, b],
        km_target_used: +kmTarget.toFixed(1),
        corridor_pad_km: +padKm.toFixed(1)
      }],
      evidence
    });
  } catch (e) {
    if (e instanceof ZodError) return res.status(400).json({ error: e.message });
    log.error(e);
    res.status(500).json({ error: String(e) });
  }
});

/* ========= DOWNLOAD & PREVIEW ========= */
app.get('/download/route/:id.:ext', async (req, res) => {
  try {
    const { id, ext } = req.params;
    if (!['gpx', 'geojson'].includes(ext)) return res.status(400).send('bad extension');
    const path = `routes/${id}.${ext}`;
    const url = await storageUrlFor(path);
    if (!url) return res.status(404).send('not found');
    return res.redirect(302, url);
  } catch (e) {
    console.error(e);
    res.status(500).send('server error');
  }
});

app.get('/v/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const geoUrl = await storageUrlFor(`routes/${id}.geojson`);
    if (!geoUrl) return res.status(404).send('route not found');

    const prettyGpx  = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/download/route/${id}.gpx` : geoUrl;
    const prettyGeo  = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/download/route/${id}.geojson` : geoUrl;

    res.set('content-type', 'text/html; charset=utf-8').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ADV Route – ${id}</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
  <style>
    html, body { height:100%; margin:0; }
    #map { position:absolute; inset:0; }
    .panel {
      position:absolute; left:0; right:0; bottom:0;
      display:flex; gap:.5rem; justify-content:center; flex-wrap:wrap;
      padding:.6rem; background: rgba(255,255,255,.92);
      box-shadow: 0 -4px 12px rgba(0,0,0,.12);
      font: 14px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    }
    .btn {
      text-decoration:none; padding:.55rem .8rem; border-radius:10px;
      border:1px solid #ccc; background:#fff; color:#111;
    }
  </style>
</head>
<body>
  <div id="map"></div>
  <div class="panel">
    <a class="btn" href="${prettyGpx}" target="_blank">Download GPX</a>
    <a class="btn" href="${prettyGeo}" target="_blank">Download GeoJSON</a>
  </div>

  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const map = L.map('map', { zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap'
    }).addTo(map);

    fetch(${JSON.stringify(geoUrl)})
      .then(r => r.json())
      .then(geo => {
        const layer = L.geoJSON(geo, { style: { weight: 4, opacity: .9 } }).addTo(map);
        try { map.fitBounds(layer.getBounds(), { padding: [24,24] }); }
        catch { map.setView([38.72,-9.14], 12); }
      })
      .catch(() => map.setView([38.72,-9.14], 12));
  </script>
</body>
</html>`);
  } catch (e) {
    console.error(e);
    res.status(500).send('server error');
  }
});

app.post('/refine', async (req, res) => { 
  req.url = '/plan'; 
  app._router.handle(req, res, () => {}); 
});

app.get('/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log(`ADV backend on :${PORT} | GH_MAX_RPS=${GH_MAX_RPS} | JOIN_RADIUS_M=${JOIN_RADIUS_M}`)
);

