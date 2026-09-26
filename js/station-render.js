/* Bahnhofsplaner – SVG-Ausgabe (gleiche Optik und Pfeil-Animation wie der Knotenplaner) */
(function (root) {
  'use strict';
  const G = root.GP.geo;
  const U = root.GP.render.util;
  const ST = root.GP.station;
  const { el, f, pt, d, halo } = U;

  function render(svg, S, model, ui) {
    const T = U.theme();
    const L = model.settings.layers;
    const exporting = !!ui.exporting;
    const C = S.C;
    svg.textContent = '';
    if (!exporting) U.resetFlows(svg);
    svg.setAttribute('font-family', T.font);
    const defs = el(svg, 'defs', {});
    const pat = el(defs, 'pattern', { id: 'gp-grid', width: 20, height: 20, patternUnits: 'userSpaceOnUse' });
    for (const [cx, cy] of [[0, 0], [20, 0], [0, 20], [20, 20]]) el(pat, 'circle', { cx, cy, r: 1.15, fill: T.dot });
    const vb = ui.viewBox;
    const bg = { x: f(vb.x - 400), y: f(vb.y - 400), width: f(vb.w + 800), height: f(vb.h + 800), 'data-bg': 1 };
    el(svg, 'rect', Object.assign({ fill: T.bg }, bg));
    el(svg, 'rect', Object.assign({ fill: 'url(#gp-grid)' }, bg));

    const gBase = el(svg, 'g', {});
    const gTrack = el(svg, 'g', {});
    const gMarks = el(svg, 'g', {});
    const gSig = el(svg, 'g', {});
    const gLabels = el(svg, 'g', { 'pointer-events': 'none' });
    el(svg, 'g', { id: 'gp-hl', 'pointer-events': 'none' });

    // Bahnsteige: Bänder in der Farbe der Zugart
    for (const r of S.rows) {
      const col = ST.TYPE_COLOR[r.type];
      el(gBase, 'rect', { x: 0, y: f(r.y - 9), width: C.PL, height: 18, rx: 5, fill: col, opacity: 0.13, 'data-ref': `row:${r.id}`, class: exporting ? null : 'rowband' });
    }
    if (S.rows.length && L.labels) {
      const yTop = S.rows[0].y - 24;
      el(gLabels, 'text', halo({ x: C.PL / 2, y: f(yTop), 'text-anchor': 'middle', 'font-size': 15, 'font-weight': 750, fill: T.ink }, T), model.name);
    }

    if (L.tracks) {
      for (const pth of S.paths) {
        const col = pth.color || T.track;
        const w = pth.kind === 'row' ? 3.4 : 3;
        el(gTrack, 'path', { d: d(pth.pts), fill: 'none', stroke: col, 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
          opacity: pth.unused ? 0.35 : 1, 'data-ref': pth.ref || null });
        if (pth.dir !== 'none' && !pth.unused) {
          U.flow(svg, gTrack, pth.pts, G.cumulative(pth.pts), T.bg, pth.kind === 'row' ? 90 : 46, pth.dir === 'both' ? 'bidi' : 'oneway', exporting);
        }
      }
      for (const c of S.crossovers) for (const sg of c.segs) {
        el(gTrack, 'path', { d: d(sg), fill: 'none', stroke: T.track, 'stroke-width': 2.4, 'stroke-linecap': 'round' });
      }
      // Prellböcke
      for (const b of S.buffers) {
        const n = G.right(b.dir);
        const a1 = G.add(b.p, G.mul(n, 7)), a2 = G.sub(b.p, G.mul(n, 7));
        el(gTrack, 'path', { d: `M${pt(a1)}L${pt(a2)}`, stroke: T.ink, 'stroke-width': 3, 'stroke-linecap': 'round' });
      }
      // Weichen
      for (const w of S.switches) {
        const r = w.kind === 'crossover' ? 5 : 3.8;
        el(gMarks, 'circle', { cx: f(w.p.x), cy: f(w.p.y), r, fill: T.bg, stroke: T.ink, 'stroke-width': 1.4, 'data-ref': w.label });
        if (L.labels) {
          const lp = G.add(w.p, G.v(0, w.kind === 'crossover' ? -14 : 12));
          el(gLabels, 'text', halo({ x: f(lp.x), y: f(lp.y), 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 9.5, fill: T.muted }, T), w.label);
        }
      }
      // Flachkreuzungen im Vorfeld
      for (const c of S.crossings) {
        const p = c.p;
        el(gMarks, 'path', { d: `M${f(p.x)} ${f(p.y - 6)}L${f(p.x + 6)} ${f(p.y)}L${f(p.x)} ${f(p.y + 6)}L${f(p.x - 6)} ${f(p.y)}Z`,
          fill: 'none', stroke: T.warn, 'stroke-width': 1.8, 'data-ref': c.label });
        if (L.labels) el(gLabels, 'text', halo({ x: f(p.x), y: f(p.y - 13), 'text-anchor': 'middle', 'font-size': 10, 'font-weight': 700, fill: T.warn }, T), c.label);
      }
    }

    // Signale
    if (L.signals && L.tracks) {
      for (const sg of S.signals) {
        const col = sg.kind === 'E' ? T.sigE : sg.kind === 'A' ? T.sigA : T.sigZ;
        const n = G.right(sg.dir), c = sg.p;
        const g = el(gSig, 'g', { 'data-ref': sg.label, class: exporting ? null : 'sig' });
        const hollow = !sg.oneWay;
        el(g, 'circle', { cx: f(c.x), cy: f(c.y), r: 6.4, fill: hollow ? T.panel : col, stroke: hollow ? col : T.bg, 'stroke-width': hollow ? 1.8 : 1.4 });
        const tip = G.add(c, G.mul(sg.dir, 4)), base = G.sub(c, G.mul(sg.dir, 3));
        el(g, 'path', { d: `M${pt(tip)}L${pt(G.add(base, G.mul(n, 3.3)))}L${pt(G.sub(base, G.mul(n, 3.3)))}Z`, fill: hollow ? col : T.bg });
        if (L.labels) {
          const lp = G.add(c, G.v(0, -12));
          el(gLabels, 'text', halo({ x: f(lp.x), y: f(lp.y), 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 10, 'font-weight': 700, fill: col }, T), sg.label);
        }
      }
    }

    // Beschriftung: Gleisnummern und Zugart an beiden Bahnsteigenden, Streckengleise außen
    if (L.labels) {
      for (const r of S.rows) {
        const col = ST.TYPE_COLOR[r.type];
        for (const x of [34, C.PL - 34]) {
          el(gLabels, 'text', halo({ x, y: f(r.y + 0.5), 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 10.5, 'font-weight': 750, fill: col }, T), String(r.no));
        }
        el(gLabels, 'text', halo({ x: C.PL / 2, y: f(r.y + 0.5), 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 9.5, fill: T.muted }, T),
          `Gleis ${r.no} · ${ST.TYPE_NAME[r.type]}`);
      }
      for (const X of ['left', 'right']) {
        const sd = S.sides[X];
        if (!sd.lines.length) continue;
        const shown = sd.single ? [{ name: sd.lines[0].name, type: sd.lines[0].type, y: S.yc }] : sd.lines;
        for (const l of shown) {
          const p = S.gp(X, { x: sd.xFar - 12, y: l.y });
          el(gLabels, 'text', halo({ x: f(p.x), y: f(p.y + 0.5), 'text-anchor': X === 'left' ? 'end' : 'start', 'dominant-baseline': 'central', 'font-size': 10, fill: T.muted }, T),
            `${l.name} ${ST.TYPE_SHORT[l.type]}`);
        }
        const head = S.gp(X, { x: sd.xFar + 30, y: Math.min(...sd.lines.map(l => l.y)) - 22 });
        el(gLabels, 'text', halo({ x: f(head.x), y: f(head.y), 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 700, fill: T.ink }, T),
          X === 'left' ? '← Strecke links' : 'Strecke rechts →');
      }
    }
  }

  function highlight(svg, S, refs) {
    const g = svg.querySelector('#gp-hl');
    if (!g) return;
    g.textContent = '';
    if (!refs || !S) return;
    const T = U.theme();
    const ring = (p, r) => el(g, 'circle', { cx: f(p.x), cy: f(p.y), r: r || 12, fill: 'none', stroke: T.accent, 'stroke-width': 2.6, class: 'pulse' });
    const glow = (pts) => el(g, 'path', { d: d(pts), fill: 'none', stroke: T.accent, 'stroke-width': 9, opacity: 0.45, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    for (const ref of String(refs).split(/\s+/).filter(Boolean)) {
      if (ref.startsWith('row:') || ref.startsWith('line:')) {
        for (const p of S.paths) if (p.ref === ref) glow(p.pts);
        continue;
      }
      const sg = S.signals.find(s => s.label === ref);
      if (sg) { ring(sg.p, 11); continue; }
      const w = S.switches.find(s => s.label === ref);
      if (w) { ring(w.p, w.kind === 'crossover' ? 16 : 10); continue; }
      const c = S.crossings.find(s => s.label === ref);
      if (c) ring(c.p, 10);
    }
  }

  // Umriss für Einpassen und Export
  function bounds(S) {
    const pts = [{ x: -40, y: -60 }, { x: S.C.PL + 40, y: (S.rows.length ? S.rows[S.rows.length - 1].y : 0) + 30 }];
    for (const p of S.paths) pts.push(...p.pts);
    for (const X of ['left', 'right']) {
      const sd = S.sides[X];
      if (sd.lines.length) pts.push(S.gp(X, { x: sd.xFar - 60, y: S.yc }));
    }
    return G.bbox(pts);
  }

  root.GP = root.GP || {};
  root.GP.stationRender = { render, highlight, bounds };
})(typeof globalThis !== 'undefined' ? globalThis : this);
