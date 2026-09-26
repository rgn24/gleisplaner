/* Bahnhofsplaner – Planungslogik: Bahnsteiggleise + Streckengleise → Weichenstraßen, Gleiswechsel, Signale.
   DOM-frei; im Browser über GP.station, unter Node per require(). */
(function (root) {
  'use strict';
  const G = (typeof module !== 'undefined' && module.exports) ? require('./geometry.js') : root.GP.geo;

  // Maße in Zeichen-Einheiten (Punktraster = 20); der Plan ist schematisch
  const C = {
    ROW: 26,       // Abstand der Bahnsteiggleise
    S: 16,         // Abstand der Streckengleise
    PL: 520,       // Bahnsteiglänge
    SLOPE: 0.4,    // Querversatz je Längeneinheit in den Weichenstraßen
    MARGIN: 24,    // letzte Weiche → Bahnsteiganfang
    GAP: 16,       // Mindestabstand hintereinanderliegender Weichenstraßen
    STEP: 12,      // Suchschritt beim Zusammenschieben
    XO: 44,        // Länge eines Gleiswechsels
    XO_STEP: 54,   // Abstand der Gleiswechsel in der Leiter (≥ XO, sonst reißt die Kette)
    XO_GAP: 20,    // Gleiswechsel → erste Weiche
    SIG: 30,       // Einfahrsignal vor dem Gleiswechsel
    STAG: 18,      // Versatz der Signale benachbarter Gleise
    STUB: 110,     // Strecke außen
    A_OFF: 10,     // Ausfahrsignal hinter dem Bahnsteigende
    BUF: 14,       // Prellbock hinter dem Bahnsteigende
  };
  const TYPE_NAME = { P: 'Personen', G: 'Güter', PG: 'Personen + Güter' };
  const TYPE_SHORT = { P: 'P', G: 'G', PG: 'P+G' };
  const TYPE_COLOR = { P: '#4fb3ea', G: '#e0a13a' };
  const USE_NAME = { east: '→ nach rechts', west: '← nach links', both: '⇄ beide Richtungen', none: '–' };
  const SIDE_NAME = { left: 'links', right: 'rechts' };
  const uniq = (a) => [...new Set(a)];
  const listDe = (a) => (a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' und ' + a[a.length - 1]);
  const lexLess = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] ?? 0, y = b[i] ?? 0;
      if (Math.abs(x - y) > 1e-9) return x < y;
    }
    return false;
  };

  function emptyStation() {
    return {
      version: 1, kind: 'station', name: 'Bahnhof',
      settings: { traffic: 'right', layers: { tracks: true, signals: true, labels: true } },
      platforms: [], left: { tracks: [] }, right: { tracks: [] },
    };
  }

  function normalizeStation(input) {
    const src = JSON.parse(JSON.stringify(input || {}));
    const m = Object.assign(emptyStation(), src);
    m.kind = 'station';
    m.name = String(m.name || 'Bahnhof').slice(0, 40);
    m.settings = Object.assign(emptyStation().settings, src.settings || {});
    m.settings.layers = Object.assign(emptyStation().settings.layers, (src.settings && src.settings.layers) || {});
    if (m.settings.traffic !== 'left') m.settings.traffic = 'right';
    const ids = new Set();
    const uid = (want, fb) => { let id = String(want || fb); while (ids.has(id)) id += '_'; ids.add(id); return id; };
    m.platforms = (Array.isArray(src.platforms) ? src.platforms : []).slice(0, 16).map((p, i) => ({
      id: uid(p && p.id, 'p' + (i + 1)),
      type: p && p.type === 'G' ? 'G' : 'P',
      use: ['east', 'west', 'both'].includes(p && p.use) ? p.use : 'auto',
      left: p && typeof p.left === 'string' ? p.left : 'auto',     // festes Streckengleis links (Gleis-ID) oder auto
      right: p && typeof p.right === 'string' ? p.right : 'auto',
    }));
    for (const X of ['left', 'right']) {
      const t = src[X] && Array.isArray(src[X].tracks) ? src[X].tracks : [];
      m[X] = { tracks: t.slice(0, 8).map((x, i) => ({ id: uid(x && x.id, X[0] + (i + 1)), type: ['P', 'G'].includes(x && x.type) ? x.type : 'PG' })),
        xo: ['all', 'none'].includes(src[X] && src[X].xo) ? src[X].xo : 'auto' };   // Gleiswechsel vor dem Vorfeld
    }
    // feste Zuordnungen auf entfernte Streckengleise wieder automatisch
    for (const p of m.platforms) for (const X of ['left', 'right']) {
      if (p[X] !== 'auto' && !m[X].tracks.some(t => t.id === p[X])) p[X] = 'auto';
    }
    return m;
  }

  // Bahnsteiggleis an Streckengleise verteilen: obere Bahnsteiggleise an obere Streckengleise (monoton),
  // dann kreuzen sich die Weichenstraßen nicht. Bewertung: gleichmäßige Last, alle Gleise nutzen, kurze Wege.
  function assign(rows, lines, ok) {
    const map = new Map();
    const missing = rows.filter(r => !lines.some(l => ok(r, l)));
    const rs = rows.filter(r => !missing.includes(r));
    if (!rs.length) return { map, monotone: true, missing };
    const k = lines.length, cur = [];
    let best = null;
    const rec = (i, minJ) => {
      if (i === rs.length) {
        const load = new Array(k).fill(0);
        let dist = 0;
        cur.forEach((j, q) => { load[j]++; dist += Math.abs(rs[q].y - lines[j].y); });
        const score = [Math.max(...load), -load.filter(Boolean).length, dist];
        if (!best || lexLess(score, best.score)) best = { score, pick: cur.slice() };
        return;
      }
      for (let j = minJ; j < k; j++) if (ok(rs[i], lines[j])) { cur.push(j); rec(i + 1, j); cur.pop(); }
    };
    rec(0, 0);
    if (best) {
      best.pick.forEach((j, q) => map.set(rs[q], lines[j]));
      return { map, monotone: true, missing };
    }
    for (const r of rs) {
      const cand = lines.filter(l => ok(r, l)).sort((a, b) => Math.abs(a.y - r.y) - Math.abs(b.y - r.y));
      map.set(r, cand[0]);
    }
    return { map, monotone: false, missing };
  }

  function permutations(arr) {
    if (arr.length <= 1) return [arr.slice()];
    const out = [];
    arr.forEach((x, i) => {
      for (const p of permutations(arr.slice(0, i).concat(arr.slice(i + 1)))) out.push([x, ...p]);
    });
    return out;
  }

  // Richtung eines Bahnsteiggleises auf einer Seite: 'in' (Einfahrt), 'out' (Ausfahrt), 'any' (beides)
  function category(row, X) {
    if (row.use === 'both') return 'any';
    if (row.use === 'none') return null;
    if (X === 'left') return row.use === 'east' ? 'in' : 'out';
    return row.use === 'west' ? 'in' : 'out';
  }

  // Bahnsteiggleis hängt (fest gewählt) an einem Streckengleis der Gegenrichtung
  function against(r, X) {
    const c = category(r, X), l = r.at[X];
    return !!l && c !== 'any' && c !== null && l.dir !== c;
  }

  // Gleiswechsel vor dem Vorfeld. „alle ↔ alle“: zwei gegenläufige Ketten einfacher Weichenverbindungen –
  // abwärts (oberes → unteres Gleis) und aufwärts, jeweils in Fahrtrichtung zum Bahnhof nacheinander. So erreicht
  // jedes Streckengleis jedes andere, in beide Richtungen, ohne Kreuzungsweichen. Gleiche Paare im selben
  // Abschnitt werden zum gekreuzten Gleiswechsel zusammengefasst.
  function planZone(S, X) {
    const sd = S.sides[X], m = S.model;
    const sorted = sd.lines.slice().sort((a, b) => a.y - b.y);
    const hasAny = S.rows.some(r => r.at[X] && category(r, X) === 'any');
    const anyAgainst = S.rows.some(r => against(r, X));
    sd.hasAny = hasAny;
    sd.zoneNeeded = hasAny || anyAgainst;
    let lines = [];
    if (m[X].xo === 'all') lines = sorted;
    else if (m[X].xo === 'auto') {
      if (sd.zoneNeeded) lines = sorted;
      else {
        // Vorsortieren: dieselben Züge können auf mehreren Einfahrgleisen kommen, die zu anderen Bahnsteigen führen
        const ins = sorted.filter(l => l.dir === 'in');
        const key = (l) => l.rows.map(r => r.id).sort().join(',');
        const share = (a, b) => a.type === 'PG' || b.type === 'PG' || a.type === b.type;
        const presort = ins.some((l, i) => i + 1 < ins.length && key(l) !== key(ins[i + 1]) && share(l, ins[i + 1]));
        if (presort) lines = ins;
      }
    }
    sd.zone = [];
    const n = lines.length;
    for (let p = 0; p + 1 < n; p++) sd.zone.push({ kind: 'down', p, a: lines[p], b: lines[p + 1], slot: p });
    // Aufwärtskette in umgekehrter Reihenfolge; bei ungerader Gleiszahl um einen halben Abschnitt versetzt,
    // sonst träfen sich zwei Gleiswechsel am selben Punkt eines Gleises
    for (let p = 0; p + 1 < n; p++) sd.zone.push({ kind: 'up', p, a: lines[p], b: lines[p + 1], slot: n - 2 - p + (n % 2 ? 0.5 : 0) });
  }

  // Schnittpunkte zweier Elementlisten (je Element ein gerades Stück), gemeinsame Weichenpunkte ausgenommen
  function crossingsBetween(A, B, collect) {
    let n = 0;
    for (const a of A) {
      for (const b of B) {
        if (a === b) continue;
        const h = G.segX(a.pts[0], a.pts[1], b.pts[0], b.pts[1]);
        if (!h) continue;
        const near = (js) => js.some(j => G.dist(j, h.p) < 3);
        if (near(a.joints) && near(b.joints)) continue;
        n++;
        if (collect) collect.push({ a, b, p: h.p });
      }
    }
    return n;
  }

  // Weichenstraßen einer Seite anordnen. Lokale Koordinaten: x = 0 am Bahnsteigende, negativ nach außen.
  // Jede Leiter beginnt auf ihrem Streckengleis (x0) und fächert schräg auf ihre Bahnsteiggleise auf.
  // Reihenfolge und Lage werden so gesucht, dass möglichst nichts kreuzt und das Vorfeld kurz bleibt.
  function layoutSide(S, X) {
    const sd = S.sides[X];
    sd.ladders = sd.lines.filter(l => l.rows.length).map(l => {
      const rows = l.rows.slice().sort((a, b) => a.y - b.y);
      const up = rows.filter(r => r.y < l.y - 0.5);
      const down = rows.filter(r => r.y > l.y + 0.5);
      const level = rows.filter(r => Math.abs(r.y - l.y) <= 0.5);
      const extUp = up.length ? (l.y - up[0].y) / C.SLOPE : 0;
      const extDown = down.length ? (down[down.length - 1].y - l.y) / C.SLOPE : 0;
      return { line: l, side: X, rows, up, down, level, extUp, extDown, ext: Math.max(extUp, extDown, 18), x0: 0,
        bidi: rows.some(r => category(r, X) === 'any' || against(r, X)) };
    });
    const attach = (L, x0, r) => ({ x: x0 + Math.abs(r.y - L.line.y) / C.SLOPE, y: r.y });
    const elems = (L, x0, xFar) => {
      const y = L.line.y, j0 = { x: x0, y }, out = [];
      out.push({ kind: 'line', L, pts: [{ x: xFar, y }, j0], joints: [j0] });
      if (L.up.length) out.push({ kind: 'diag', L, pts: [j0, attach(L, x0, L.up[0])], joints: [j0, ...L.up.map(r => attach(L, x0, r))] });
      if (L.down.length) out.push({ kind: 'diag', L, pts: [j0, attach(L, x0, L.down[L.down.length - 1])], joints: [j0, ...L.down.map(r => attach(L, x0, r))] });
      for (const r of L.rows) {
        const a = attach(L, x0, r);
        out.push({ kind: 'row', L, r, pts: [a, { x: 0, y: r.y }], joints: [a] });
      }
      return out;
    };
    sd.attach = attach;
    const ladders = sd.ladders;
    if (ladders.length) {
      const place = (order) => {
        const placed = [];
        let total = 0, minX0 = -C.MARGIN;
        for (const L of order) {
          const closest = -C.MARGIN - L.ext;
          const limit = Math.min(closest, minX0 - C.GAP - L.ext);   // spätestens ganz hintereinander
          let best = null;
          for (let x0 = closest; ; x0 = Math.max(limit, x0 - C.STEP)) {
            const e = elems(L, x0, -1e4);
            const c = crossingsBetween(e, placed);
            if (!best || c < best.c) best = { x0, c, e };
            if (c === 0 || x0 <= limit) break;
          }
          L.x0 = best.x0;
          placed.push(...best.e);
          total += best.c;
          minX0 = Math.min(minX0, best.x0);
        }
        return { total, length: -minX0 };
      };
      const orders = ladders.length <= 5 ? permutations(ladders) : [ladders.slice().sort((a, b) => a.ext - b.ext)];
      let best = null;
      for (const ord of orders) {
        const r = place(ord);
        if (!best || r.total < best.total || (r.total === best.total && r.length < best.length - 1e-6)) {
          best = { total: r.total, length: r.length, x0: new Map(ord.map(L => [L, L.x0])) };
        }
      }
      ladders.forEach(L => { L.x0 = best.x0.get(L); });
    }
    sd.xs = ladders.length ? Math.min(...ladders.map(L => L.x0)) : -C.MARGIN;   // Beginn des Vorfelds
    planZone(S, X);
    const zoneLen = sd.zone.length ? Math.max(...sd.zone.map(o => o.slot)) * C.XO_STEP + C.XO : 0;
    sd.xXo1 = sd.xs - C.XO_GAP;                  // Gleiswechsel innen
    sd.xXo0 = sd.xXo1 - zoneLen;                 // Gleiswechsel außen
    sd.zone.forEach(o => { o.x = sd.xXo0 + o.slot * C.XO_STEP; });
    sd.xSig = sd.xXo0 - C.SIG;                   // Einfahrsignale
    sd.xSplit = sd.xSig - 30;                    // Spreizweiche eingleisiger Strecken
    sd.xFar = sd.xSig - C.STAG * sd.lines.length - 40 - C.STUB;
    // endgültige Elemente (Strecke nur bis zum Streckenende) und ihre Kreuzungen
    const all = [];
    for (const L of ladders) all.push(...elems(L, L.x0, sd.single ? sd.xSplit + 24 : sd.xFar));
    for (const l of sd.lines.filter(x => !x.rows.length)) {
      const end = { x: sd.xXo1, y: l.y };
      all.push({ kind: 'line', L: { line: l }, pts: [{ x: sd.single ? sd.xSplit + 24 : sd.xFar, y: l.y }, end], joints: [end] });
    }
    sd.elements = all;
    const found = [];
    for (let i = 0; i < all.length; i++) crossingsBetween([all[i]], all.slice(i + 1), found);
    sd.crossings = found;
  }

  // ───────────────────────────── Hauptfunktion ─────────────────────────────
  function plan(input) {
    const m = normalizeStation(input);
    const side = m.settings.traffic === 'left' ? -1 : 1;
    const n = m.platforms.length;
    const yc = (n - 1) * C.ROW / 2;
    const hasL = m.left.tracks.length > 0, hasR = m.right.tracks.length > 0;
    const S = {
      model: m, side, C, yc, kind: hasL && hasR ? 'through' : (hasL || hasR) ? 'terminus' : 'none',
      rows: [], sides: {}, lines: [], paths: [], switches: [], crossovers: [], crossings: [], signals: [],
      buffers: [], notes: [], guide: { build: [], rows: [], lines: [], switches: [], crossings: [], signals: [] }, stats: {},
    };

    // 1) Nutzung der Bahnsteiggleise: Durchgangsbahnhof = Richtungsgleise (Rechtsverkehr: oben nach links,
    //    unten nach rechts), Kopfbahnhof = alle Gleise in beide Richtungen (Züge wenden)
    const top = side > 0 ? 'west' : 'east', bottom = side > 0 ? 'east' : 'west';
    S.rows = m.platforms.map((p, i) => {
      let use = p.use;
      if (S.kind === 'terminus') use = 'both';
      else if (S.kind === 'none') use = 'none';
      else if (use === 'auto') use = i < Math.floor(n / 2) ? top : i >= Math.ceil(n / 2) ? bottom : 'both';
      return { id: p.id, idx: i, no: i + 1, type: p.type, set: p.use, use, y: i * C.ROW,
        at: { left: null, right: null }, pick: { left: p.left, right: p.right }, manual: { left: false, right: false } };
    });

    // 2) Streckengleise: in Fahrtrichtung zum Bahnhof rechts liegen die Einfahrgleise
    for (const X of ['left', 'right']) {
      const tracks = m[X].tracks, k = tracks.length;
      const inBelow = (X === 'left' ? 1 : -1) * side > 0;
      let lines = [];
      if (k === 1) {
        const t = tracks[0], d = C.S / 2;
        const mk = (dir, y) => ({ id: `${t.id}:${dir}`, trackId: t.id, side: X, no: 1, name: `${X === 'left' ? 'L' : 'R'}1`, type: t.type, y, dir, rows: [], virtual: true });
        lines = [mk(inBelow ? 'out' : 'in', yc - d), mk(inBelow ? 'in' : 'out', yc + d)];
      } else if (k > 1) {
        const inCount = Math.ceil(k / 2);
        lines = tracks.map((t, j) => ({ id: t.id, trackId: t.id, side: X, no: j + 1, name: `${X === 'left' ? 'L' : 'R'}${j + 1}`,
          type: t.type, y: yc + (j - (k - 1) / 2) * C.S, dir: inBelow ? (j >= k - inCount ? 'in' : 'out') : (j < inCount ? 'in' : 'out'), rows: [] }));
      }
      S.sides[X] = { X, lines, k, single: k === 1, inBelow, ladders: [], crossings: [], elements: [], missing: [], monotone: true };
      S.lines.push(...lines);
    }

    // 3) Bahnsteiggleise den Streckengleisen zuordnen (Richtung und Zugart müssen passen)
    for (const X of ['left', 'right']) {
      const sd = S.sides[X];
      if (!sd.lines.length) continue;
      const need = S.rows.filter(r => category(r, X));
      // Fest gewählte Streckengleise gelten – auch gegen Richtung oder Zugart (dann mit Hinweis)
      const fixed = new Map();
      for (const r of need) {
        if (r.pick[X] === 'auto') continue;
        const cand = sd.lines.filter(l => l.trackId === r.pick[X]);
        const c = category(r, X);
        if (cand.length) fixed.set(r, cand.find(l => c === 'any' || l.dir === c) || cand[0]);
      }
      const res = assign(need.filter(r => !fixed.has(r)), sd.lines, (r, l) => {
        const c = category(r, X);
        return (c === 'any' || l.dir === c) && (l.type === 'PG' || l.type === r.type);
      });
      sd.monotone = res.monotone;
      sd.missing = res.missing;
      for (const [r, l] of fixed) { r.at[X] = l; r.manual[X] = true; l.rows.push(r); }
      for (const [r, l] of res.map) { r.at[X] = l; l.rows.push(r); }
    }

    // 4) Geometrie je Seite
    for (const X of ['left', 'right']) if (S.sides[X].lines.length) layoutSide(S, X);
    buildGlobal(S);
    buildSignals(S);
    finish(S);
    return S;
  }

  // Zeichenwege, Weichen, Gleiswechsel und Kreuzungen in Bahnhofskoordinaten
  // (x = 0 … PL ist der Bahnsteig, links negativ, rechts > PL)
  function buildGlobal(S) {
    const gx = (X, x) => (X === 'left' ? x : C.PL - x);
    const gp = (X, p) => ({ x: gx(X, p.x), y: p.y });
    S.gp = gp;
    // Bahnsteiggleise durchgehend: Vorfeld links – Bahnsteig – Vorfeld rechts (oder Prellbock)
    for (const r of S.rows) {
      const ends = {};
      for (const X of ['left', 'right']) {
        const sd = S.sides[X], l = r.at[X];
        if (l) {
          const L = sd.ladders.find(q => q.line === l);
          ends[X] = gp(X, sd.attach(L, L.x0, r));
        } else {
          ends[X] = gp(X, { x: -C.BUF, y: r.y });
          S.buffers.push({ row: r, side: X, p: ends[X], dir: X === 'left' ? G.v(-1, 0) : G.v(1, 0) });
        }
      }
      let pts = G.concat([ends.left, { x: 0, y: r.y }, { x: C.PL, y: r.y }, ends.right]);
      if (r.use === 'west') pts = pts.slice().reverse();
      S.paths.push({ kind: 'row', row: r, pts, dir: r.use === 'east' || r.use === 'west' ? 'one' : r.use === 'both' ? 'both' : 'none',
        color: TYPE_COLOR[r.type], ref: `row:${r.id}` });
    }
    for (const X of ['left', 'right']) {
      const sd = S.sides[X];
      if (!sd.lines.length) continue;
      const hasAny = sd.zoneNeeded;
      const start = sd.single ? sd.xSplit + 24 : sd.xFar;
      for (const l of sd.lines) {
        const L = sd.ladders.find(q => q.line === l);
        const xEnd = L ? L.x0 : sd.xXo1;
        const part = (a, b) => {
          let pts = [{ x: a, y: l.y }, { x: b, y: l.y }].map(p => gp(X, p));
          if (l.dir === 'out') pts = pts.reverse();
          return pts;
        };
        const color = TYPE_COLOR[l.type] || null, ref = `line:${X}:${l.id}`;
        const unused = !L && !sd.zone.some(o => o.a === l || o.b === l);   // über die Gleiswechsel erreichbar = genutzt
        S.paths.push({ kind: 'line', line: l, side: X, pts: part(start, sd.xXo0 - 8), dir: 'one', color, ref, unused });
        S.paths.push({ kind: 'line', line: l, side: X, pts: part(sd.xXo0 - 8, xEnd), dir: hasAny ? 'both' : 'one', color, ref, unused });
      }
      if (sd.single) {
        const col = TYPE_COLOR[sd.lines[0].type] || null, ref = `line:${X}:${sd.lines[0].trackId}`;
        S.paths.push({ kind: 'line', side: X, pts: [{ x: sd.xFar, y: S.yc }, { x: sd.xSplit, y: S.yc }].map(p => gp(X, p)), dir: 'both', color: col, ref });
        for (const l of sd.lines) {
          let pts = [{ x: sd.xSplit, y: S.yc }, { x: sd.xSplit + 24, y: l.y }].map(p => gp(X, p));
          if (l.dir === 'out') pts = pts.reverse();
          S.paths.push({ kind: 'line', line: l, side: X, pts, dir: 'one', color: col, ref: `line:${X}:${l.id}` });
        }
      }
      // Weichenstraßen: schräge Gleise von jedem Streckengleis zu seinen Bahnsteiggleisen
      for (const L of sd.ladders) {
        const j0 = { x: L.x0, y: L.line.y };
        for (const grp of [L.up, L.down]) {
          if (!grp.length) continue;
          const far = grp === L.up ? grp[0] : grp[grp.length - 1];
          let pts = [j0, sd.attach(L, L.x0, far)].map(p => gp(X, p));
          const cat = L.bidi ? 'both' : L.line.dir;
          if (cat === 'out') pts = pts.reverse();
          S.paths.push({ kind: 'diag', ladder: L, side: X, pts, dir: cat === 'both' ? 'both' : 'one', color: TYPE_COLOR[L.line.type] || null,
            ref: `line:${X}:${L.line.id}` });
        }
      }
      // Gleiswechsel-Leiter: je Paar und Abschnitt ein einfacher oder gekreuzter Gleiswechsel
      const bySlot = new Map();
      for (const o of sd.zone) {
        const k = `${o.p}@${o.slot}`;
        if (!bySlot.has(k)) bySlot.set(k, []);
        bySlot.get(k).push(o);
      }
      for (const group of bySlot.values()) {
        const { a, b, x } = group[0];
        const segs = group.map(o => (o.kind === 'down'
          ? [{ x, y: a.y }, { x: x + C.XO, y: b.y }]
          : [{ x, y: b.y }, { x: x + C.XO, y: a.y }]).map(q => gp(X, q)));
        S.crossovers.push({ side: X, a, b, segs, scissors: group.length > 1, center: gp(X, { x: x + C.XO / 2, y: (a.y + b.y) / 2 }) });
      }
      // Weichen: Spreizweiche, Gleiswechsel, dann die Weichenstraßen von außen nach innen
      const sw = (p, text, kind, weichen) => S.switches.push({ side: X, p, text, kind, weichen });
      if (sd.single) sw(gp(X, { x: sd.xSplit, y: S.yc }), `${SIDE_NAME[X]}: Spreizweiche – die eingleisige Strecke teilt sich in Ein- und Ausfahrgleis`, 'split', 1);
      const xo = S.crossovers.filter(q => q.side === X);
      const ladder = xo.length > 1 ? ' – Teil der Gleiswechsel-Leiter' : '';
      for (const c of xo) {
        sw(c.center, c.scissors ? `${SIDE_NAME[X]}: gekreuzter Gleiswechsel ${c.a.name} ↔ ${c.b.name} (4 Weichen)${ladder}`
          : `${SIDE_NAME[X]}: Gleiswechsel ${c.a.name} ↔ ${c.b.name} (2 Weichen)${ladder}`, 'crossover', c.scissors ? 4 : 2);
      }
      for (const L of sd.ladders.slice().sort((a, b) => a.x0 - b.x0)) {
        const nos = (g) => g.map(r => r.no).join(', ');
        const parts = [];
        if (L.level.length) parts.push(`geradeaus Gleis ${nos(L.level)}`);
        if (L.up.length) parts.push(`nach oben Gleis ${nos(L.up)}`);
        if (L.down.length) parts.push(`nach unten Gleis ${nos(L.down)}`);
        if (parts.length >= 2) sw(gp(X, { x: L.x0, y: L.line.y }), `${L.line.name}: teilt sich – ${parts.join(', ')}`, 'split', parts.length - 1);
        for (const grp of [L.up, L.down]) {
          const ord = grp.slice().sort((a, b) => Math.abs(a.y - L.line.y) - Math.abs(b.y - L.line.y));
          ord.slice(0, -1).forEach(r => sw(gp(X, sd.attach(L, L.x0, r)), `${L.line.name}: Abzweig zu Gleis ${r.no}`, 'branch', 1));
        }
      }
      const describe = (e) => (e.kind === 'line' ? `Streckengleis ${e.L.line.name}` : e.kind === 'diag' ? `Weichenstraße von ${e.L.line.name}` : `Zulauf Gleis ${e.r.no}`);
      for (const c of sd.crossings) S.crossings.push({ side: X, p: gp(X, c.p), text: `${describe(c.a)} × ${describe(c.b)}` });
    }
  }

  function buildSignals(S) {
    const inward = (X) => (X === 'left' ? G.v(1, 0) : G.v(-1, 0));
    const outward = (X) => G.mul(inward(X), -1);
    for (const X of ['left', 'right']) {
      const sd = S.sides[X];
      if (!sd.lines.length || !sd.ladders.length) continue;
      const gp = (p) => S.gp(X, p);
      if (sd.single) {
        const inL = sd.lines.find(l => l.dir === 'in'), outL = sd.lines.find(l => l.dir === 'out');
        S.signals.push({ kind: 'E', side: X, line: inL, p: gp({ x: sd.xSplit - 24, y: S.yc }), dir: inward(X), oneWay: false });
        S.signals.push({ kind: 'B', side: X, line: outL, p: gp({ x: sd.xSplit + 16, y: outL.y }), dir: outward(X), oneWay: true });
      } else {
        sd.lines.filter(l => l.dir === 'in').forEach((l, i) =>
          S.signals.push({ kind: 'E', side: X, line: l, p: gp({ x: sd.xSig - i * C.STAG, y: l.y }), dir: inward(X), oneWay: true }));
        sd.lines.filter(l => l.dir === 'out').forEach((l, i) =>
          S.signals.push({ kind: 'B', side: X, line: l, p: gp({ x: sd.xSig - 24 - i * C.STAG, y: l.y }), dir: outward(X), oneWay: true }));
      }
      for (const r of S.rows) {
        if (!r.at[X]) continue;
        const cat = category(r, X);
        if (cat === 'out' || cat === 'any') S.signals.push({ kind: 'A', side: X, row: r, p: gp({ x: -C.A_OFF, y: r.y }), dir: outward(X), oneWay: cat === 'out' });
      }
    }
  }

  // ───────────────────── Nummerierung, Bauanleitung, Hinweise ─────────────────────
  function finish(S) {
    S.switches.forEach((w, i) => { w.label = `W${i + 1}`; });
    S.crossings.sort((a, b) => (a.side === b.side ? a.p.x - b.p.x : a.side === 'left' ? -1 : 1));
    S.crossings.forEach((c, i) => { c.label = `K${i + 1}`; });
    const kindOrder = { E: 0, A: 1, B: 2 };
    S.signals.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || (a.side === b.side ? a.p.y - b.p.y : a.side === 'left' ? -1 : 1));
    const cnt = { E: 0, A: 0, B: 0 };
    S.signals.forEach(sg => { sg.label = sg.kind + (++cnt[sg.kind]); });

    const g = S.guide;
    const lineName = (l, r, X) => (l ? l.name + (r && r.manual[X] ? ' (fest)' : '') : '–');
    g.rows = S.rows.map(r => {
      let sub;
      if (r.use === 'east') sub = `Einfahrt links über ${lineName(r.at.left, r, 'left')} · Ausfahrt rechts über ${lineName(r.at.right, r, 'right')}`;
      else if (r.use === 'west') sub = `Einfahrt rechts über ${lineName(r.at.right, r, 'right')} · Ausfahrt links über ${lineName(r.at.left, r, 'left')}`;
      else if (r.use === 'both' && S.kind === 'terminus') {
        const X = r.at.left ? 'left' : 'right';
        sub = `Ein- und Ausfahrt ${SIDE_NAME[X]} über ${lineName(r.at[X], r, X)}, Züge wenden`;
      } else if (r.use === 'both') sub = `links über ${lineName(r.at.left, r, 'left')} · rechts über ${lineName(r.at.right, r, 'right')}`;
      else sub = 'noch keine Streckengleise';
      return { ref: `row:${r.id}`, colors: [TYPE_COLOR[r.type]], title: `Gleis ${r.no} · ${TYPE_NAME[r.type]} · ${USE_NAME[r.use]}${r.set === 'auto' ? '' : ' (fest)'}`, text: sub };
    });
    g.lines = [];
    for (const X of ['left', 'right']) {
      for (const l of S.sides[X].lines) {
        const nos = l.rows.map(r => r.no);
        g.lines.push({ ref: `line:${X}:${l.id}`, colors: TYPE_COLOR[l.type] ? [TYPE_COLOR[l.type]] : [],
          title: `${l.name} · ${l.dir === 'in' ? 'Einfahrt' : 'Ausfahrt'} · ${TYPE_SHORT[l.type]}${l.virtual ? ' (eingleisig)' : ''}`,
          text: nos.length ? `${l.dir === 'in' ? 'zu' : 'von'} Gleis ${nos.join(', ')}` : 'wird nicht genutzt' });
      }
    }
    g.switches = S.switches.map(w => ({ ref: w.label, label: w.label, text: w.text }));
    g.crossings = S.crossings.map(c => ({ ref: c.label, label: c.label, text: `${SIDE_NAME[c.side]}: ${c.text} – flach` }));
    g.signals = S.signals.map(sg => {
      let place, dir, cond;
      if (sg.kind === 'E') {
        place = `${SIDE_NAME[sg.side]}: Streckengleis ${sg.line.name} – Einfahrt`;
        dir = 'in den Bahnhof';
        cond = sg.oneWay ? 'vor Gleiswechsel und erster Weiche; davor ≥ 1 Zuglänge Warteplatz' : 'eingleisige Strecke – ausfahrende Züge passieren es von hinten';
      } else if (sg.kind === 'A') {
        place = `Gleis ${sg.row.no} – Ende ${SIDE_NAME[sg.side]}`;
        dir = `Ausfahrt nach ${SIDE_NAME[sg.side]}`;
        cond = sg.oneWay ? 'am Bahnsteigende vor der ersten Weiche' : 'Gleis in beide Richtungen – einfahrende Züge passieren es von hinten';
      } else {
        place = `${SIDE_NAME[sg.side]}: Streckengleis ${sg.line.name} – Ausfahrt`;
        dir = 'aus dem Bahnhof';
        cond = '≥ 1 Zuglänge hinter der letzten Weiche';
      }
      return { label: sg.label, ref: sg.label, kind: sg.kind, place, dir, oneWay: sg.oneWay, cond, angle: G.toDeg(G.angleOf(sg.dir)) };
    });
    const range = (list) => (list.length ? (list.length === 1 ? list[0].label : `${list[0].label}–${list[list.length - 1].label}`) : '');
    const nP = S.rows.filter(r => r.type === 'P').length, nG = S.rows.length - nP;
    g.build = [];
    if (S.rows.length) {
      g.build.push({ title: 'Bahnsteiggleise und Bahnsteige', refs: S.rows.map(r => `row:${r.id}`),
        text: `${S.rows.length} Gleise nebeneinander, von oben: ${S.rows.map(r => TYPE_SHORT[r.type]).join(' · ')} (${nP} Personen, ${nG} Güter).` });
    }
    const sidesUsed = ['left', 'right'].filter(X => S.sides[X].lines.length);
    if (sidesUsed.length) {
      g.build.push({ title: 'Streckengleise', refs: S.lines.map(l => `line:${l.side}:${l.id}`),
        text: sidesUsed.map(X => `${SIDE_NAME[X]} ${S.sides[X].k} ${S.sides[X].k === 1 ? 'Gleis (eingleisig)' : 'Gleise'}`).join(', ') + '.' });
    }
    for (const X of sidesUsed) {
      const sw = S.switches.filter(w => w.side === X);
      if (!sw.length) continue;
      const w = sw.reduce((s, x) => s + x.weichen, 0);
      g.build.push({ title: `Weichenstraßen ${SIDE_NAME[X]}`, refs: sw.map(x => x.label),
        text: `${range(sw)} (${w} ${w === 1 ? 'Weiche' : 'Weichen'}) – von außen nach innen bauen, jede Leiter schräg vom Streckengleis zu ihren Bahnsteiggleisen.` });
    }
    if (S.crossings.length) {
      g.build.push({ title: 'Flachkreuzungen im Vorfeld', refs: S.crossings.map(c => c.label), text: `${range(S.crossings)} – ebenerdig kreuzen.` });
    }
    if (S.signals.length) {
      const c = (k) => S.signals.filter(sg => sg.kind === k).length;
      g.build.push({ title: 'Signale setzen', refs: S.signals.map(sg => sg.label),
        text: `${c('E')} Einfahr-, ${c('A')} Ausfahr- und ${c('B')} Blocksignale – Ort, Richtung und Einbahn stehen unter „Signale“.` });
    }

    // Hinweise
    const seen = new Set();
    const add = (level, text, refs) => { if (!seen.has(text)) { seen.add(text); S.notes.push({ level, text, refs: refs || [] }); } };
    if (!S.rows.length) add('info', 'Noch keine Bahnsteiggleise – links unter „Bahnsteiggleise“ Personen- oder Gütergleise anlegen.');
    if (S.kind === 'none' && S.rows.length) add('info', 'Noch keine Streckengleise – links und/oder rechts Gleise anlegen. Nur eine Seite = Kopfbahnhof.');
    const xoLabels = (X) => S.switches.filter(w => w.kind === 'crossover' && (!X || w.side === X)).map(w => w.label);
    if (S.kind === 'terminus') add('info', 'Kopfbahnhof: Züge wenden am Bahnsteig. Alle Bahnsteiggleise werden in beide Richtungen genutzt; die Gleiswechsel vor dem Vorfeld lassen jedes Streckengleis jedes andere erreichen.', xoLabels());
    for (const X of ['left', 'right']) {
      const sd = S.sides[X];
      for (const r of sd.missing) {
        const cat = category(r, X);
        add('error', `Gleis ${r.no} (${TYPE_NAME[r.type]}, ${USE_NAME[r.use]}) findet ${SIDE_NAME[X]} kein passendes ${cat === 'in' ? 'Einfahrgleis' : cat === 'out' ? 'Ausfahrgleis' : 'Streckengleis'} – dort ein Streckengleis auf „${TYPE_SHORT[r.type]}“ oder „P+G“ stellen.`, [`row:${r.id}`]);
      }
      // fest gewählte Streckengleise: Zugart und Richtung prüfen
      for (const r of S.rows) {
        if (!r.manual[X]) continue;
        const l = r.at[X], c = category(r, X);
        const refs = [`row:${r.id}`, `line:${X}:${l.id}`];
        if (!(l.type === 'PG' || l.type === r.type)) {
          add('warn', `Gleis ${r.no} (${TYPE_NAME[r.type]}) hängt ${SIDE_NAME[X]} fest an ${l.name} (nur ${TYPE_NAME[l.type]}) – dort kommen keine ${r.type === 'G' ? 'Güterzüge' : 'Personenzüge'} an, außer über den Gleiswechsel.`, refs);
        }
        if (against(r, X)) {
          add(sd.zone.length ? 'info' : 'warn', sd.zone.length
            ? `Gleis ${r.no}: ${c === 'in' ? 'Einfahrten' : 'Ausfahrten'} ${SIDE_NAME[X]} laufen fest über ${l.name}, eigentlich ein ${l.dir === 'in' ? 'Einfahr' : 'Ausfahr'}gleis – die Züge wechseln im Gleiswechsel vor dem Vorfeld und fahren bis zum Bahnsteig gegen die Regelrichtung.`
            : `Gleis ${r.no}: ${l.name} ist ein ${l.dir === 'in' ? 'Einfahr' : 'Ausfahr'}gleis – ohne Gleiswechsel kommen die Züge dort nicht hin. „Gleiswechsel“ ${SIDE_NAME[X]} auf „auto“ oder „alle ↔ alle“ stellen.`, refs);
        }
      }
      if (S.model[X].xo === 'none' && sd.zoneNeeded) {
        add('warn', `${SIDE_NAME[X][0].toUpperCase() + SIDE_NAME[X].slice(1)} sind die Gleiswechsel abgeschaltet, obwohl Gleise in beide Richtungen oder gegen die Regelrichtung genutzt werden – so erreichen nicht alle Züge ihr Gleis.`, sd.lines.map(l => `line:${X}:${l.id}`));
      }
      if (!sd.monotone) add('warn', `${SIDE_NAME[X][0].toUpperCase() + SIDE_NAME[X].slice(1)} passen Lage und Zugarten nicht zusammen – deshalb kreuzen sich Weichenstraßen. Tipp: Bahnsteiggleise so sortieren, dass sie neben den passenden Streckengleisen liegen (z. B. Güter außen).`, sd.lines.map(l => `line:${X}:${l.id}`));
      const ks = S.crossings.filter(c => c.side === X);
      if (ks.length) add('warn', `${SIDE_NAME[X][0].toUpperCase() + SIDE_NAME[X].slice(1)} ${ks.length === 1 ? 'kreuzt sich eine Weichenstraße' : `kreuzen sich Weichenstraßen ${ks.length}-mal`} ebenerdig (${ks.map(c => c.label).join(', ')}) – Züge müssen sich dort abwechseln.`, ks.map(c => c.label));
      const idle = sd.lines.filter(l => !l.rows.length && !sd.zone.some(o => o.a === l || o.b === l));
      if (idle.length && sd.ladders.length) add('info', `${listDe(idle.map(l => l.name))} ${idle.length > 1 ? 'werden' : 'wird'} nicht genutzt – keine passenden Bahnsteiggleise.`, idle.map(l => `line:${X}:${l.id}`));
    }
    if (S.kind === 'through') {
      for (const r of S.rows.filter(q => q.use === 'both')) {
        add('info', `Gleis ${r.no} wird in beide Richtungen genutzt – Ausfahrsignale an beiden Enden ohne Einbahn.`, [`row:${r.id}`]);
      }
      for (const [use, txt] of [['east', 'nach rechts'], ['west', 'nach links']]) {
        if (!S.rows.some(r => r.use === use || r.use === 'both')) add('warn', `Kein Bahnsteiggleis für Züge ${txt} – bei einem Gleis die Richtung umstellen.`);
      }
    }
    if (S.rows.length && S.kind !== 'none') {
      add('info', 'Faustregel: Bahnsteige mindestens so lang wie der längste Zug; vor jedem Einfahrsignal ≥ 1 Zuglänge Platz ohne Weiche; Blocksignale B ≥ 1 Zuglänge hinter der letzten Weiche.');
    }
    S.stats = {
      rows: S.rows.length, lines: S.lines.filter(l => !l.virtual).length + (['left', 'right'].filter(X => S.sides[X].single).length),
      switches: S.switches.reduce((s, w) => s + w.weichen, 0), crossings: S.crossings.length, signals: S.signals.length,
    };
  }

  const EXAMPLES = [
    { id: 'durchgang', title: 'Durchgangsbahnhof (6 Gleise, 4-gleisige Strecken)', model: {
      name: 'Hauptbahnhof', settings: { traffic: 'right' },
      platforms: [{ type: 'G' }, { type: 'P' }, { type: 'P' }, { type: 'P' }, { type: 'P' }, { type: 'G' }],
      left: { tracks: [{ type: 'G' }, { type: 'P' }, { type: 'P' }, { type: 'G' }] },
      right: { tracks: [{ type: 'G' }, { type: 'P' }, { type: 'P' }, { type: 'G' }] } } },
    { id: 'kopf', title: 'Kopfbahnhof (4 Gleise)', model: {
      name: 'Kopfbahnhof', settings: { traffic: 'right' },
      platforms: [{ type: 'P' }, { type: 'P' }, { type: 'P' }, { type: 'P' }],
      left: { tracks: [{ type: 'PG' }, { type: 'PG' }] }, right: { tracks: [] } } },
    { id: 'kreuzung', title: 'Kreuzungsbahnhof an eingleisiger Strecke', model: {
      name: 'Ausweiche', settings: { traffic: 'right' },
      platforms: [{ type: 'P' }, { type: 'P' }],
      left: { tracks: [{ type: 'PG' }] }, right: { tracks: [{ type: 'PG' }] } } },
  ];
  const example = (id) => { const e = EXAMPLES.find(x => x.id === id); return e ? normalizeStation(e.model) : null; };

  const api = { plan, normalizeStation, emptyStation, assign, category, permutations, C, TYPE_NAME, TYPE_SHORT, TYPE_COLOR, USE_NAME, SIDE_NAME, EXAMPLES, example };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.GP = root.GP || {};
  root.GP.station = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
