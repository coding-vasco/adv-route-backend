// src/server.js — CH + STITCH + geocoding + rate limiting/backoff
// Patch A: time_budget_h/distance_km_target -> kmTarget + corridor limit
// Patch B: auto-anchors from Overpass tracks (evenly spaced along axis)
// Also: pretty download redirects + Leaflet preview page.

import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import { customAlphabet } from 'nanoid';

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

// GH rate limiting (safe for free plan)
const GH_MAX_RPS = Math.max(0.5, Number(process.env.GH_MAX_RPS || 2));   // ≈120/min
const GH_MIN_GAP_MS = Math.max(50, Math.floor(1000 / GH_MAX_RPS));
const GH_JITTER_MS = Math.max(0, Number(process.env.GH_JITTER_MS || 60));

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });
const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);

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

/* ========= UTIL: coords, geocode, bbox ========= */
const toRad = (deg) => deg * Math.PI / 180;
const distKm = ([lon1,lat1],[lon2,lat2]) => {
  const R=6371, dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
};
const polylineLenKm = (coords)=> coords.reduce((s,c,i)=> i? s+distKm(coords[i-1],c):0,0);

const tryParseCommaPair = (s) => {
  const m = String(s).trim().match(/^\s*(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)\s*$/);
  if (!m) return null;
  let a = parseFloat(m[1]), b = parseFloat(m[3]);
  const looksLatLon = Math.abs(a) <= 90 && Math.abs(b) <= 180;
  const looksLonLat = Math.abs(a) <= 180 && Math.abs(b) <= 90;
  if (looksLatLon && !looksLonLat) return [b, a];
  return [a, b];
};

// small caches to reduce calls
const geocodeCache = new Map();   // text -> [lon,lat]
const routeCache   = new Map();   // "lon1,lat1|lon2,lat2" -> GH JSON

// GraphHopper geocoder (RL)
async function geocodeGH(text) {
  const u = `https://graphhopper.com/api/1/geocode?q=${encodeURIComponent(text)}&limit=1&locale=en&key=${GH_KEY}`;
  const r = await rlFetch(u, { headers: { 'User-Agent': 'adv-route/1.0' }});
  if (!r.ok) throw new Error(`GH geocode HTTP ${r.status}`);
  const j = await r.json();
  const h = j.hits?.[0];
  if (!h?.point) throw new Error('GH geocode: no hits');
  return { lon: h.point.lng, lat: h.point.lat };
}

// Nominatim fallback
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

// bbox from two points with custom padding (km)
function bboxFromTwoPoints(a, b, padKm) {
  const minLat = Math.min(a[1], b[1]), maxLat = Math.max(a[1], b[1]);
  const minLon = Math.min(a[0], b[0]), maxLon = Math.max(a[0], b[0]);
  const latPad = padKm / 111;
  const midLat = (a[1] + b[1]) / 2;
  const lonPad = padKm / (111 * Math.cos(toRad(midLat)) || 1);
  return [minLat - latPad, minLon - lonPad, maxLat + latPad, maxLon + lonPad]; // [S,W,N,E]
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
    cacheKey = `${a[0].toFixed(5)},${a[1].toFixed(5)}|${b[0].toFixed(5)},${b[1].toFixed(5)}`;
    if (routeCache.has(cacheKey)) return routeCache.get(cacheKey);
  }

  const body = { profile, points, points_encoded: false, instructions: false, locale: 'en' };
  const url = `https://graphhopper.com/api/1/route?key=${GH_KEY}`;
  const r = await rlFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`GraphHopper error: ${await r.text()}`);
  const j = await r.json();
  j._routing_mode = 'CH';

  if (cacheKey) routeCache.set(cacheKey, j);
  return j;
}

/* ========= Files ========= */
const toGPX = (name, coords) => `<?xml version="1.0"?>
<gpx version="1.1" creator="adv-route" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${name}</name><trkseg>${
    coords.map(([lon,lat])=>`<trkpt lat="${lat}" lon="${lon}"></trkpt>`).join('')
  }</trkseg></trk>
</gpx>`;

async function uploadToSupabase(path, buffer, contentType) {
  const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(path, buffer, { contentType, upsert: true });
  if (error) throw error;
  if (SUPABASE_PUBLIC_BUCKET) {
    const { data: pub } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(path);
    return pub.publicUrl;
  } else {
    const { data: signed, error: signErr } = await supabase.storage.from(SUPABASE_BUCKET).createSignedUrl(path, 60 * 60 * 24 * 7);
    if (signErr) throw signErr;
    return signed.signedUrl;
  }
}
async function storageUrlFor(path) {
  if (SUPABASE_PUBLIC_BUCKET) {
    const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(path);
    return data.publicUrl;
  } else {
    const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).createSignedUrl(path, 60 * 60);
    if (error) throw error;
    return data.signedUrl;
  }
}

/* ========= STITCH helpers ========= */
const lerp = (a,b,t)=>[a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t];
const project01 = (p,a,b)=>{
  const ax=a[0], ay=a[1], bx=b[0], by=b[1], px=p[0], py=p[1];
  const vx=bx-ax, vy=by-ay, wx=px-ax, wy=py-ay;
  const vv=vx*vx+vy*vy || 1e-9; const t=(vx*wx+vy*wy)/vv; return Math.max(0,Math.min(1,t));
};

