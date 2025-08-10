# ADV Route Backend

Express backend for ADV route planner. Provides `/plan` endpoint that calls GraphHopper and Overpass to generate GPX/GeoJSON files stored in Supabase.

## Setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and fill in required keys.
3. Run the server: `npm start`

## Corridor clamps

`/plan` requests automatically compute a corridor bounding box between start and end points. Padding is derived from straight line distance and clamped by:

- `PAD_KM_MIN` / `PAD_KM_MAX`
- `BBOX_AREA_MAX_KM2`

If a client supplies a larger `region_hint_bbox`, it is automatically reduced to stay within limits and logged.

## Testing

Run unit tests with:

```bash
npm test

​:codex-terminal-citation[codex-terminal-citation]{line_range_start=1 line_range_end=26 terminal_chunk_id=2ed1ff}​

---

### `package.json`
```json
{
  "name": "adv-route-backend",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "start": "node src/server.js",
    "dev": "node --watch src/server.js",
    "test": "vitest"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.4",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "nanoid": "^5.0.7",
    "node-fetch": "^3.3.2",
    "pino": "^9.1.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "vitest": "^1.6.0"
  },
  "engines": {
    "node": ">=20"
  }
}
