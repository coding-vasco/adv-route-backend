// src/server.js — GraphHopper CH-only (free plan) + STITCH mode, Supabase uploads

import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import { customAlphabet } from 'nanoid';

const app = express();
app.use(express.json({ limit: '2mb' }));

/* ========= ENV & CLIENTS ========= */

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
need('PUBLIC_BASE_URL', false); // optional for now

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

/* ========= HELPERS ========= */

const parsePoint = (p) => {
  if (typeof p === 'string') { const [lon, lat] = p.split(',').map(Number); return [lon, lat]; }
  if (Array.isArray(p)) return [Number(p[0]), Number(p[1])];
  if (p && typeof p === 'object' && 'lon' in p && 'lat' in p) return [Number(p.lon), Number(p.lat)];
  throw new Error(`Bad point format: ${JSON.stringify(p)}`);
};

// Overpass candidate tracks (gravelish, grade 1–3)
const overpassTracks = async (bbox /* [south,west,north,east] */) => {
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
    id: w.id,
    coords: (w.geometry || []).map((g) => [g.lon, g.lat])
  }));
};

// CH-only routing (free plan): no custom_model, no "ch.disable"
const ghRouteCH = async (points, profile = 'car') => {
  const body = {
    profile,
    points: points.map(([lon, lat]) => [lon, lat]),
    points_encoded: false,
    instructions: false,
    locale: 'en'
  };
  const url = `https://graphhopper.com/api/1/route?key=${GH_KEY}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
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
  const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(path, buffer, {
    contentType,
    upsert: true
  });
  if (error) throw error;

  if (SUPABASE_PUBLIC_BUCKET) {
    const { data: pub } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(path);
    return pub.publicUrl;
  } else {
    const { data: signed, error: signErr } = await supabase
      .storage.from(SUPABASE_BUCKET)
      .createSignedUrl(path, 60 * 60 * 24 * 7);
    if (signErr) throw signErr;
    return signed.signedUrl;
  }
};

/* ====== small geo utils for STITCH mode ====== */
const toRad = (deg) => deg * Math.PI / 180;
const distKm = ([lon1,lat1],[lon2,lat2]) => {
  const R=6371, dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
};
const lerp = (a,b,t)=>[a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t];
const project01 = (p,a,b)=>{ // scalar t along AB where P projects (approx, planar)
  const ax=a[0], ay=a[1], bx=b[0], by=b[1], px=p[0], py=p[1];
  const vx=bx-ax, vy=by-ay, wx=px-ax, wy=py-ay;
  const vv=vx*vx+vy*vy || 1e-9; const t=(vx*wx+vy*wy)/vv; return Math.max(0,Math.min(1,t));
};
const polylineLenKm = (coords)=> coords.reduce((s,c,i)=> i? s+distKm(coords[i-1],c):0,0);

// choose up to N track ways near start→end axis and spaced out
function selectTracksAlongAxis(tracks, start, end, {max=6, maxAxisKm=8}) {
  const scored = tracks.map(w=>{
    const coords = w.coords;
    if (!coords?.length) return null;
    const mid = coords[Math.floor(coords.length/2)];
    const t = project01(mid, start, end);
    const ptOnAxis = lerp(start,end,t);
    const off = distKm(mid, ptOnAxis);
    return { id:w.id, coords, t, off, len: polylineLenKm(coords) };
  }).filter(Boolean)
    .filter(x => x.off <= maxAxisKm)
    .sort((a,b)=> a.t-b.t);

  const out=[]; const minGap = 0.1; // ~10% axis spacing
  for (const cand of scored.sort((a,b)=> b.len-a.len)) {
    if (out.find(o => Math.abs(o.t - cand.t) < minGap)) continue;
    out.push(cand);
    if (out.length>=max) break;
  }
  return out.sort((a,b)=> a.t-b.t);
}

// Build stitched route: CH connectors + selected OSM track polylines
async function buildStitchedRoute(start, end, vias, tracks, ghRouteCH){
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

  // interleave track lines when a connector lands near a selected track start
  const merged = [];
  let selIdx = 0;
  for (const seg of segments){
    merged.push(seg);
    const track = selected[selIdx];
    const endPt = seg.coords[seg.coords.length-1];
    if (track && distKm(endPt, track.coords[0]) < 0.15) { // ~150m snap tolerance
      merged.push({type:'track', id:track.id, coords: track.coords});
      selIdx++;
    }
  }

  // flatten segments to one polyline
  const allCoords = [];
  for (const s of merged){
    if (allCoords.length) allCoords.pop();
    allCoords.push(...s.coords);
  }

  const evidence = selected.map(s=>({type:'OSM_track', ref:String(s.id), km:+s.len.toFixed(2)}));
  return { coords: allCoords, evidence, selected };
}

/* ========= API ========= */

app.post('/plan', async (req, res) => {
  try {
    const {
      start, end, vias = [],
      region_hint_bbox,
      strategy = 'ch'   // "ch" (default) or "stitch"
    } = req.body;

    const a = parsePoint(start);
    const b = parsePoint(end);
    const viaPts = vias.map(parsePoint);

    // fetch candidate tracks (evidence + stitch inputs)
    const tracks = await overpassTracks(region_hint_bbox).catch(() => []);

    let coords, note, evidence = [{type:'GH_mode', ref:'CH'}];

    if (strategy === 'stitch') {
      const built = await buildStitchedRoute(a, b, viaPts, tracks, ghRouteCH);
      coords = built.coords;
      evidence = evidence.concat(built.evidence);
      note = 'STITCH mode: CH connectors + OSM tracks (no Custom Model).';
    } else {
      const gh = await ghRouteCH([a, ...viaPts, b], 'car');
      coords = gh.paths[0].points.coordinates.map(c=>[c[0],c[1]]);
      note = 'CH mode: standard routing (free plan).';
    }

    // files
    const routeId = nanoid();
    const gpx = toGPX('ADV Route', coords);
    const gpxUrl = await uploadToSupabase(`routes/${routeId}.gpx`, Buffer.from(gpx), 'application/gpx+xml');
    const geojsonBlob = Buffer.from(JSON.stringify({
      type: 'Feature', properties: { name: 'ADV Route' },
      geometry: { type:'LineString', coordinates: coords }
    }));
    const geojsonUrl = await uploadToSupabase(`routes/${routeId}.geojson`, geojsonBlob, 'application/geo+json');

    // simple stats (distance only)
    const distance_km = +polylineLenKm(coords).toFixed(1);

    res.json({
      routes: [{
        id: routeId,
        name: strategy === 'stitch' ? 'ADV Option (Stitched)' : 'ADV Option (CH)',
        summary: note,
        stats: { distance_km, duration_h: null, ascent_m: null },
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

app.post('/refine', async (req, res) => {
  // With CH-only, "refine" just re-plans using new points/strategy.
  req.url = '/plan';
  app._router.handle(req, res, () => {});
});

app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(process.env.PORT || 8080, () => {
  console.log(`ADV backend (CH + STITCH) on :${process.env.PORT || 8080}`);
});
