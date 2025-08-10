 (cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'EOF' 
diff --git a/src/server.js b/src/server.js
index 25f8bd0ca03dfe8931fcace10314ea1f23ec3236..a064a3be1a59c71623732e9b432daa5326198366 100644
--- a/src/server.js
+++ b/src/server.js
@@ -1,103 +1,104 @@
 // src/server.js — CH + STITCH + geocoding + rate limiting/backoff
 // Patch A: time_budget_h/distance_km_target -> kmTarget + corridor limit
 // Patch B: auto-anchors from Overpass tracks (evenly spaced along axis)
 // Also: pretty download redirects + Leaflet preview page.
 
 import 'dotenv/config';
 import express from 'express';
-import fetch from 'node-fetch';
 import { createClient } from '@supabase/supabase-js';
 import { customAlphabet } from 'nanoid';
+import pino from 'pino';
+import { corridorBBox, bboxAreaKm2, distKm } from './lib/bbox.js';
+import { validatePlan } from './lib/normalize.js';
+import { ZodError } from 'zod';
 
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
+const PAD_KM_MIN = Number(process.env.PAD_KM_MIN || 8);
+const PAD_KM_MAX = Number(process.env.PAD_KM_MAX || 25);
+const BBOX_AREA_MAX_KM2 = Number(process.env.BBOX_AREA_MAX_KM2 || 2500);
 
 // GH rate limiting (safe for free plan)
 const GH_MAX_RPS = Math.max(0.5, Number(process.env.GH_MAX_RPS || 2));   // ≈120/min
 const GH_MIN_GAP_MS = Math.max(50, Math.floor(1000 / GH_MAX_RPS));
 const GH_JITTER_MS = Math.max(0, Number(process.env.GH_JITTER_MS || 60));
 
 const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });
 const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);
+const logger = pino();
 
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
-const toRad = (deg) => deg * Math.PI / 180;
-const distKm = ([lon1,lat1],[lon2,lat2]) => {
-  const R=6371, dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
-  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
-  return 2*R*Math.asin(Math.sqrt(a));
-};
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
diff --git a/src/server.js b/src/server.js
index 25f8bd0ca03dfe8931fcace10314ea1f23ec3236..a064a3be1a59c71623732e9b432daa5326198366 100644
--- a/src/server.js
+++ b/src/server.js
@@ -111,59 +112,50 @@ async function geocodeNominatim(text) {
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
 
-// bbox from two points with custom padding (km)
-function bboxFromTwoPoints(a, b, padKm) {
-  const minLat = Math.min(a[1], b[1]), maxLat = Math.max(a[1], b[1]);
-  const minLon = Math.min(a[0], b[0]), maxLon = Math.max(a[0], b[0]);
-  const latPad = padKm / 111;
-  const midLat = (a[1] + b[1]) / 2;
-  const lonPad = padKm / (111 * Math.cos(toRad(midLat)) || 1);
-  return [minLat - latPad, minLon - lonPad, maxLat + latPad, maxLon + lonPad]; // [S,W,N,E]
-}
 
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
diff --git a/src/server.js b/src/server.js
index 25f8bd0ca03dfe8931fcace10314ea1f23ec3236..a064a3be1a59c71623732e9b432daa5326198366 100644
--- a/src/server.js
+++ b/src/server.js
@@ -257,83 +249,87 @@ async function buildStitchedRoute(start, end, vias, tracks, dynMaxTracks, axisKm
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
+  const requestId = nanoid();
+  const log = logger.child({ requestId });
   try {
     const {
       start, end,
       vias = [],
       region_hint_bbox,
       strategy = 'stitch',
-      // NEW knobs (optional)
       time_budget_h,
       distance_km_target,
       off_pavement_target,
       loop
-    } = req.body;
-
-    if (!start || !end) return res.status(400).json({ error: 'start and end are required (address/place or lon,lat)' });
+    } = validatePlan(req.body);
 
-    // Geocode/parse
     const a = await parsePointOrGeocode(start);
     const b = await parsePointOrGeocode(end);
     const viaPts = [];
     for (const v of vias) viaPts.push(await parsePointOrGeocode(v));
 
-    // ------- Patch A: km target + corridor pad -------
     const off = Math.max(0, Math.min(0.9, Number(off_pavement_target ?? 0.3)));
-    const avgSpeedKmh = (1 - off) * 50 + off * 30; // rough paved/offroad blend
+    const avgSpeedKmh = (1 - off) * 50 + off * 30;
     const kmTarget = Number(distance_km_target) > 0
       ? Number(distance_km_target)
       : (Number(time_budget_h) > 0 ? Math.max(15, Math.min(400, Number(time_budget_h) * avgSpeedKmh)) : 80);
 
-    // corridor padding (km): tighter for short trips, wider for long
-    const padKm = Math.max(8, Math.min(35, (loop ? kmTarget/3 : kmTarget/2)));
-    const bbox = Array.isArray(region_hint_bbox) && region_hint_bbox.length===4
-      ? region_hint_bbox.map(Number)
-      : bboxFromTwoPoints(a, b, padKm);
+    const { bbox: autoBbox, padKm, areaKm2, shrunk } = corridorBBox(a, b, { PAD_KM_MIN, PAD_KM_MAX, BBOX_AREA_MAX_KM2 });
+    let bbox = autoBbox;
+    if (Array.isArray(region_hint_bbox) && region_hint_bbox.length === 4) {
+      const userBbox = region_hint_bbox.map(Number);
+      const userArea = bboxAreaKm2(userBbox);
+      if (userArea <= areaKm2 && userArea <= BBOX_AREA_MAX_KM2) {
+        bbox = userBbox;
+      } else {
+        log.info({ clamped: true, userArea }, 'supplied bbox too large');
+      }
+    }
+    log.info({ pad_km: padKm, bbox_area_km2: bboxAreaKm2(bbox), shrunk }, 'corridor');
 
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
diff --git a/src/server.js b/src/server.js
index 25f8bd0ca03dfe8931fcace10314ea1f23ec3236..a064a3be1a59c71623732e9b432daa5326198366 100644
--- a/src/server.js
+++ b/src/server.js
@@ -348,51 +344,52 @@ app.post('/plan', async (req, res) => {
 
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
-    console.error(e);
+    if (e instanceof ZodError) return res.status(400).json({ error: e.message });
+    log.error(e);
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
 
EOF
)
