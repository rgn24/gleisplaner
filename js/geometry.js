/* Gleisknoten-Planer – Geometrie-Helfer (DOM-frei, auch unter Node nutzbar) */
(function (root) {
  'use strict';

  const v = (x, y) => ({ x, y });
  const add = (a, b) => v(a.x + b.x, a.y + b.y);
  const sub = (a, b) => v(a.x - b.x, a.y - b.y);
  const mul = (a, s) => v(a.x * s, a.y * s);
  const dot = (a, b) => a.x * b.x + a.y * b.y;
  const cross = (a, b) => a.x * b.y - a.y * b.x;
  const len = (a) => Math.hypot(a.x, a.y);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const norm = (a) => { const l = len(a); return l > 1e-9 ? v(a.x / l, a.y / l) : v(1, 0); };
  const lerp = (a, b, t) => v(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  // Bildschirmkoordinaten (y nach unten): in Blickrichtung u liegt rechts bei (-u.y, u.x)
  const right = (u) => v(-u.y, u.x);
  const toDeg = (r) => r * 180 / Math.PI;
  const toRad = (d) => d * Math.PI / 180;
  const fromAngle = (a) => v(Math.cos(a), Math.sin(a));
  const angleOf = (a) => Math.atan2(a.y, a.x);
  const TAU = Math.PI * 2;
  const wrap = (a) => { a %= TAU; return a < 0 ? a + TAU : a; };

  function bezier(p0, p1, p2, p3, n) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, s = 1 - t;
      const a = s * s * s, b = 3 * s * s * t, c = 3 * s * t * t, d = t * t * t;
      pts.push(v(a * p0.x + b * p1.x + c * p2.x + d * p3.x, a * p0.y + b * p1.y + c * p2.y + d * p3.y));
    }
    return pts;
  }

  function line(a, b, step) {
    const n = Math.max(1, Math.ceil(dist(a, b) / (step || 1e9)));
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push(lerp(a, b, i / n));
    return pts;
  }

  // Geodäte der Poincaré-Kreisscheibe (Mittelpunkt o, Radius r) zwischen den Randwinkeln a1 und a2.
  // Zwei solche Bögen schneiden sich genau dann – und dann genau einmal –, wenn ihre Endpunkte
  // auf dem Rand verschränkt liegen. Damit entstehen nur die Kreuzungen, die topologisch nötig sind.
  function geodesic(o, r, a1, a2, step) {
    const A = fromAngle(a1), B = fromAngle(a2);
    const P = add(o, mul(A, r)), Q = add(o, mul(B, r));
    const k = 1 + dot(A, B);
    if (k < 1e-4) return line(P, Q, step);
    const c = mul(add(A, B), 1 / k);                 // Mittelpunkt des Orthogonalkreises
    const rc = Math.sqrt(Math.max(dot(c, c) - 1, 0));
    if (rc > 1e4) return line(P, Q, step);
    const t0 = angleOf(sub(A, c));
    let d = angleOf(sub(B, c)) - t0;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    const n = Math.max(8, Math.ceil(Math.abs(d) * rc * r / step));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const q = add(c, mul(fromAngle(t0 + d * i / n), rc));
      pts.push(add(o, mul(q, r)));
    }
    pts[0] = P; pts[n] = Q;
    return pts;
  }

  // Polylinien aneinanderhängen, doppelte Stoßpunkte entfernen
  function concat(...parts) {
    const out = [];
    for (const part of parts) {
      if (!part || !part.length) continue;
      for (const p of part) {
        const last = out[out.length - 1];
        if (!last || dist(last, p) > 1e-6) out.push(p);
      }
    }
    return out;
  }

  function cumulative(pts) {
    const c = [0];
    for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + dist(pts[i - 1], pts[i]));
    return c;
  }

  // Punkt + Tangente bei Bogenlänge s
  function pointAt(pts, cum, s) {
    const total = cum[cum.length - 1];
    s = Math.max(0, Math.min(total, s));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const seg = cum[i] - cum[i - 1] || 1;
    const t = (s - cum[i - 1]) / seg;
    return { p: lerp(pts[i - 1], pts[i], t), t: norm(sub(pts[i], pts[i - 1])) };
  }

  // Teilstück zwischen den Bogenlängen s0 und s1
  function slice(pts, cum, s0, s1) {
    const total = cum[cum.length - 1];
    s0 = Math.max(0, s0); s1 = Math.min(total, s1);
    if (s1 <= s0) return [];
    const out = [pointAt(pts, cum, s0).p];
    for (let i = 0; i < pts.length; i++) if (cum[i] > s0 && cum[i] < s1) out.push(pts[i]);
    out.push(pointAt(pts, cum, s1).p);
    return out;
  }

  function bbox(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    }
    return { x0, y0, x1, y1 };
  }
  const boxesOverlap = (a, b, pad = 0) =>
    a.x0 - pad <= b.x1 && b.x0 - pad <= a.x1 && a.y0 - pad <= b.y1 && b.y0 - pad <= a.y1;

  function segX(a, b, c, d) {
    const r = sub(b, a), s = sub(d, c);
    const den = cross(r, s);
    if (Math.abs(den) < 1e-12) return null;
    const q = sub(c, a);
    const t = cross(q, s) / den, u = cross(q, r) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { t, u, p: add(a, mul(r, t)) };
  }

  // Alle Schnittpunkte zweier Polylinien (mit Bogenlängen auf beiden Linien)
  function intersections(A, cA, B, cB) {
    const hits = [];
    if (!boxesOverlap(bbox(A), bbox(B), 1)) return hits;
    for (let i = 1; i < A.length; i++) {
      const a0 = A[i - 1], a1 = A[i];
      const ax0 = Math.min(a0.x, a1.x), ax1 = Math.max(a0.x, a1.x);
      const ay0 = Math.min(a0.y, a1.y), ay1 = Math.max(a0.y, a1.y);
      for (let j = 1; j < B.length; j++) {
        const b0 = B[j - 1], b1 = B[j];
        if (Math.max(b0.x, b1.x) < ax0 || Math.min(b0.x, b1.x) > ax1 ||
            Math.max(b0.y, b1.y) < ay0 || Math.min(b0.y, b1.y) > ay1) continue;
        const h = segX(a0, a1, b0, b1);
        if (!h) continue;
        if (hits.some(o => dist(o.p, h.p) < 1)) continue; // Treffer genau auf Stützpunkten nur einmal
        hits.push({
          p: h.p,
          sA: cA[i - 1] + (cA[i] - cA[i - 1]) * h.t,
          sB: cB[j - 1] + (cB[j] - cB[j - 1]) * h.u,
        });
      }
    }
    return hits;
  }

  const api = {
    v, add, sub, mul, dot, cross, len, dist, norm, lerp, right, toDeg, toRad, fromAngle, angleOf, wrap, TAU,
    bezier, line, geodesic, concat, cumulative, pointAt, slice, bbox, boxesOverlap, segX, intersections,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.GP = root.GP || {};
  root.GP.geo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
