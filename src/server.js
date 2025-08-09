// src/server.js — CH + STITCH, now with built-in geocoding & auto-BBox

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
need('PUBLIC_BASE_URL', false);

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

// GraphHopper Geocoder (free to use, separate from routing mode)
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
  // Array, object with lon/lat, or string
  if (Array.isArray(input)) return [Number(input[0]), Number(input[1])];
  if (input && typeof input === 'object' && 'lon' in input && 'lat' in input) {
    return [Number(input.lon), Number(input.lat)];
  }
  const s = String(input).trim();
  const pair = tryParseCommaPair(s);
  if (pair) return pair; // already lon,lat (or fixed)
  // Geocode free-form text
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
async function buildStitchedRoute(start, end, vias, tracks){
  const selected = selectTracksAlongAxis(tracks, start, end, {max:6, maxAxisKm:8});
  const anchors = [start, ...vias, ...selected.map(s=>s.coords[0]), end];
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
  const all=[];
  for (const s of merged){ if (all.length) all.pop(); all.push(...s.coords); }
  const evidence = selected.map(s=>({type:'OSM_track', ref:s.id, km:+s.len.toFixed(2)}));
  return { coords: all, evidence };
}

/* ========= API ========= */

app.post('/plan', async (req, res) => {
  try {
    const { start, end, vias = [], region_hint_bbox, strategy = 'stitch' } = req.body;

    if (!start || !end) return res.status(400).json({ error: 'start and end are required (address/place or lon,lat)' });

    // Geocode/parse inputs
    const a = await parsePointOrGeocode(start);
    const b = await parsePointOrGeocode(end);
    const viaPts = [];
    for (const v of vias) viaPts.push(await parsePointOrGeocode(v));

    // BBox: use provided or derive
    const bbox = Array.isArray(region_hint_bbox) && region_hint_bbox.length===4
      ? region_hint_bbox.map(Number)
      : autoBBoxFromPoints(a, b, 25);

    // Overpass discovery (evidence + stitch input)
    const tracks = await overpassTracks(bbox).catch(() => []);

    let coords, note; const evidence = [{ type:'GH_mode', ref:'CH' }];

    if (strategy === 'stitch') {
      const built = await buildStitchedRoute(a, b, viaPts, tracks);
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

    res.json({
      routes: [{
        id: routeId,
        name: strategy === 'stitch' ? 'ADV Option (Stitched)' : 'ADV Option (CH)',
        summary: note,
        stats: { distance_km: +polylineLenKm(coords).toFixed(1), duration_h: null, ascent_m: null },
        gpx_url: gpxUrl,
        geojson_url: geojsonUrl,
        preview_url: null,
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

app.post('/refine', async (req, res) => { req.url = '/plan'; app._router.handle(req, res, () => {}); });
app.get('/health', (_, res) => res.json({ ok: true }));
app.listen(process.env.PORT || 8080, () => console.log(`ADV backend on :${process.env.PORT || 8080}`));
