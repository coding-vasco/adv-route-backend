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
```
