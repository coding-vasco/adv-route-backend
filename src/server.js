import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import { customAlphabet } from 'nanoid';

const app = express();
app.use(express.json({ limit: '2mb' }));

/* ========= ENV & VALIDATION ========= */

const need = (k) => {
  if (!process.env[k] || String(process.env[k]).trim() === '') {
    console.error(`[ENV] Missing ${k}`);
    process.exit(1);
  }
};

need('GH_KEY');
need('OVERPASS_URL');
need('STORAGE');
need('PUBLIC_BASE_URL');
if (process.env.STORAGE !== 'SUPABASE') {
  console.error('[ENV] STORAGE must be SUPABASE for this build');
  process.exit(1);
}
need('SUPABASE_URL');
need('SUPABASE_SERVICE_ROLE');
need('SUPABASE_BUCKET');

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
  if (typeof p === 'string') {
    const [lon, lat] = p.split(',').map(Number);
    return [lon, lat];
  }
  if (Array.isArray(p)) return [Number(p[0]), Number(p[1])];
  if (p && typeof p === 'object' && 'lon' in p && 'lat' in p) return [Number(p.lon), Number(p.lat)];
  throw new Error(`Bad point format: ${JSON.stringify(p)}`);
};

const buildCustomModel = (prefs = {}) => {
  const mustUseAreas = prefs.must_use_areas || []; // GeoJSON Features with "id"
  return {
    distance_influence: 8,
    priority: [
      { if: 'road_environment == FERRY', multiply_by: '0.01' },
      { if: 'road_class == MOTORWAY || road_class == TRUNK', multiply_by: '0.2' },
      { if: 'road_class == PRIMARY', multiply_by: '0.5' },
      { if: 'surface == ASPHALT || surface == PAVED', multiply_by: '0.9' },
      { if: 'surface == SAND', multiply_by: '0.25' },
      { if: 'track_type == GRADE4 || track_type == GRADE5', multiply_by: '0.7' },
      { if: 'road_class == PATH || road_class == FOOTWAY || road_class == PEDESTRIAN || road_class == STEPS', multiply_by: '0.01' },
      ...mustUseAreas.map((f) => ({
        if: `in_${f.id} && (road_class == MOTORWAY || road_class == TRUNK)`,
        multiply_by: '1'
      }))
    ],
    speed: [
      { if: 'road_class == TRACK', limit_to: '45' },
      { if: 'track_type == GRADE4 || track_type == GRADE5', limit_to: '35' }
    ],
    areas: { type: 'FeatureCollection', features: mustUseAreas }
  };
};

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

const ghRoute = async (points, custom_model) => {
  const body = {
    profile: 'car',
    points: points.map(([lon, lat]) => [lon, lat]),
    points_encoded: false,
    instructions: false,
    locale: 'en',
    details: ['surface', 'road_class'],
    'ch.disable': true,
    custom_model
  };
  const url = `https://graphhopper.com/api/1/route?key=${GH_KEY}`;
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`GraphHopper error: ${await r.text()}`);
  return r.json();
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

/* ========= API ========= */

app.post('/plan', async (req, res) => {
  try {
    const {
      start, end, vias = [],
      region_hint_bbox,
      must_use_areas = [],
      prefs = {}
    } = req.body;

    const pts = [parsePoint(start), ...vias.map(parsePoint), parsePoint(end)];
    const custom = buildCustomModel({ must_use_areas, ...prefs });

    const tracks = await overpassTracks(region_hint_bbox).catch(() => []);

    const gh = await ghRoute(pts, custom);
    const path = gh.paths?.[0];
    if (!path) throw new Error('No route found');

    const coords = path.points.coordinates.map((c) => [c[0], c[1]]);
    const routeId = nanoid();

    const gpx = toGPX('ADV Route', coords);
    const gpxUrl = await uploadToSupabase(`routes/${routeId}.gpx`, Buffer.from(gpx), 'application/gpx+xml');
    const geojsonBlob = Buffer.from(JSON.stringify({ type: 'Feature', geometry: path.points, properties: { name: 'ADV Route' } }));
    const geojsonUrl = await uploadToSupabase(`routes/${routeId}.geojson`, geojsonBlob, 'application/geo+json');

    res.json({
      routes: [{
        id: routeId,
        name: 'ADV Option 1',
        summary: 'Backroads-biased',
        stats: {
          distance_km: +(path.distance / 1000).toFixed(1),
          duration_h: +(path.time / 3600000).toFixed(2),
          ascent_m: path.ascend ?? null
        },
        surface_mix: path.details?.surface ?? null,
        road_class_mix: path.details?.road_class ?? null,
        gpx_url: gpxUrl,
        geojson_url: geojsonUrl,
        preview_url: null,
        custom_model_used: custom,
        via_points_used: pts
      }],
      evidence: [
        ...(tracks.slice(0, 5).map(t => ({ type: 'OSM_track', ref: t.id }))),
        { type: 'GH_ok', ref: 'paths[0]' }
      ]
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

app.post('/refine', async (req, res) => {
  req.url = '/plan';
  app._router.handle(req, res, () => {});
});

app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(process.env.PORT || 8080, () => {
  console.log(`ADV backend on :${process.env.PORT || 8080}`);
});
