export function toRad(deg) {
  return deg * Math.PI / 180;
}

export function distKm([lon1, lat1], [lon2, lat2]) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function bboxAreaKm2([south, west, north, east]) {
  const midLat = (south + north) / 2;
  const width = distKm([west, midLat], [east, midLat]);
  const height = distKm([(west+east)/2, south], [(west+east)/2, north]);
  return width * height;
}

export function corridorBBox(a, b, {
  PAD_KM_MIN = 8,
  PAD_KM_MAX = 25,
  BBOX_AREA_MAX_KM2 = 2500
} = {}) {
  const D = distKm(a, b);
  let padKm = Math.max(PAD_KM_MIN, Math.min(PAD_KM_MAX, Math.max(8, D * 0.25)));

  const minLat = Math.min(a[1], b[1]);
  const maxLat = Math.max(a[1], b[1]);
  const minLon = Math.min(a[0], b[0]);
  const maxLon = Math.max(a[0], b[0]);
  const latPad = padKm / 111;
  const midLat = (a[1] + b[1]) / 2;
  const lonPad = padKm / (111 * Math.cos(toRad(midLat)) || 1);
  let bbox = [minLat - latPad, minLon - lonPad, maxLat + latPad, maxLon + lonPad];
  let areaKm2 = bboxAreaKm2(bbox);
  let shrunk = false;
  if (areaKm2 > BBOX_AREA_MAX_KM2) {
    const scale = Math.sqrt(BBOX_AREA_MAX_KM2 / areaKm2);
    padKm *= scale;
    const latPad2 = padKm / 111;
    const lonPad2 = padKm / (111 * Math.cos(toRad(midLat)) || 1);
    bbox = [minLat - latPad2, minLon - lonPad2, maxLat + latPad2, maxLon + lonPad2];
    areaKm2 = bboxAreaKm2(bbox);
    shrunk = true;
  }
  return { bbox, padKm, areaKm2, shrunk, D };
}
