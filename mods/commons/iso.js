// Pure isometric geometry: tiles to pixels, boxes to faces, colors to shades.
// A tile is 2u wide and u tall on screen; one unit of height is u/2 tall.

// Where a tile corner (x, y) at height z lands, from an origin.
export const project = (x, y, z, u, ox, oy) => [ox + (x - y) * u, oy + (x + y) * (u / 2) - z * (u / 2)];

// The three visible faces of a box standing on tile (x, y), w by d tiles, h units tall:
// top, left (its y+d side), right (its x+w side), each a closed polygon in pixels.
export function box(x, y, w, d, h, u, ox, oy) {
  const p = (px, py, z) => project(px, py, z, u, ox, oy);
  const a = p(x, y, h), b = p(x + w, y, h), c = p(x + w, y + d, h), e = p(x, y + d, h);
  const c0 = p(x + w, y + d, 0), e0 = p(x, y + d, 0), b0 = p(x + w, y, 0);
  return { top: [a, b, c, e], left: [e, c, c0, e0], right: [c, b, b0, c0] };
}

// A tent on tile (x, y), w by d, apex h units up: its two visible triangular faces.
export function tent(x, y, w, d, h, u, ox, oy) {
  const p = (px, py, z) => project(px, py, z, u, ox, oy);
  const apex = p(x + w / 2, y + d / 2, h);
  const c0 = p(x + w, y + d, 0), e0 = p(x, y + d, 0), b0 = p(x + w, y, 0);
  return { left: [apex, e0, c0], right: [apex, c0, b0] };
}

// A flat diamond covering tiles [x, x+w) × [y, y+d).
export const slab = (x, y, w, d, u, ox, oy) => [project(x, y, 0, u, ox, oy), project(x + w, y, 0, u, ox, oy), project(x + w, y + d, 0, u, ox, oy), project(x, y + d, 0, u, ox, oy)];

// A puffy cloud polygon around a pixel center, r wide: an ellipse of n points.
export function blob(cx, cy, rx, ry, n = 14) {
  const points = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    const wobble = 1 + 0.12 * Math.sin(a * 3);
    points.push([cx + rx * wobble * Math.cos(a), cy + ry * wobble * Math.sin(a)]);
  }
  return points;
}

// The pixel rectangle a box occupies on screen (for a hit target over it).
export function bounds(polys) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of polys) for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// The tile unit that fits a gx by gy grid, hmax units tall, into width × height with a margin.
export function fit(gx, gy, hmax, width, height, margin = 8) {
  const byWidth = (width - 2 * margin) / (gx + gy);
  const byHeight = (height - 2 * margin) / ((gx + gy) / 2 + hmax / 2);
  return Math.max(2, Math.min(byWidth, byHeight));
}

// Where the grid's (0,0) corner sits so the whole map is centered.
export function origin(gx, gy, hmax, u, width, height) {
  const mapW = (gx + gy) * u, mapH = ((gx + gy) / 2 + hmax / 2) * u;
  return [(width - mapW) / 2 + gy * u, (height - mapH) / 2 + (hmax / 2) * u];
}

// ── color ───────────────────────────────────────────────────────────────────

const hex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
export function rgb(color) {
  const s = String(color ?? "").replace("#", "");
  const full = s.length === 3 ? s.split("").map((c) => c + c).join("") : s.slice(0, 6);
  const n = parseInt(full.padEnd(6, "0"), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
// Toward white (amount > 0) or black (amount < 0), amount in -1..1.
export function shade(color, amount) {
  const [r, g, b] = rgb(color);
  const to = amount > 0 ? 255 : 0, k = Math.abs(amount);
  return `#${hex(r + (to - r) * k)}${hex(g + (to - g) * k)}${hex(b + (to - b) * k)}`;
}
export const mix = (a, b, k) => {
  const [r1, g1, b1] = rgb(a), [r2, g2, b2] = rgb(b);
  return `#${hex(r1 + (r2 - r1) * k)}${hex(g1 + (g2 - g1) * k)}${hex(b1 + (b2 - b1) * k)}`;
};
// The three shades of a box: lit roof, plain left wall, shadowed right wall.
export const faces = (color) => ({ top: shade(color, 0.28), left: color, right: shade(color, -0.3) });