function selectTracksAlongAxis(tracks, start, end, {max=3, maxAxisKm=6}) {
  const scored = tracks.map(w=>{
    if (!w.coords?.length) return null;
    const mid = w.coords[Math.floor(w.coords.length/2)];
    const t = project01(mid, start, end);
    const ptOnAxis = lerp(start,end,t);
    const off = distKm(mid, ptOnAxis);
    const len = polylineLenKm(w.coords);
    return { id:w.id, coords:w.coords, t, off, len };
  }).filter(Boolean).filter(x=>x.off<=maxAxisKm);

  const out=[]; const minGap=0.12; // keep anchors spaced
  for (const cand of scored.sort((a,b)=>b.len-a.len)) {
    if (out.find(o=>Math.abs(o.t-cand.t)<minGap)) continue;
    out.push(cand);
    if (out.length>=max) break;
  }
  return out.sort((a,b)=>a.t-b.t);
}

async function buildStitchedRoute(start, end, vias, tracks, dynMaxTracks, axisKm) {
  const selected = selectTracksAlongAxis(tracks, start, end, {max: dynMaxTracks, maxAxisKm: axisKm});
  // Auto-anchors: track starts, evenly spaced along axis
  const autoAnchors = selected.map(s=>s.coords[0]);
  const anchors = [start, ...vias, ...autoAnchors, end];

  // CH connectors between anchors
  const segments = [];
  let last = anchors[0];
  for (let i=1;i<anchors.length;i++){
    const next = anchors[i];
    const gh = await ghRouteCH([last, next], 'car');
    const coords = gh.paths[0].points.coordinates.map(c=>[c[0],c[1]]);
    segments.push({type:'connector', coords});
    last = next;
  }

  // Insert track polylines after their nearest connector
  const merged=[]; let selIdx=0;
  for (const seg of segments){
    merged.push(seg);
    const track = selected[selIdx];
    const endPt = seg.coords[seg.coords.length-1];
    if (track && distKm(endPt, track.coords[0]) < 0.15) {
      merged.push({type:'track', id:track.id, coords:track.coords});
      selIdx++;
    }
  }

  const all=[];
  for (const s of merged){ if (all.length) all.pop(); all.push(...s.coords); }
  const evidence = selected.map(s=>({type:'OSM_track', ref:s.id, km:+polylineLenKm(s.coords).toFixed(2)}));
  return { coords: all, evidence, autoAnchors };
}

/* ========= API ========= */

app.post('/plan', async (req, res) => {
  try {
    const {
      start, end,
      vias = [],
      region_hint_bbox,
      strategy = 'stitch',
      // NEW knobs (optional)
      time_budget_h,
      distance_km_target,
      off_pavement_target,
      loop
    } = req.body;

    if (!start || !end) return res.status(400).json({ error: 'start and end are required (address/place or lon,lat)' });

    // Geocode/parse
    const a = await parsePointOrGeocode(start);
    const b = await parsePointOrGeocode(end);
    const viaPts = [];
    for (const v of vias) viaPts.push(await parsePointOrGeocode(v));

    // ------- Patch A: km target + corridor pad -------
    const off = Math.max(0, Math.min(0.9, Number(off_pavement_target ?? 0.3)));
    const avgSpeedKmh = (1 - off) * 50 + off * 30; // rough paved/offroad blend
    const kmTarget = Number(distance_km_target) > 0
      ? Number(distance_km_target)
      : (Number(time_budget_h) > 0 ? Math.max(15, Math.min(400, Number(time_budget_h) * avgSpeedKmh)) : 80);

    // corridor padding (km): tighter for short trips, wider for long
    const padKm = Math.max(8, Math.min(35, (loop ? kmTarget/3 : kmTarget/2)));
    const bbox = Array.isArray(region_hint_bbox) && region_hint_bbox.length===4
      ? region_hint_bbox.map(Number)
      : bboxFromTwoPoints(a, b, padKm);

    // ------- Overpass discovery (tracks) -------
    const tracks = await overpassTracks(bbox).catch(() => []);

    // Dynamic limits tied to kmTarget
    const dynMaxTracks =
      kmTarget <= 60 ? 1 :
      kmTarget <= 120 ? 2 :
      kmTarget <= 180 ? 3 : 4;

    const axisKm = Math.max(4, Math.min(8, kmTarget / 25)); // allowable lateral offset from axis

    let coords, note; const evidence = [{ type:'GH_mode', ref:'CH' }];

    if (strategy === 'stitch') {
      // ------- Patch B: auto-anchors from Overpass -------
      const built = await buildStitchedRoute(a, b, viaPts, tracks, dynMaxTracks, axisKm);
      coords = built.coords;
      evidence.push(...built.evidence);
      if (built.autoAnchors?.length) evidence.push({ type:'auto_anchors', ref: String(built.autoAnchors.length) });
      note = `STITCH mode: CH connectors + OSM tracks. Corridor ~${padKm.toFixed(0)}km pad, kmTarget≈${kmTarget.toFixed(0)}.`;
    } else {
      const gh = await ghRouteCH([a, ...viaPts, b], 'car');
      coords = gh.paths[0].points.coordinates.map(c=>[c[0],c[1]]);
      note = 'CH mode: standard routing (free plan).';
    }

    // Files
    const routeId = nanoid();
    const gpx = toGPX('ADV Route', coords);
    const gpxUrl = await uploadToSupabase(`routes/${routeId}.gpx`, Buffer.from(gpx), 'application/gpx+xml');
    const geojsonBlob = Buffer.from(JSON.stringify({ type:'Feature', properties:{ name:'ADV Route' }, geometry:{ type:'LineString', coordinates: coords }}));
    const geojsonUrl = await uploadToSupabase(`routes/${routeId}.geojson`, geojsonBlob, 'application/geo+json');

    // Pretty links + preview URL
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
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

// Pretty download URLs -> redirect to Supabase
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

// Lightweight Leaflet preview page
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

app.post('/refine', async (req, res) => { req.url = '/plan'; app._router.handle(req, res, () => {}); });
app.get('/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log(`ADV backend on :${PORT} | GH_MAX_RPS=${GH_MAX_RPS}`)
);
