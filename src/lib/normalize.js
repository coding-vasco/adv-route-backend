import { z } from 'zod';

const coord = z.union([
  z.array(z.number()).length(2),
  z.string(),
  z.object({ lon: z.number(), lat: z.number() })
]);

export const planSchema = z.object({
  start: coord,
  end: coord,
  vias: z.array(coord).optional(),
  distance_km_target: z.number().positive().optional(),
  time_budget_h: z.number().positive().optional(),
  region_hint_bbox: z.array(z.number()).length(4).optional(),
  strategy: z.enum(['ch','stitch']).optional()
});

export function validatePlan(body) {
  return planSchema.parse(body);
}
