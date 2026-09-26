/* Gleisknoten-Planer – SVG-Ausgabe von Skizze und Gleisplan */
(function (root) {
  'use strict';
  const G = root.GP.geo;
  const C = root.GP.planner.C;
  const NS = 'http://www.w3.org/2000/svg';

  function el(parent, tag, attrs, text) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  const f = (n) => Math.round(n * 10) / 10;
  const pt = (p) => `${f(p.x)} ${f(p.y)}`;
  const d = (pts) => (pts.length ? 'M' + pts.map(pt).join('L') : '');

  function theme() {
    const cs = getComputedStyle(document.documentElement);
    const g = (n, fb) => (cs.getPropertyValue(n) || '').trim() || fb;
    return {
      bg: g('--bg', '#1f2124'), dot: g('--dot', '#3b3e43'), panel: g('--panel', '#2a2d31'), line: g('--line', '#43474d'),
      ink: g('--ink', '#ecebe6'), muted: g('--muted', '#a3a7ad'), track: g('--track', '#c9c7c0'), accent: g('--accent', '#f2c14e'),
      sigE: g('--sig-e', '#7bd88f'), sigA: g('--sig-a', '#7cc4f5'), sigZ: g('--sig-z', '#f2c14e'), warn: g('--warn', '#ff7a59'),
      font: g('--font', 'system-ui, sans-serif'),
    };
  }

  // Fahrtrichtungs-Pfeile entlang einer Polylinie
  function chevrons(parent, pts, cum, color, every) {
    const total = cum[cum.length - 1];
    if (total < 36) return;
    const n = Math.max(1, Math.floor((total - 24) / every));
    const step = total / (n + 1);
    let dd = '';
    for (let i = 1; i <= n; i++) {
      const { p, t } = G.pointAt(pts, cum, i * step);
      const nr = G.right(t);
      const tip = G.add(p, G.mul(t, 2.4));
      const back = G.sub(p, G.mul(t, 2.4));
      dd += `M${pt(G.add(back, G.mul(nr, 3)))}L${pt(tip)}L${pt(G.sub(back, G.mul(nr, 3)))}`;
    }
    el(parent, 'path', { d: dd, fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  }

  function offsetLine(pts, off) {
    return pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      return G.add(p, G.mul(G.right(G.norm(G.sub(b, a))), off));
    });
  }

  function halo(attrs, T) {
    return Object.assign({ stroke: T.bg, 'stroke-width': 3.2, 'paint-order': 'stroke', 'stroke-linejoin': 'round' }, attrs);
  }

  function nodeHalfWidth(N) { return Math.max(N.tracks, 2) * C.S / 2 + 14; }

  function render(svg, P, model, ui) {
    const T = theme();
    const L = model.settings.layers;
    const exporting = !!ui.exporting;
    const selNode = ui.sel && ui.sel.type === 'node' ? ui.sel.id : null;
    const selConn = ui.sel && ui.sel.type === 'conn' ? ui.sel.id : null;
    const selStruct = ui.sel && ui.sel.type === 'struct' ? ui.sel.id : null;
    svg.textContent = '';
    svg.setAttribute('font-family', T.font);

    const defs = el(svg, 'defs', {});
    const pat = el(defs, 'pattern', { id: 'gp-grid', width: 20, height: 20, patternUnits: 'userSpaceOnUse' });
    el(pat, 'circle', { cx: 0, cy: 0, r: 1.15, fill: T.dot });
    el(pat, 'circle', { cx: 20, cy: 0, r: 1.15, fill: T.dot });
    el(pat, 'circle', { cx: 0, cy: 20, r: 1.15, fill: T.dot });
    el(pat, 'circle', { cx: 20, cy: 20, r: 1.15, fill: T.dot });
    const vb = ui.viewBox;
    const bgAttrs = { x: f(vb.x - 400), y: f(vb.y - 400), width: f(vb.w + 800), height: f(vb.h + 800), 'data-bg': 1 };
    el(svg, 'rect', Object.assign({ fill: T.bg }, bgAttrs));
    el(svg, 'rect', Object.assign({ fill: 'url(#gp-grid)' }, bgAttrs));

    const gSketch = el(svg, 'g', {});
    const gTrack = el(svg, 'g', {});
    const gMarks = el(svg, 'g', {});
    const gSig = el(svg, 'g', {});
    const gNodes = el(svg, 'g', {});
    const gLabels = el(svg, 'g', { 'pointer-events': 'none' });
    el(svg, 'g', { id: 'gp-hl', 'pointer-events': 'none' });
    const gUi = el(svg, 'g', {});

    // ── Skizze: gewünschte Verbindungen als farbige Linien ──
    if (L.sketch || !L.tracks) {
      for (const K of P.connections) {
        const a = K.a.pos, b = K.b.pos;
        const mid = G.lerp(a, b, 0.5);
        const c = P.center ? G.lerp(mid, P.center, 0.3) : mid;
        const dd = `M${pt(a)}Q${pt(c)} ${pt(b)}`;
        const on = selConn === K.id;
        el(gSketch, 'path', { d: dd, fill: 'none', stroke: K.color, 'stroke-width': on ? 8 : 6, 'stroke-linecap': 'round',
          opacity: L.tracks ? (on ? 0.45 : 0.2) : (on ? 1 : 0.85) });
        if (!exporting) el(gSketch, 'path', { d: dd, fill: 'none', stroke: 'transparent', 'stroke-width': 18, 'data-conn': K.id, class: 'hit' });
      }
    }

    // ── Gleise ──
    if (L.tracks) {
      if (P.strands.length && P.center) {
        el(gTrack, 'circle', { cx: f(P.center.x), cy: f(P.center.y), r: f(P.ring), fill: 'none', stroke: T.line, 'stroke-width': 1.2, 'stroke-dasharray': '2 7' });
      }
      for (const s of P.stubs) {
        const used = !s.lane || s.lane.strands.length || s.kind === 'single';
        el(gTrack, 'path', { d: d(s.pts), fill: 'none', stroke: T.track, 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: used ? 1 : 0.35 });
        if (s.kind !== 'single' && used) chevrons(gTrack, s.pts, G.cumulative(s.pts), T.bg, 46);
      }
      for (const pr of P.presorts) for (const pair of pr.pairs) for (const sg of pair.segs) {
        el(gTrack, 'path', { d: d(sg), stroke: T.track, 'stroke-width': 2.2, 'stroke-linecap': 'round', 'data-presort': pr.node.id });
      }
      for (const st of P.stems) {
        el(gTrack, 'path', { d: d(st.pts), fill: 'none', stroke: T.track, 'stroke-width': 3.4, 'stroke-linecap': 'round', 'data-lane': st.lane.id });
        chevrons(gTrack, st.pts, G.cumulative(st.pts), T.bg, 40);
      }
      for (const s of P.strands) {
        const on = selConn === s.conn.id;
        el(gTrack, 'path', { d: d(s.path), fill: 'none', stroke: s.color, 'stroke-width': on ? 4.6 : 3.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
          'data-conn': s.conn.id, 'data-strand': s.id, class: exporting ? null : 'strand' });
        chevrons(gTrack, s.path, s.cum, T.bg, 110);
      }
      // Brücken: oberes Gleis mit Umrandung über dem unteren
      for (const b of P.bridges) {
        const s = b.strand;
        const sub = G.slice(s.path, s.cum, b.s - 20, b.s + 20);
        if (sub.length < 2) continue;
        el(gTrack, 'path', { d: d(sub), fill: 'none', stroke: T.bg, 'stroke-width': 15, 'stroke-linecap': 'butt' });
        for (const side of [1, -1]) {
          // Brückengeländer mit kleinen Ausläufern an den Enden
          const rail = offsetLine(sub, side * 6.5);
          const a0 = sub[0], a1 = sub[sub.length - 1];
          const t0 = G.norm(G.sub(sub[1], a0)), t1 = G.norm(G.sub(a1, sub[sub.length - 2]));
          const f0 = G.add(rail[0], G.add(G.mul(t0, -4), G.mul(G.right(t0), side * 4)));
          const f1 = G.add(rail[rail.length - 1], G.add(G.mul(t1, 4), G.mul(G.right(t1), side * 4)));
          el(gTrack, 'path', { d: d([f0, ...rail, f1]), fill: 'none', stroke: T.ink, 'stroke-width': 1.4, 'stroke-linejoin': 'round', opacity: 0.85 });
        }
        el(gTrack, 'path', { d: d(sub), fill: 'none', stroke: s.color, 'stroke-width': selConn === s.conn.id ? 4.6 : 3.2, 'stroke-linecap': 'butt' });
      }

      // Maßklammer: Ausfahrsignal mindestens eine Zuglänge hinter der letzten Einfädelung
      if (L.labels && L.signals) {
        for (const N of P.nodes) {
          if (N.single) continue;
          const shared = N.outLanes.filter(l => l.strands.length > 1);
          if (!shared.length) continue;
          const offs = N.outLanes.map(l => l.off);
          const lat = (P.side > 0 ? Math.min(...offs) : Math.max(...offs)) - P.side * 13;
          const merge = Math.max(...shared.map(l => N.legLen));                // letzte Weiche am Ende des Zulaufs
          const sigs = P.signals.filter(sg => sg.kind === 'A' && sg.node === N);
          const far = Math.max(...sigs.map(sg => -G.dot(G.sub(sg.p, N.pos), N.u)));
          const pa = G.add(N.pos, G.add(G.mul(N.u, merge), G.mul(N.r, lat)));
          const pb = G.add(N.pos, G.add(G.mul(N.u, -far), G.mul(N.r, lat)));
          const tick = G.mul(N.r, 4);
          el(gTrack, 'path', { d: `M${pt(pa)}L${pt(pb)}M${pt(G.add(pa, tick))}L${pt(G.sub(pa, tick))}M${pt(G.add(pb, tick))}L${pt(G.sub(pb, tick))}`,
            stroke: T.sigA, 'stroke-width': 1.1, 'stroke-dasharray': '4 3', opacity: 0.8 });
          const mid = G.add(G.lerp(pa, pb, 0.5), G.mul(N.r, -P.side * 9));
          let ang = G.toDeg(G.angleOf(N.u));
          if (ang > 90.5 || ang < -89.5) ang += 180;
          el(gLabels, 'text', halo({ x: f(mid.x), y: f(mid.y), transform: `rotate(${f(ang)} ${f(mid.x)} ${f(mid.y)})`, 'text-anchor': 'middle',
            'dominant-baseline': 'central', 'font-size': 9.5, fill: T.sigA }, T), '≥ 1 Zuglänge bis A-Signal');
        }
      }

      // Weichen
      for (const w of P.switches) {
        el(gMarks, 'circle', { cx: f(w.p.x), cy: f(w.p.y), r: 3.8, fill: T.bg, stroke: T.ink, 'stroke-width': 1.4, 'data-ref': w.label });
        if (L.labels) {
          // Beschriftung außen neben das Gleisbündel (Einfahrt/Ausfahrt jeweils auf ihrer Seite)
          let lp = G.add(w.p, G.mul(G.right(w.dir), 13));
          if (w.lane) {
            const N = w.node, grp = w.lane.kind === 'in' ? N.inLanes : N.outLanes;
            const offs = grp.map(l => l.off);
            const sideSign = (w.lane.kind === 'in' ? 1 : -1) * P.side;
            const edge = sideSign > 0 ? Math.max(...offs) : Math.min(...offs);
            const along = G.dot(G.sub(w.p, N.pos), N.u);
            lp = G.add(N.pos, G.add(G.mul(N.u, along), G.mul(N.r, edge + sideSign * 14)));
          }
          el(gLabels, 'text', halo({ x: f(lp.x), y: f(lp.y), 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 10, fill: T.muted }, T), w.label);
        }
      }
      // Kreuzungsbauwerke (Schilder so verschieben, dass sie sich nicht überdecken)
      const placed = [];
      for (const st of P.structures) {
        if (st.mode === 'flat') {
          for (const x of st.crossings) {
            const p = x.p;
            el(gMarks, 'path', { d: `M${f(p.x)} ${f(p.y - 6)}L${f(p.x + 6)} ${f(p.y)}L${f(p.x)} ${f(p.y + 6)}L${f(p.x - 6)} ${f(p.y)}Z`,
              fill: 'none', stroke: T.warn, 'stroke-width': 1.8 });
          }
        }
        const on = selStruct === st.key;
        const g = el(gMarks, 'g', { 'data-struct': st.key, 'data-ref': st.label, class: exporting ? null : 'pill' });
        const w = 12 + st.label.length * 6.2;
        let c = G.add(st.center, G.v(0, -20));
        for (let tries = 0; tries < 12 && placed.some(q => Math.abs(q.x - c.x) < (q.w + w) / 2 + 3 && Math.abs(q.y - c.y) < 20); tries++) {
          c = G.add(c, G.v(0, -19));
        }
        placed.push({ x: c.x, y: c.y, w });
        el(gMarks, 'line', { x1: f(st.center.x), y1: f(st.center.y), x2: f(c.x), y2: f(c.y + 8.5), stroke: T.line, 'stroke-width': 1 });
        el(g, 'rect', { x: f(c.x - w / 2), y: f(c.y - 8.5), width: f(w), height: 17, rx: 8.5,
          fill: T.panel, stroke: on ? T.accent : st.mode === 'flat' ? T.warn : T.line, 'stroke-width': on ? 2 : 1.2 });
        el(g, 'text', { x: f(c.x), y: f(c.y + 0.5), 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 10.5, 'font-weight': 600, fill: T.ink }, st.label);
      }
    }

    // ── Signale ──
    if (L.signals && L.tracks) {
      for (const sg of P.signals) {
        const col = sg.kind === 'E' ? T.sigE : sg.kind === 'A' ? T.sigA : T.sigZ;
        const n = G.right(sg.dir);
        const c = sg.p;
        const g = el(gSig, 'g', { 'data-ref': sg.label, class: exporting ? null : 'sig' });
        const hollow = !sg.oneWay || sg.conditional;
        el(g, 'circle', { cx: f(c.x), cy: f(c.y), r: 6.6, fill: hollow ? T.panel : col, stroke: hollow ? col : T.bg, 'stroke-width': hollow ? 1.8 : 1.4,
          'stroke-dasharray': sg.conditional ? '2.4 1.9' : null });
        const tip = G.add(c, G.mul(sg.dir, 4.1)), base = G.sub(c, G.mul(sg.dir, 3));
        el(g, 'path', { d: `M${pt(tip)}L${pt(G.add(base, G.mul(n, 3.4)))}L${pt(G.sub(base, G.mul(n, 3.4)))}Z`, fill: hollow ? col : T.bg });
        if (L.labels) {
          const lp = G.sub(c, G.mul(sg.dir, 17));          // hinter dem Signal auf dem Gleis

          el(gLabels, 'text', halo({ x: f(lp.x), y: f(lp.y), 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 10.5, 'font-weight': 700, fill: col }, T), sg.label);
        }
      }
    }

    // ── Anschlüsse ──
    for (const N of P.nodes) {
      const hw = nodeHalfWidth(N);
      const ang = G.toDeg(G.angleOf(N.r));
      const on = selNode === N.id;
      const g = el(gNodes, 'g', { transform: `translate(${pt(N.pos)}) rotate(${f(ang)})`, 'data-node': N.id, class: exporting ? null : 'node' });
      el(g, 'rect', { x: -hw, y: -C.BOX_D / 2, width: 2 * hw, height: C.BOX_D, rx: 7, fill: T.panel,
        stroke: on ? T.accent : T.ink, 'stroke-width': on ? 2.4 : 1.6 });
      const flip = ang > 90.5 || ang < -89.5;
      el(g, 'text', { x: 0, y: 0.5, transform: flip ? 'rotate(180)' : null, 'text-anchor': 'middle', 'dominant-baseline': 'central',
        'font-size': 11.5, 'font-weight': 650, fill: T.ink }, `${N.tracks} ${N.tracks === 1 ? 'Gleis' : 'Gleise'}`);

      if (L.labels) {
        const back = G.mul(N.u, -1);
        const endD = N.stubLen || C.STUB;
        if (!N.single && L.tracks) {
          for (const Ln of N.lanes) {
            const lp = G.add(Ln.pos, G.mul(back, endD + 9));
            el(gLabels, 'text', halo({ x: f(lp.x), y: f(lp.y), 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 9, fill: T.muted }, T), `G${Ln.no}`);
          }
        }
        const np = G.add(N.pos, G.mul(back, (L.tracks ? endD : C.BOX_D) + 28));
        const anchor = back.x < -0.45 ? 'end' : back.x > 0.45 ? 'start' : 'middle';
        el(gLabels, 'text', halo({ x: f(np.x), y: f(np.y), 'text-anchor': anchor, 'dominant-baseline': 'central', 'font-size': 14, 'font-weight': 700, fill: T.ink }, T), N.name);
      }
    }

    // ── Griffe am ausgewählten Anschluss ──
    if (!exporting && selNode) {
      const N = P.nodes.find(n => n.id === selNode);
      if (N) {
        const hw = nodeHalfWidth(N);
        const rk = G.add(N.pos, G.mul(N.u, C.BOX_D / 2 + 38));
        el(gUi, 'line', { x1: f(N.pos.x + N.u.x * C.BOX_D / 2), y1: f(N.pos.y + N.u.y * C.BOX_D / 2), x2: f(rk.x), y2: f(rk.y), stroke: T.accent, 'stroke-width': 1.5, 'stroke-dasharray': '3 3' });
        const gr = el(gUi, 'g', { 'data-handle': 'rotate', 'data-node': N.id, class: 'handle' });
        el(gr, 'circle', { cx: f(rk.x), cy: f(rk.y), r: 11, fill: T.accent, stroke: T.bg, 'stroke-width': 2 });
        const tip = G.add(rk, G.mul(N.u, 6)), base = G.sub(rk, G.mul(N.u, 4));
        el(gr, 'path', { d: `M${pt(tip)}L${pt(G.add(base, G.mul(N.r, 5)))}L${pt(G.sub(base, G.mul(N.r, 5)))}Z`, fill: T.bg });
        el(gr, 'title', {}, N.autoDir ? 'Ziehen: Richtung festlegen' : 'Ziehen: Richtung ändern · Doppelklick: automatisch');
        const ck = G.add(N.pos, G.mul(N.r, hw + 22));
        const gc = el(gUi, 'g', { 'data-handle': 'connect', 'data-node': N.id, class: 'handle' });
        el(gc, 'circle', { cx: f(ck.x), cy: f(ck.y), r: 11, fill: T.panel, stroke: T.accent, 'stroke-width': 2 });
        el(gc, 'path', { d: `M${f(ck.x - 5)} ${f(ck.y)}H${f(ck.x + 5)}M${f(ck.x)} ${f(ck.y - 5)}V${f(ck.y + 5)}`, stroke: T.accent, 'stroke-width': 2.2, 'stroke-linecap': 'round' });
        el(gc, 'title', {}, 'Auf einen anderen Anschluss ziehen: verbinden/trennen');
      }
    }
    if (!exporting && ui.connectDrag) {
      const a = ui.connectDrag.from, b = ui.connectDrag.to;
      el(gUi, 'line', { x1: f(a.x), y1: f(a.y), x2: f(b.x), y2: f(b.y), stroke: T.accent, 'stroke-width': 2.5, 'stroke-dasharray': '6 5', 'stroke-linecap': 'round' });
    }
  }

  // Hervorhebung (Hover in der Bauanleitung ↔ Zeichnung)
  function highlight(svg, P, ref) {
    const g = svg.querySelector('#gp-hl');
    if (!g) return;
    g.textContent = '';
    if (!ref || !P) return;
    const T = theme();
    const ring = (p, r) => el(g, 'circle', { cx: f(p.x), cy: f(p.y), r: r || 13, fill: 'none', stroke: T.accent, 'stroke-width': 2.6, class: 'pulse' });
    const glow = (pts) => el(g, 'path', { d: d(pts), fill: 'none', stroke: T.accent, 'stroke-width': 9, opacity: 0.45, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    if (ref.startsWith('lane:') || ref.startsWith('node:')) {
      const id = ref.slice(5);
      const hit = (L) => L && (ref[0] === 'l' ? L.id === id : L.node.id === id);
      for (const s of P.stubs) if (hit(s.lane) || (!s.lane && ref[0] === 'n' && s.node.id === id)) glow(s.pts);
      for (const s of P.stems) if (hit(s.lane)) glow(s.pts);
      for (const s of P.strands) if (hit(s.oLane) || hit(s.dLane)) glow(s.path);
      return;
    }
    const sg = P.signals.find(s => s.label === ref);
    if (sg) return void ring(sg.p, 12);
    const w = P.switches.find(s => s.label === ref);
    if (w) return void ring(w.p, 11);
    const st = P.structures.find(s => s.label === ref);
    if (st) { st.crossings.forEach(x => ring(x.p, 10)); return; }
  }

  root.GP = root.GP || {};
  root.GP.render = { render, highlight, theme, nodeHalfWidth };
})(typeof globalThis !== 'undefined' ? globalThis : this);
