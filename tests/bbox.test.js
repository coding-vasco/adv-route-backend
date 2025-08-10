diff --git a//dev/null b/tests/bbox.test.js
index 0000000000000000000000000000000000000000..ca89d544a98b66325e8a101f7d32ba9776950951 100644
--- a//dev/null
+++ b/tests/bbox.test.js
@@ -0,0 +1,20 @@
+import { describe, it, expect } from 'vitest';
+import { corridorBBox, bboxAreaKm2 } from '../src/lib/bbox.js';
+
+describe('corridorBBox', () => {
+  it('clamps pad and area', () => {
+    const start = [0,0];
+    const end = [1,1];
+    const { padKm, areaKm2 } = corridorBBox(start, end, { PAD_KM_MIN:8, PAD_KM_MAX:25, BBOX_AREA_MAX_KM2:2500 });
+    expect(padKm).toBeGreaterThanOrEqual(8);
+    expect(areaKm2).toBeLessThanOrEqual(2500);
+  });
+
+  it('shrinks large bbox when area exceeds limit', () => {
+    const start = [0,0];
+    const end = [10,0];
+    const { areaKm2, shrunk } = corridorBBox(start, end, { PAD_KM_MIN:8, PAD_KM_MAX:25, BBOX_AREA_MAX_KM2:1000 });
+    expect(shrunk).toBe(true);
+    expect(areaKm2).toBeLessThanOrEqual(1000);
+  });
+});
