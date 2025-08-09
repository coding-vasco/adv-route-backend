// src/server.js — CH + STITCH + geocoding + auto-BBox
// Adds: alias anchors, snap-to-road, pretty download redirects, browser preview page

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
need('PUBLIC_BASE_URL', false); // optional, but used for pretty links

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

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });
const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);

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
  let a = parseFloat(m[1]); // first
  let b = parseFloat(m[3]); // second
  // Detect lat,lon vs lon,lat and fix to lon,lat
  const looksLatLon = Math.abs(a) <= 90 && Math.abs(b) <= 180;
  const looksLonLat = Math.abs(a) <= 180 && Math.abs(b) <= 90;
  if (looksLatLon && !looksLonLat) return [b, a]; // it was lat,lon
  return [a, b]; // assume lon,lat
};

// --- Common anchor aliases -> stable coordinates (lon,lat)
const anchorAliases = [
  { re: /ponte.*25.*abril|25\s*de\s*abril/i, coord: [-9.1488, 38.6997] },     // 25 de Abril deck
  { re: /cabo\s+espichel/i, coord: [-9.209, 38.414] },                         // rough Cabo Espichel
  { re: /arr[aá]bida/i, coord: [-9.020, 38.480] },                             // Arrábida area
];

function aliasToCoord(s) {
  const txt = String(s || '');
  for (const a of anchorAliases) if (a.re.test(txt)) return a.coord;
  return null;
}

// GraphHopper Geocoder (separate from routing)
const geocodeGH = async (text) => {
  const u = `https://graphhopper.com/api/1/geocode?q=${encodeURIComponent(text)}&limit=1&locale=en&key=${GH_KEY}`;
  const r = await fetch(u);
  if (!r.ok) throw new Error(`GH geocode HTTP ${r.status}`);
  const j = await r.json();
  const h = j.hits?.[0];
  if (!h?.point) throw new Error('GH geocode: no hits');
  return { lon: h.point.lng, lat: h.point.lat, provider: 'gh' };
};

// Nominatim fallback
const geocodeNominatim = async (text) => {
  const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(text)}`;
  const r = await fetch(u, { headers: { 'User-Agent': 'adv-route/1.0' }});
  if (!r.ok) throw new Error(`Nominatim HTTP ${r.status}`);
  const j = await r.json();
  const h = j?.[0];
  if (!h) throw new Error('Nominatim: no hits');
  return { lon: parseFloat(h.lon), lat: parseFloat(h.lat), provider: 'nominatim' };
};

const parsePointOrGeocode = async (input) => {
  if (Array.isArray(input)) return [Number(input[0]), Number(input[1])];
  if (input && typeof input === 'object' && 'lon' in input && 'lat' in input) {
    return [Number(input.lon), Number(input.lat)];
  }
  // alias first
  const alias = aliasToCoord(input);
  if (alias) return alias;

  const s = String(input).trim();
  const pair = tryParseCommaPair(s);
  if (pair) return pair; // already lon,lat (or fixed)
  try {
    const g = await geocodeGH(s);
    return [g.lon, g.lat];
  } catch {
    const g2 = await geocodeNominatim(s);
    return [g2.lon, g2.lat];
  }
};

const autoBBoxFromPoints = (a, b, padKm = 25) => {
  const minLat = Math.min(a[1], b[1]), maxLat = Math.max(a[1], b[1]);
  const minLon = Math.min(a[0], b[0]), maxLon = Math.max(a[0], b[0]);
  const latPad = padKm / 111;
  const midLat = (a[1] + b[1]) / 2;
  const lonPad = padKm / (111 * Math.cos(toRad(midLat)) || 1);
  return [minLat - latPad, minLon - lonPad, maxLat + latPad, maxLon + lonPad]; // [S,W,N,E]
};

/* ========= Overpass, GH CH, Supabase ========= */
const overpassTracks = async (bbox) => {
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
};

const ghRouteCH = async (points, profile = 'car') => {
  const body = { profile, points, points_encoded: false, instructions: false, locale: 'en' };
  const url = `https://graphhopper.com/api/1/route?key=${GH_KEY}`;
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`GraphHopper error: ${await r.text()}`);
  const j = await r.json();
  j._routing_mode = 'CH';
  return j;
};

const toGPX = (name, coords) => `<?xml version="1.0"?>
<gpx version="1.1" creator="adv-route" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${name}</name><trkseg>${
    coords.map(([lon,lat])=>`<trkpt lat="${lat}" lon="${lon}"></trkpt>`).join('')
  }</trkseg></trk>
</gpx>`;

const uploadToSupabase = async (path, buffer, contentType) => {
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
};

