// Adds optional custom model flags and surface prefs to plan schema.
import { z } from 'zod';

const coord = z.union([
  z.array(z.number()).length(2),
  z.string(),
  z.object({ lon: z.number(), lat: z.number() })
]);

const surfacePreferEnum = z.enum(['asphalt','compacted','gravel','dirt','ground','fine_gravel','sand']);
const surfaceEnum = z.enum(['asphalt','compacted','gravel','dirt','ground','fine_gravel','sand','mud']);

export const planSchema = z.object({
  start: coord,
  end: coord,
  vias: z.array(coord).optional(),
  distance_km_target: z.number().positive().optional(),
  time_budget_h: z.number().positive().optional(),
  region_hint_bbox: z.array(z.number()).length(4).optional(),
  strategy: z.enum(['ch','stitch']).optional(),
  use_custom_model: z.boolean().optional(),
  avoid_motorways: z.boolean().optional(),
  avoid_tolls: z.boolean().optional(),
  prefer_surfaces: z.array(surfacePreferEnum).optional(),
  avoid_surfaces: z.array(surfaceEnum).optional()
});

export function validatePlan(body) {
  return planSchema.parse(body);
}
