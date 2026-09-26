/* Gleisknoten-Planer – Planungslogik: Modell → Gleisplan mit Weichen, Kreuzungen und Signalen.
   DOM-frei; im Browser über GP.planner, unter Node per require(). */
(function (root) {
  'use strict';
  const G = (typeof module !== 'undefined' && module.exports) ? require('./geometry.js') : root.GP.geo;

  // Maße in Zeichenflächen-Einheiten (Punktraster = 20)
  const C = {
    S: 16,        // Gleisabstand am Anschluss
    P: 16,        // Abstand der Gleisenden auf dem Knotenring
    SW_GAP: 40,   // Abstand hintereinanderliegender Weichen
    FAN: 100,     // Platz zwischen Weichenstraße und Knotenring
    LEG_MIN: 26,  // Mindestlänge des geraden Stücks hinter dem Anschluss
    BOX_D: 26,    // Tiefe des Anschlusskastens
    STUB: 106,    // Gleisstummel außen (Strecke)
    SPLIT: 74,    // Spreizweiche eingleisiger Anschlüsse (außen)
    SIG_IN: 26,   // Einfahrsignal außen vor dem Kasten
    SIG_OUT: 60,  // Ausfahrsignal außen hinter dem Kasten
    SIG_STAGGER: 18, // Versatz der Signale benachbarter Gleise
    RING_MIN: 70,
    CLUSTER: 90,  // Kreuzungen näher als das → ein Bauwerk
    GEO_STEP: 9,
  };

  const PALETTE = [
    { hex: '#f07f3c', name: 'Orange' },
    { hex: '#e5413b', name: 'Rot' },
    { hex: '#e2bd3a', name: 'Gelb' },
    { hex: '#46a758', name: 'Grün' },
    { hex: '#4fb3ea', name: 'Blau' },
    { hex: '#a879e6', name: 'Violett' },
    { hex: '#2ec4b6', name: 'Türkis' },
    { hex: '#ef6fb0', name: 'Pink' },
    { hex: '#b08457', name: 'Braun' },
    { hex: '#9aa0a6', name: 'Grau' },
  ];
  const colorName = (hex) => {
    const p = PALETTE.find(q => q.hex.toLowerCase() === String(hex || '').toLowerCase());
    return p ? p.name : String(hex || '');
  };
  const WEIGHTS = { 1: 'gering', 2: 'normal', 3: 'hoch' };

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const defaultInCount = (n) => (n <= 1 ? 1 : Math.ceil(n / 2));
  const listDe = (arr) => arr.length <= 1 ? (arr[0] || '') : arr.slice(0, -1).join(', ') + ' und ' + arr[arr.length - 1];
  const uniq = (arr) => [...new Set(arr)];

  function emptyModel() {
    return {
      version: 1,
      settings: { traffic: 'right', crossingDefault: 'bridge',
        layers: { sketch: false, tracks: true, signals: true, labels: true } },
      nodes: [], connections: [], crossingOverrides: {},
    };
  }

  // Modell säubern: Pflichtfelder, Grenzen, ungültige/doppelte Verbindungen raus
  function normalizeModel(input) {
    const base = emptyModel();
    const m = Object.assign(base, JSON.parse(JSON.stringify(input || {})));
    m.settings = Object.assign(emptyModel().settings, m.settings || {});
    m.settings.layers = Object.assign(emptyModel().settings.layers, (m.settings && m.settings.layers) || {});
    if (m.settings.traffic !== 'left') m.settings.traffic = 'right';
    if (m.settings.crossingDefault !== 'flat') m.settings.crossingDefault = 'bridge';
    m.crossingOverrides = m.crossingOverrides && typeof m.crossingOverrides === 'object' ? m.crossingOverrides : {};
    m.nodes = (Array.isArray(m.nodes) ? m.nodes : []).filter(n => n && n.id != null).map((n, i) => {
      const tracks = clamp(Math.round(n.tracks == null || isNaN(+n.tracks) ? 2 : +n.tracks), 1, 8);
      let inCount = n.inCount == null || n.inCount === '' ? null : clamp(Math.round(+n.inCount), 0, tracks);
      if (tracks === 1) inCount = null;
      const dir = n.dir == null || n.dir === '' || !isFinite(+n.dir) ? null : +n.dir;
      return { id: String(n.id), name: String(n.name || `Anschluss ${i + 1}`), x: +n.x || 0, y: +n.y || 0, tracks, inCount, dir };
    });
    const ids = new Set(m.nodes.map(n => n.id));
    const seen = new Set();
    m.connections = (Array.isArray(m.connections) ? m.connections : []).filter(c => {
      if (!c || c.id == null) return false;
      const a = String(c.a), b = String(c.b);
      if (a === b || !ids.has(a) || !ids.has(b)) return false;
      const key = [a, b].sort().join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((c, i) => ({
      id: String(c.id), a: String(c.a), b: String(c.b),
      color: c.color || PALETTE[i % PALETTE.length].hex,
      weight: [1, 2, 3].includes(+c.weight) ? +c.weight : 2,
    }));
    return m;
  }

  // Alle Aufteilungen von n Elementen in k zusammenhängende, nicht leere Gruppen
  function compositions(n, k) {
    const res = [];
    const rec = (left, parts, acc) => {
      if (parts === 1) { res.push([...acc, left]); return; }
      for (let s = 1; s <= left - parts + 1; s++) rec(left - s, parts - 1, [...acc, s]);
    };
    if (k >= 1 && n >= k) rec(n, k, []);
    return res;
  }

  // Ströme (sortiert außen → innen) auf Gleise (außen → innen) verteilen.
  // Ergebnis: pro Strom die Liste seiner Gleise. Mehr Ströme als Gleise → Gruppen mit
  // möglichst gleicher Last (Verkehrsgewicht); weniger Ströme → Zusatzgleise nach D'Hondt.
  function allocate(flows, lanes) {
    const res = new Map();
    const F = flows.length, k = lanes.length;
    if (!F) return res;
    if (!k) { flows.forEach(f => res.set(f, [])); return res; }
    if (F >= k) {
      let best = null;
      for (const sizes of compositions(F, k)) {
        let i = 0;
        const loads = sizes.map(sz => { let s = 0; for (let j = 0; j < sz; j++) s += flows[i + j].w; i += sz; return s; });
        const score = [Math.max(...loads), loads.reduce((a, b) => a + b * b, 0), ...sizes.map(s => -s)];
        if (!best || lexLess(score, best.score)) best = { sizes, score };
      }
      let i = 0;
      best.sizes.forEach((sz, li) => { for (let j = 0; j < sz; j++) res.set(flows[i + j], [lanes[li]]); i += sz; });
    } else {
      const seats = flows.map(() => 1);
      for (let extra = k - F; extra > 0; extra--) {
        let bi = 0;
        for (let i = 1; i < F; i++) if (flows[i].w / (seats[i] + 1) > flows[bi].w / (seats[bi] + 1)) bi = i;
        seats[bi]++;
      }
      let li = 0;
      flows.forEach((f, i) => { res.set(f, lanes.slice(li, li + seats[i])); li += seats[i]; });
    }
    return res;
  }
  function lexLess(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] ?? 0, y = b[i] ?? 0;
      if (Math.abs(x - y) > 1e-9) return x < y;
    }
    return false;
  }

  // Knotenblöcke auf dem Ring auseinanderschieben, falls sich Anschlüsse ins Gehege kommen
  function packBlocks(blocks) {
    if (blocks.length < 2) return;
    const total = blocks.reduce((s, b) => s + 2 * b.half, 0);
    if (total > G.TAU * 0.96) {
      const f = (G.TAU * 0.96) / total;
      blocks.forEach(b => { b.half *= f; b.scale = f; });
    }
    for (let it = 0; it < 80; it++) {
      blocks.sort((a, b) => G.wrap(a.c) - G.wrap(b.c));
      let moved = false;
      for (let i = 0; i < blocks.length; i++) {
        const a = blocks[i], b = blocks[(i + 1) % blocks.length];
        let gap = G.wrap(b.c - a.c);
        if (blocks.length === 1) break;
        const need = a.half + b.half;
        if (gap < need - 1e-6) {
          const push = (need - gap) / 2 + 1e-4;
          a.c -= push; b.c += push; moved = true;
        }
      }
      if (!moved) break;
    }
  }

  // ───────────────────────────── Hauptfunktion ─────────────────────────────
  function plan(input) {
    const m = normalizeModel(input);
    const side = m.settings.traffic === 'left' ? -1 : 1;
    const P = {
      model: m, side, C, center: null, ring: 0,
      nodes: [], lanes: [], connections: [], flows: [], strands: [],
      stems: [], stubs: [], switches: [], crossings: [], structures: [], bridges: [],
      signals: [], presorts: [], notes: [], stats: {}, guide: { nodes: [], switches: [], structures: [], signals: [] },
    };
    if (!m.nodes.length) return finish(P);

    // 1) Knotenzentrum und Ausrichtung der Anschlüsse
    const O = G.v(m.nodes.reduce((s, n) => s + n.x, 0) / m.nodes.length,
                  m.nodes.reduce((s, n) => s + n.y, 0) / m.nodes.length);
    P.center = O;
    P.nodes = m.nodes.map((n, idx) => {
      const pos = G.v(n.x, n.y);
      const toC = G.sub(O, pos);
      const u = n.dir != null ? G.fromAngle(G.toRad(n.dir)) : (G.len(toC) < 1 ? G.v(1, 0) : G.norm(toC));
      const N = {
        id: n.id, idx, name: n.name, pos, u, r: G.right(u),
        dirDeg: G.toDeg(G.angleOf(u)), autoDir: n.dir == null,
        tracks: n.tracks, single: n.tracks === 1,
        inCount: n.tracks === 1 ? 1 : (n.inCount == null ? defaultInCount(n.tracks) : n.inCount),
        autoSplit: n.inCount == null,
        phi: G.len(toC) < 1 ? 0 : G.angleOf(G.sub(pos, O)), distC: G.len(toC),
        lanes: [], inLanes: [], outLanes: [], dep: [], arr: [], ports: [],
      };
      N.outCount = N.single ? 1 : N.tracks - N.inCount;
      return N;
    });
    const byId = new Map(P.nodes.map(N => [N.id, N]));

    // 2) Gleise je Anschluss: rechts (Rechtsverkehr) = Einfahrt, links = Ausfahrt
    for (const N of P.nodes) {
      const mk = (kind, index, off) => {
        const L = { id: `${N.id}:${kind}:${index}`, node: N, kind, index, no: index + 1, off,
          pos: G.add(N.pos, G.mul(N.r, off)), strands: [], single: N.single };
        N.lanes.push(L); P.lanes.push(L);
        return L;
      };
      if (N.single) {
        mk('in', 0, side * C.S / 2);
        mk('out', 0, -side * C.S / 2);
      } else {
        for (let i = 0; i < N.tracks; i++) {
          const off = (i - (N.tracks - 1) / 2) * C.S;
          const isIn = side > 0 ? i >= N.tracks - N.inCount : i < N.inCount;
          mk(isIn ? 'in' : 'out', i, off);
        }
      }
      // jeweils von außen nach innen (zur Mitte des Anschlusses hin)
      N.inLanes = N.lanes.filter(L => L.kind === 'in').sort((a, b) => side * b.off - side * a.off);
      N.outLanes = N.lanes.filter(L => L.kind === 'out').sort((a, b) => side * a.off - side * b.off);
      N.inLanes.forEach((L, i) => { L.rank = i; });
      N.outLanes.forEach((L, i) => { L.rank = i; });
    }

    // 3) Verbindungen → gerichtete Ströme
    m.connections.forEach((c, ci) => {
      const A = byId.get(c.a), B = byId.get(c.b);
      const K = { id: c.id, idx: ci, a: A, b: B, w: c.weight, color: c.color, colorName: colorName(c.color), strands: [] };
      K.label = `${A.name} ↔ ${B.name}`;
      P.connections.push(K);
      for (const [F, T] of [[A, B], [B, A]]) {
        const f = { id: `${c.id}:${F.id}>${T.id}`, conn: K, from: F, to: T, w: c.weight, color: c.color,
          oLanes: [], dLanes: [], strands: [] };
        P.flows.push(f); F.dep.push(f); T.arr.push(f);
      }
    });

    // 4) Ströme auf Gleise verteilen. Reihenfolge nach Lage auf dem Knotenring: das äußere
    //    Einfahrgleis bedient das nächstgelegene Ziel auf seiner Seite (wie Abbiegespuren).
    const ringKey = (N, M) => G.wrap(side * (N.phi - M.phi));
    for (const N of P.nodes) {
      N.dep.sort((f, g) => ringKey(N, f.to) - ringKey(N, g.to) || f.conn.idx - g.conn.idx);
      N.arr.sort((f, g) => ringKey(N, g.from) - ringKey(N, f.from) || f.conn.idx - g.conn.idx);
      const dA = allocate(N.dep, N.inLanes);
      N.dep.forEach(f => { f.oLanes = dA.get(f) || []; });
      const aA = allocate(N.arr, N.outLanes);
      N.arr.forEach(f => { f.dLanes = aA.get(f) || []; });
    }

    // 5) Stränge: durchgehende Einrichtungsgleise; rechts bleibt rechts
    for (const f of P.flows) {
      const a = f.oLanes.length, b = f.dLanes.length;
      if (!a || !b) { f.invalid = true; continue; }
      const n = Math.max(a, b);
      for (let j = 0; j < n; j++) {
        const s = { id: `${f.id}#${j}`, idx: P.strands.length, flow: f, conn: f.conn, j, color: f.color,
          oLane: f.oLanes[Math.floor(j * a / n)], dLane: f.dLanes[Math.floor(j * b / n)] };
        s.oLane.strands.push(s); s.dLane.strands.push(s);
        f.strands.push(s); f.conn.strands.push(s); P.strands.push(s);
      }
    }
    if (!P.strands.length) return finish(P);

    // 6) Gleisenden auf dem Knotenring (von der Einfahrseite außen zur Ausfahrseite außen)
    for (const N of P.nodes) {
      const dep = [], arr = [];
      N.dep.forEach(f => f.strands.forEach(s => dep.push({ s, end: 'o' })));
      N.arr.forEach(f => f.strands.forEach(s => arr.push({ s, end: 'd' })));
      N.ports = dep.concat(arr.reverse());
    }
    const withPorts = P.nodes.filter(N => N.ports.length);
    const maxShare = Math.max(1, ...P.lanes.map(L => L.strands.length));
    const need = C.FAN + C.LEG_MIN + Math.max(0, maxShare - 2) * C.SW_GAP + 12;
    const R = P.ring = Math.max(C.RING_MIN, Math.min(...withPorts.map(N => N.distC)) - need);
    const blocks = withPorts.map(N => ({ N, c: N.phi, half: (N.ports.length * C.P) / (2 * R) + 10 / R, scale: 1 }));
    packBlocks(blocks);
    for (const b of blocks) {
      const N = b.N, K = N.ports.length, pitch = C.P * b.scale;
      N.ringAngle = b.c;
      N.ports.forEach((pt, k) => {
        const off = side * ((K - 1) / 2 - k) * pitch;        // + = rechts (Blick in den Knoten)
        const ang = b.c - off / R;                            // wachsender Winkel = nach links
        const Q = G.add(O, G.mul(G.fromAngle(ang), R));
        if (pt.end === 'o') { pt.s.oAng = ang; pt.s.oPort = Q; } else { pt.s.dAng = ang; pt.s.dPort = Q; }
      });
    }

    // 7) Gerade Zulaufstücke, Weichenstraßen und Einfädelungen
    for (const N of P.nodes) {
      const w = G.sub(N.pos, O);
      const bb = G.dot(w, N.u);
      const disc = bb * bb - (G.dot(w, w) - R * R);
      let tRing = disc >= 0 ? -bb - Math.sqrt(disc) : -1;
      if (!(tRing > 0)) tRing = Math.max(N.distC - R, C.LEG_MIN + C.FAN);
      const share = Math.max(1, ...N.lanes.map(L => L.strands.length));
      N.legLen = Math.max(C.LEG_MIN, tRing - C.FAN - Math.max(0, share - 2) * C.SW_GAP);
    }
    for (const L of P.lanes) {
      const N = L.node, u = N.u, cnt = L.strands.length;
      L.legEnd = G.add(L.pos, G.mul(u, N.legLen));
      if (!cnt) continue;
      if (cnt === 1) {
        const s = L.strands[0];
        if (L.kind === 'in') { s.oStart = L.legEnd; s.oLead = [L.pos, L.legEnd]; }
        else { s.dEnd = L.legEnd; s.dTail = [L.legEnd, L.pos]; }
        continue;
      }
      const portOf = (s) => (L.kind === 'in' ? s.oPort : s.dPort);
      const lat = (s) => G.dot(G.sub(portOf(s), L.pos), N.r);
      // stärkster seitlicher Versatz zweigt zuerst ab (nahe am Anschluss), Geradeaus-Strang zuletzt
      const order = L.strands.slice().sort((a, b) => Math.abs(lat(b)) - Math.abs(lat(a)) || lat(a) - lat(b));
      const nSw = cnt - 1;
      const pts = [];
      for (let j = 0; j < nSw; j++) pts.push(G.add(L.legEnd, G.mul(u, j * C.SW_GAP)));
      order.forEach((s, k) => {
        const j = Math.min(k, nSw - 1);
        if (L.kind === 'in') { s.oStart = pts[j]; s.oSw = j; } else { s.dEnd = pts[j]; s.dSw = j; }
      });
      L.order = order;
      P.stems.push({ lane: L, pts: L.kind === 'in' ? [L.pos, pts[nSw - 1]] : [pts[nSw - 1], L.pos] });
      pts.forEach((p, j) => {
        P.switches.push({ kind: L.kind === 'in' ? 'diverge' : 'merge', lane: L, node: N, j, p,
          dir: L.kind === 'in' ? u : G.mul(u, -1), branch: order[j], through: order.slice(j + 1), last: j === nSw - 1 });
      });
    }

    // 8) Strangverläufe: Zulauf → Übergangsbogen → Ringsehne (Geodäte) → Übergangsbogen → Ablauf
    for (const s of P.strands) {
      const No = s.oLane.node, Nd = s.dLane.node;
      const Qo = s.oPort, Qd = s.dPort;
      const inO = G.norm(G.sub(O, Qo)), outD = G.norm(G.sub(Qd, O));
      const h1 = 0.45 * G.dist(s.oStart, Qo), h2 = 0.45 * G.dist(Qd, s.dEnd);
      const appO = G.bezier(s.oStart, G.add(s.oStart, G.mul(No.u, h1)), G.sub(Qo, G.mul(inO, h1)), Qo, 18);
      const chord = G.geodesic(O, R, s.oAng, s.dAng, C.GEO_STEP);
      const appD = G.bezier(Qd, G.add(Qd, G.mul(outD, h2)), G.add(s.dEnd, G.mul(Nd.u, h2)), s.dEnd, 18);
      const head = G.concat(s.oLead || [], appO);
      s.path = G.concat(head, chord, appD, s.dTail || []);
      s.cum = G.cumulative(s.path);
      s.length = s.cum[s.cum.length - 1];
      s.chord = chord;
      s.chordCum = G.cumulative(chord);
      const hc = G.cumulative(head);
      s.chordS0 = hc[hc.length - 1];
      s.chordS1 = s.chordS0 + s.chordCum[s.chordCum.length - 1];
    }

    buildOutside(P);
    buildCrossings(P);
    buildSignals(P);
    return finish(P);
  }

  // Gleisstummel außen, Spreizweichen eingleisiger Anschlüsse, Vorsortier-Gleiswechsel
  function buildOutside(P) {
    for (const N of P.nodes) {
      const back = G.mul(N.u, -1);
      const at = (p, d) => G.add(p, G.mul(back, d));
      if (N.single) {
        N.stubLen = C.SPLIT + 70;
        const sp = N.splitPt = at(N.pos, C.SPLIT);
        for (const L of N.lanes) {
          const bend = at(L.pos, C.BOX_D / 2 + 6);
          P.stubs.push({ node: N, lane: L, kind: L.kind, pts: L.kind === 'in' ? [sp, bend, L.pos] : [L.pos, bend, sp] });
        }
        P.stubs.push({ node: N, lane: null, kind: 'single', pts: [at(N.pos, N.stubLen), sp] });
        if (N.lanes.some(L => L.strands.length)) P.switches.push({ kind: 'split', node: N, lane: null, j: 0, p: sp, dir: back });
        continue;
      }
      // Signale je Gleis leicht versetzt, damit sie nebeneinander lesbar bleiben
      N.xo1 = C.SIG_IN + Math.max(0, N.inLanes.length - 1) * C.SIG_STAGGER + 22;
      N.xo2 = N.xo1 + 32;
      N.stubLen = Math.max(C.STUB, N.xo2 + 18, C.SIG_OUT + Math.max(0, N.outLanes.length - 1) * C.SIG_STAGGER + 24);
      for (const L of N.lanes) {
        const far = at(L.pos, N.stubLen);
        P.stubs.push({ node: N, lane: L, kind: L.kind, pts: L.kind === 'in' ? [far, L.pos] : [L.pos, far] });
      }
      const used = N.inLanes.filter(L => L.strands.length);
      const sets = used.map(L => uniq(L.strands.map(s => s.flow.to.id)).sort().join(','));
      if (used.length >= 2 && uniq(sets).length >= 2) {
        const byOff = N.inLanes.slice().sort((a, b) => a.off - b.off);
        const pairs = [];
        for (let i = 0; i + 1 < byOff.length; i++) {
          const a = byOff[i], b = byOff[i + 1];
          pairs.push({ a, b, segs: [[at(a.pos, N.xo2), at(b.pos, N.xo1)], [at(b.pos, N.xo2), at(a.pos, N.xo1)]] });
        }
        P.presorts.push({ node: N, pairs, lanes: used });
      }
    }
  }

  // Kreuzungen der Ringsehnen → Kreuzungsbauwerke (je Verbindungspaar räumlich gebündelt)
  function buildCrossings(P) {
    const S = P.strands, m = P.model;
    for (let i = 0; i < S.length; i++) {
      for (let k = i + 1; k < S.length; k++) {
        const a = S[i], b = S[k];
        for (const h of G.intersections(a.chord, a.chordCum, b.chord, b.chordCum)) {
          P.crossings.push({ a, b, p: h.p, sa: a.chordS0 + h.sA, sb: b.chordS0 + h.sB });
        }
      }
    }
    const groups = new Map();
    for (const x of P.crossings) {
      const [A, B] = [x.a.conn, x.b.conn].sort((p, q) => p.idx - q.idx);
      x.key = `${A.id}|${B.id}`;
      if (!groups.has(x.key)) groups.set(x.key, { A, B, list: [] });
      groups.get(x.key).list.push(x);
    }
    for (const [key, g] of groups) {
      const clusters = [];
      for (const x of g.list) {
        const near = clusters.filter(cl => cl.some(y => G.dist(x.p, y.p) <= C.CLUSTER));
        near.forEach(cl => clusters.splice(clusters.indexOf(cl), 1));
        clusters.push([x].concat(...near));
      }
      const ov = m.crossingOverrides[key];
      const { A, B } = g;
      for (const cl of clusters) {
        // standardmäßig liegt die Verbindung mit weniger Verkehr oben (bei Gleichstand die später angelegte)
        const defOver = A.w < B.w ? A : B.w < A.w ? B : (A.idx > B.idx ? A : B);
        let mode = 'bridge', over = null;
        if (ov === 'flat') mode = 'flat';
        else if (ov === A.id) over = A;
        else if (ov === B.id) over = B;
        else if (m.settings.crossingDefault === 'flat') mode = 'flat';
        if (mode === 'bridge' && !over) over = defOver;
        const strands = uniq(cl.flatMap(x => [x.a, x.b]));
        const st = {
          key, connA: A, connB: B, crossings: cl, mode, defOver,
          over: mode === 'bridge' ? over : null,
          under: mode === 'bridge' ? (over === A ? B : A) : null,
          center: G.v(cl.reduce((s, x) => s + x.p.x, 0) / cl.length, cl.reduce((s, x) => s + x.p.y, 0) / cl.length),
          tracksA: strands.filter(s => s.conn === A).length,
          tracksB: strands.filter(s => s.conn === B).length,
        };
        cl.forEach(x => { x.structure = st; });
        P.structures.push(st);
      }
    }
    P.structures.sort((a, b) => (a.center.y - b.center.y) || (a.center.x - b.center.x));
    P.structures.forEach((st, i) => { st.label = `K${i + 1}`; });
    for (const st of P.structures) {
      if (st.mode !== 'bridge') continue;
      for (const x of st.crossings) {
        const onA = x.a.conn === st.over;
        P.bridges.push({ structure: st, strand: onA ? x.a : x.b, under: onA ? x.b : x.a, s: onA ? x.sa : x.sb, p: x.p });
      }
    }
  }

  const switchAt = (P, kind, lane, j) => P.switches.find(w => w.kind === kind && w.lane === lane && w.j === j) || null;
  const flatOn = (P, s) => P.crossings.filter(x => x.structure && x.structure.mode === 'flat' && (x.a === s || x.b === s))
    .map(x => ({ s: x.a === s ? x.sa : x.sb, ref: x.structure })).sort((a, b) => a.s - b.s);

  // Signale: E = Einfahrt, A = Ausfahrt, Z = Wartesignal (bedingt)
  function buildSignals(P) {
    const sig = (o) => { P.signals.push(o); return o; };
    for (const N of P.nodes) {
      const back = G.mul(N.u, -1);
      for (const L of N.inLanes) {
        if (!L.strands.length) continue;
        if (N.single) sig({ kind: 'E', node: N, lane: L, p: G.add(N.pos, G.mul(back, C.SPLIT + 22)), dir: N.u, oneWay: false });
        else sig({ kind: 'E', node: N, lane: L, p: G.add(L.pos, G.mul(back, C.SIG_IN + L.rank * C.SIG_STAGGER)), dir: N.u, oneWay: true });
      }
      for (const L of N.outLanes) {
        if (!L.strands.length) continue;
        const d = N.single ? C.BOX_D / 2 + 28 : C.SIG_OUT + L.rank * C.SIG_STAGGER;
        sig({ kind: 'A', node: N, lane: L, p: G.add(L.pos, G.mul(back, d)), dir: back, oneWay: true });
      }
    }
    // Ein wartender Zug soll kein geteiltes Gleis blockieren: Wartesignal vor Einfädelung oder
    // Flachkreuzung, sofern der Strang davor schon an einer Weiche/Kreuzung vorbeigekommen ist.
    for (const s of P.strands) {
      const ev = flatOn(P, s);
      if (s.dLane.strands.length > 1) ev.push({ s: s.length, ref: switchAt(P, 'merge', s.dLane, s.dSw) });
      let prev = s.oLane.strands.length > 1 ? { s: 0, ref: switchAt(P, 'diverge', s.oLane, s.oSw) } : null;
      for (const e of ev) {
        if (prev && e.s - prev.s > 46) {
          // vor dem Konfliktpunkt, aber außerhalb der Weichenstraße
          const at = G.pointAt(s.path, s.cum, e.s - Math.min(70, (e.s - prev.s) / 2));
          sig({ kind: 'Z', strand: s, p: at.p, dir: at.t, oneWay: true, conditional: true, after: prev.ref, before: e.ref });
        }
        prev = e;
      }
    }
  }

  // ───────────────────── Nummerierung, Bauanleitung, Hinweise ─────────────────────
  const nm = (N) => `„${N.name}“`;
  const laneLabel = (L) => (L.single ? `${L.node.name} (eingleisig)` : `${L.node.name} G${L.no}`);
  const dest = (s) => `${s.flow.to.name} (${s.conn.colorName})`;
  const src = (s) => `${s.flow.from.name} (${s.conn.colorName})`;
  const strandName = (s) => `${s.flow.from.name} → ${s.flow.to.name}` + (s.flow.strands.length > 1 ? ` · Gleis ${s.j + 1}` : '');

  function firstConflictOn(P, L) {
    if (L.strands.length > 1) return switchAt(P, 'diverge', L, 0);
    const f = L.strands[0] ? flatOn(P, L.strands[0]) : [];
    return f.length ? f[0].ref : null;
  }
  function lastConflictOn(P, L) {
    if (L.strands.length > 1) return switchAt(P, 'merge', L, 0);
    const f = L.strands[0] ? flatOn(P, L.strands[0]) : [];
    return f.length ? f[f.length - 1].ref : null;
  }

  function finish(P) {
    const kindOrder = { diverge: 0, merge: 1, split: 2 };
    P.switches.sort((a, b) => a.node.idx - b.node.idx || kindOrder[a.kind] - kindOrder[b.kind]
      || (a.lane && b.lane ? a.lane.rank - b.lane.rank : 0)
      || (a.kind === 'merge' ? b.j - a.j : a.j - b.j));             // in Fahrtrichtung
    P.switches.forEach((w, i) => { w.label = `W${i + 1}`; });
    const sigOrder = { E: 0, A: 1, Z: 2 };
    P.signals.sort((a, b) => sigOrder[a.kind] - sigOrder[b.kind]
      || (a.node && b.node ? (a.node.idx - b.node.idx || a.lane.rank - b.lane.rank) : 0)
      || (a.strand && b.strand ? a.strand.idx - b.strand.idx : 0));
    const count = { E: 0, A: 0, Z: 0 };
    P.signals.forEach(sg => { sg.label = sg.kind + (++count[sg.kind]); });
    buildGuide(P);
    buildNotes(P);
    const cnt = (arr, f) => arr.filter(f).length;
    P.stats = {
      strands: P.strands.length,
      switches: P.switches.length,
      diverge: cnt(P.switches, w => w.kind === 'diverge'),
      merge: cnt(P.switches, w => w.kind === 'merge'),
      split: cnt(P.switches, w => w.kind === 'split'),
      structures: P.structures.length,
      bridges: cnt(P.structures, s => s.mode === 'bridge'),
      flat: cnt(P.structures, s => s.mode === 'flat'),
      crossings: P.crossings.length,
      E: count.E, A: count.A, Z: count.Z, signals: P.signals.length,
      presort: P.presorts.length,
    };
    return P;
  }

  function buildGuide(P) {
    P.guide.nodes = P.nodes.map(N => {
      const rows = [];
      if (N.single) {
        const inL = N.inLanes[0], outL = N.outLanes[0];
        const to = uniq(inL.strands.map(s => s.flow.to.name));
        const from = uniq(outL.strands.map(s => s.flow.from.name));
        const sw = P.switches.find(w => w.kind === 'split' && w.node === N);
        rows.push({ no: 'G1', kind: 'single', lanes: [inL, outL],
          text: `eingleisig ⇄ · rein → ${to.join(', ') || '–'} · raus ← ${from.join(', ') || '–'}` + (sw ? ` · Spreizweiche ${sw.label}` : ''),
          colors: uniq(inL.strands.concat(outL.strands).map(s => s.color)) });
      } else {
        for (const L of N.lanes.slice().sort((a, b) => a.index - b.index)) {
          const flows = uniq(L.strands.map(s => s.flow));
          const text = !flows.length ? 'ungenutzt'
            : L.kind === 'in' ? `rein → ${uniq(flows.map(f => f.to.name)).join(', ')}`
            : `raus ← ${uniq(flows.map(f => f.from.name)).join(', ')}`;
          rows.push({ no: `G${L.no}`, kind: L.kind, lanes: [L], text, colors: uniq(flows.map(f => f.color)) });
        }
      }
      const split = N.single ? 'eingleisig' : `${N.inCount} rein · ${N.outCount} raus`;
      return { node: N, title: N.name, sub: `${N.tracks} ${N.tracks === 1 ? 'Gleis' : 'Gleise'} (${split})`, rows };
    });

    P.guide.switches = P.switches.map(w => {
      let text;
      if (w.kind === 'split') text = `${w.node.name}: Spreizweiche – die eingleisige Strecke teilt sich in Ein- und Ausfahrgleis`;
      else if (w.kind === 'diverge') text = w.last
        ? `${laneLabel(w.lane)} (Einfahrt): teilt sich nach ${dest(w.branch)} und ${dest(w.through[0])}`
        : `${laneLabel(w.lane)} (Einfahrt): Abzweig nach ${dest(w.branch)}, geradeaus weiter nach ${listDe(uniq(w.through.map(s => s.flow.to.name)))}`;
      else text = w.last
        ? `${laneLabel(w.lane)} (Ausfahrt): Zusammenführung von ${src(w.branch)} und ${src(w.through[0])}`
        : `${laneLabel(w.lane)} (Ausfahrt): Einfädelung von ${src(w.branch)}`;
      const colors = w.kind === 'split' ? [] : uniq([w.branch, ...w.through].map(s => s.color));
      return { label: w.label, ref: w, text, colors };
    });

    P.guide.structures = P.structures.map(st => ({
      label: st.label, ref: st, key: st.key,
      text: `${st.connA.colorName} × ${st.connB.colorName}`,
      detail: `${st.connA.label} kreuzt ${st.connB.label} · ${st.tracksA}×${st.tracksB} Gleise`,
      mode: st.mode === 'bridge' ? `Brücke/Tunnel – ${st.over.colorName} oben` : 'Flachkreuzung – Konfliktpunkt',
      colors: [st.connA.color, st.connB.color],
    }));

    P.guide.signals = P.signals.map(sg => {
      let place, dir, cond;
      if (sg.kind === 'E') {
        const first = firstConflictOn(P, sg.lane);
        place = `${laneLabel(sg.lane)} – Einfahrt` + (first ? `, vor ${first.label}` : '');
        dir = 'in den Knoten';
        cond = sg.oneWay ? 'davor ≥ 1 Zuglänge Warteplatz ohne Weiche'
          : 'ausfahrende Züge passieren es von hinten (eingleisige Strecke)';
      } else if (sg.kind === 'A') {
        const ref = lastConflictOn(P, sg.lane);
        const split = sg.node.single ? P.switches.find(w => w.kind === 'split' && w.node === sg.node) : null;
        place = `${laneLabel(sg.lane)} – Ausfahrt`;
        dir = `aus dem Knoten Richtung ${sg.node.name}`;
        cond = `≥ 1 Zuglänge hinter ${ref ? ref.label : 'der letzten Weiche/Kreuzung'}` + (split ? `, vor Spreizweiche ${split.label}` : '');
      } else {
        place = `${strandName(sg.strand)} (${sg.strand.conn.colorName}) – vor ${sg.before ? sg.before.label : '?'}`;
        dir = `Richtung ${sg.strand.flow.to.name}`;
        cond = `nur wenn zwischen ${sg.after ? sg.after.label : 'Abzweig'} und Signal ≥ 1 Zuglänge Platz ist`;
      }
      return { label: sg.label, ref: sg, kind: sg.kind, place, dir, oneWay: sg.oneWay, cond,
        angle: G.toDeg(G.angleOf(sg.dir)), conditional: !!sg.conditional };
    });
  }

  function buildNotes(P) {
    const seen = new Set();
    const add = (level, text, refs) => { if (!seen.has(text)) { seen.add(text); P.notes.push({ level, text, refs: refs || [] }); } };
    for (const f of P.flows) {
      if (!f.invalid) continue;
      if (!f.oLanes.length) add('error', `${nm(f.from)} hat keine Einfahrgleise – Verbindungen von dort gehen so nicht. Gleisanzahl oder Aufteilung ändern.`);
      else add('error', `${nm(f.to)} hat keine Ausfahrgleise – Verbindungen dorthin gehen so nicht. Gleisanzahl oder Aufteilung ändern.`);
    }
    for (const L of P.lanes) {
      if (L.strands.length < 3) continue;
      const cols = uniq(L.strands.map(s => s.conn.colorName));
      const sw = P.switches.filter(w => w.lane === L).map(w => w.label);
      if (L.kind === 'in') add('warn', `Engpass: ${laneLabel(L)} verteilt auf ${L.strands.length} Fahrwege (${listDe(cols)}). Züge warten schon vor dem Knoten aufeinander – mehr Gleise an ${nm(L.node)} würden entlasten.`, sw);
      else add('warn', `Engpass: ${laneLabel(L)} sammelt ${L.strands.length} Fahrwege (${listDe(cols)}) mit ${L.strands.length - 1} Einfädelungen hintereinander.`, sw);
    }
    for (const st of P.structures) {
      if (st.mode === 'flat') add('warn', `${st.label} ist eine Flachkreuzung: ${st.connA.colorName} und ${st.connB.colorName} müssen sich abwechseln. Mit Brücke oder Tunnel fällt der Konflikt weg.`, [st.label]);
    }
    for (const pr of P.presorts) {
      const parts = pr.lanes.map(L => `G${L.no} → ${uniq(L.strands.map(s => s.flow.to.name)).join(', ')}`);
      const e = P.signals.filter(s => s.kind === 'E' && s.node === pr.node).map(s => s.label);
      add('info', `Vor ${nm(pr.node)}: Gleiswechsel zwischen den Einfahrgleisen (≥ 1 Zuglänge vor ${listDe(e)}), damit Züge je nach Ziel das richtige Gleis nehmen: ${parts.join(' · ')}.`, e);
    }
    for (const N of P.nodes) {
      if (!N.single || !N.lanes.some(L => L.strands.length)) continue;
      const e = P.signals.find(s => s.kind === 'E' && s.node === N), a = P.signals.find(s => s.kind === 'A' && s.node === N);
      add('info', `${nm(N)} ist eingleisig: ${e ? e.label : 'Einfahrsignal'} ohne Einbahn, ${a ? a.label : 'Ausfahrsignal'} vor der Spreizweiche. Auf der Strecke dahinter Ausweichen mit Signalen an beiden Enden einplanen.`, [e, a].filter(Boolean).map(s => s.label));
    }
    for (const N of P.nodes) {
      if (!N.dep.length && !N.arr.length) { add('info', `${nm(N)} hat noch keine Verbindung.`); continue; }
      const idle = N.single ? [] : N.lanes.filter(L => !L.strands.length);
      if (idle.length) add('info', `${nm(N)}: ${listDe(idle.map(L => 'G' + L.no))} ${idle.length > 1 ? 'werden' : 'wird'} nicht genutzt.`);
    }
    if (P.structures.length && P.structures.every(s => s.mode === 'bridge')) {
      add('ok', `Alle ${P.structures.length} Kreuzungsstellen sind kreuzungsfrei (Brücke oder Tunnel) – Fahrwege treffen sich nur noch an Weichen.`);
    }
    if (P.strands.length) add('info', 'Faustregel: Hinter jeder Weiche oder Kreuzung bis zum nächsten Signal mindestens eine Zuglänge Platz lassen; auf der Strecke Signale nicht dichter als eine Zuglänge setzen.');
  }

  // ───────────────────── Hilfen für Tests ─────────────────────
  function interleaved(a1, a2, b1, b2) {
    const x = G.wrap(a2 - a1), y1 = G.wrap(b1 - a1), y2 = G.wrap(b2 - a1);
    return (y1 > 1e-9 && y1 < x) !== (y2 > 1e-9 && y2 < x);
  }
  const pairKey = (a, b) => [a.id, b.id].sort().join(' × ');
  function topoCrossingPairs(P) {
    const out = [];
    for (let i = 0; i < P.strands.length; i++) for (let k = i + 1; k < P.strands.length; k++) {
      const a = P.strands[i], b = P.strands[k];
      if (interleaved(a.oAng, a.dAng, b.oAng, b.dAng)) out.push(pairKey(a, b));
    }
    return out.sort();
  }
  const geoCrossingPairs = (P) => P.crossings.map(x => pairKey(x.a, x.b)).sort();

  const api = {
    plan, normalizeModel, emptyModel, allocate, compositions, defaultInCount,
    PALETTE, colorName, WEIGHTS, C, interleaved, topoCrossingPairs, geoCrossingPairs,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.GP = root.GP || {};
  root.GP.planner = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