// Get a public (or signed) URL for an existing storage path
async function storageUrlFor(path) {
  if (SUPABASE_PUBLIC_BUCKET) {
    const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(path);
    return data.publicUrl;
  } else {
    const { data, error } = await supabase
      .storage.from(SUPABASE_BUCKET)
      .createSignedUrl(path, 60 * 60); // 1 hour
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
function selectTracksAlongAxis(tracks, start, end, {max=6, maxAxisKm=8}) {
  const scored = tracks.map(w=>{
    if (!w.coords?.length) return null;
    const mid = w.coords[Math.floor(w.coords.length/2)];
    const t = project01(mid, start, end);
    const ptOnAxis = lerp(start,end,t);
    const off = distKm(mid, ptOnAxis);
    const len = polylineLenKm(w.coords);
    return { id:w.id, coords:w.coords, t, off, len };
  }).filter(Boolean).filter(x=>x.off<=maxAxisKm);
  // keep spaced & longer
  const out=[]; const minGap=0.1;
  for (const cand of scored.sort((a,b)=>b.len-a.len)) {
    if (out.find(o=>Math.abs(o.t-cand.t)<minGap)) continue;
    out.push(cand);
    if (out.length>=max) break;
  }
  return out.sort((a,b)=>a.t-b.t);
}

// Try to snap a coordinate to nearest routable point using a micro CH route
async function snapToRoad([lon, lat]) {
  const meters = [50, 120, 250, 400, 600, 900];
  const bearings = [0, 60, 120, 180, 240, 300];
  const dLat = (m) => m / 111000;
  const dLon = (m) => m / (111000 * Math.cos(toRad(lat)) || 1);

  for (const m of meters) {
    for (const b of bearings) {
      const rad = Math.PI * b / 180;
      const dx = Math.cos(rad) * dLon(m);
      const dy = Math.sin(rad) * dLat(m);
      try {
        const gh = await ghRouteCH([[lon, lat], [lon + dx, lat + dy]], 'car');
        const snapped = gh.paths?.[0]?.points?.coordinates?.[0];
        if (snapped) return [snapped[0], snapped[1]];
      } catch { /* try next offset */ }
    }
  }
  return [lon, lat];
}

/* ========= API ========= */

app.post('/plan', async (req, res) => {
  try {
    const { start, end, vias = [], region_hint_bbox, strategy = 'stitch' } = req.body;

    if (!start || !end) return res.status(400).json({ error: 'start and end are required (address/place or lon,lat)' });

    // Geocode/parse inputs
    const a0 = await parsePointOrGeocode(start);
    const b0 = await parsePointOrGeocode(end);
    const viaRaw = [];
    for (const v of vias) viaRaw.push(await parsePointOrGeocode(v));

    // Snap to road network (improves CH success for vague points)
    const a = await snapToRoad(a0);
    const b = await snapToRoad(b0);
    const viaPts = [];
    for (const v of viaRaw) viaPts.push(await snapToRoad(v));

    // BBox: use provided or derive
    const bbox = Array.isArray(region_hint_bbox) && region_hint_bbox.length===4
      ? region_hint_bbox.map(Number)
      : autoBBoxFromPoints(a, b, 25);

    // Overpass discovery (evidence + stitch input)
    const tracks = await overpassTracks(bbox).catch(() => []);

    let coords, note; const evidence = [{ type:'GH_mode', ref:'CH' }];

    if (strategy === 'stitch') {
      const built = await (async () => {
        const selected = selectTracksAlongAxis(tracks, a, b, {max:6, maxAxisKm:8});
        const anchors = [a, ...viaPts, ...selected.map(s=>s.coords[0]), b];
        const segments = [];
        let last = anchors[0];
        for (let i=1;i<anchors.length;i++){
          const next = anchors[i];
          const gh = await ghRouteCH([last, next], 'car');
          const coords = gh.paths[0].points.coordinates.map(c=>[c[0],c[1]]);
          segments.push({type:'connector', coords});
          last = next;
        }
        const merged=[]; let selIdx=0;
        for (const seg of segments){
          merged.push(seg);
          const track = selected[selIdx];
          const endPt = seg.coords[seg.coords.length-1];
          if (track && distKm(endPt, track.coords[0]) < 0.15) { merged.push({type:'track', id:track.id, coords:track.coords}); selIdx++; }
        }
        const all=[]; for (const s of merged){ if (all.length) all.pop(); all.push(...s.coords); }
        const evidence = selected.map(s=>({type:'OSM_track', ref:s.id, km:+polylineLenKm(s.coords).toFixed(2)}));
        return { coords: all, evidence };
      })();

      coords = built.coords;
      evidence.push(...built.evidence);
      note = 'STITCH mode: CH connectors + OSM tracks (no Custom Model).';
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
        via_points_used: [a, ...viaPts, b]
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
app.listen(process.env.PORT || 8080, () => console.log(`ADV backend on :${process.env.PORT || 8080}`));
