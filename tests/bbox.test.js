import { describe, it, expect } from 'vitest';
import { corridorBBox, bboxAreaKm2 } from '../src/lib/bbox.js';

describe('corridorBBox', () => {
  it('clamps pad and area', () => {
    const start = [0,0];
    const end = [0.05,0.05];
    const { padKm, areaKm2 } = corridorBBox(start, end, { PAD_KM_MIN:8, PAD_KM_MAX:25, BBOX_AREA_MAX_KM2:2500 });
    expect(padKm).toBeGreaterThanOrEqual(8);
    expect(areaKm2).toBeLessThanOrEqual(2500);
  });

  it('shrinks large bbox when area exceeds limit', () => {
    const start = [0,0];
    const end = [10,0];
    const { padKm, shrunk } = corridorBBox(start, end, { PAD_KM_MIN:8, PAD_KM_MAX:25, BBOX_AREA_MAX_KM2:1000 });
    expect(shrunk).toBe(true);
    expect(padKm).toBeLessThan(8); // pad reduced below minimum
  });
});
