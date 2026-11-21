// Pure geometry helpers on 2D pose landmarks ({x, y} in normalized image coords, y grows downward).

const RAD2DEG = 180 / Math.PI;

/** Angle ABC in degrees (vertex at B), in [0, 180]. Returns NaN if a segment is degenerate. */
export function jointAngle(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const n1 = Math.hypot(v1x, v1y), n2 = Math.hypot(v2x, v2y);
  if (n1 < 1e-9 || n2 < 1e-9) return NaN;
  let cos = (v1x * v2x + v1y * v2y) / (n1 * n2);
  cos = Math.max(-1, Math.min(1, cos));
  return Math.acos(cos) * RAD2DEG;
}

/** Inclination of segment from `bottom` to `top` relative to the vertical, in degrees [0, 180]. */
export function tiltFromVertical(top, bottom) {
  const dx = top.x - bottom.x, dy = bottom.y - top.y; // dy > 0 when top is above bottom
  if (Math.hypot(dx, dy) < 1e-9) return NaN;
  return Math.abs(Math.atan2(dx, dy)) * RAD2DEG;
}

export function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, visibility: Math.min(vis(a), vis(b)) };
}

export function vis(p) {
  return p && typeof p.visibility === 'number' ? p.visibility : 1;
}

/** Minimum visibility over a set of landmarks. */
export function minVisibility(points) {
  let m = 1;
  for (const p of points) {
    if (!p) return 0;
    m = Math.min(m, vis(p));
  }
  return m;
}
