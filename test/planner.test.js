// Tests für die Planungslogik:  node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../js/geometry.js');
const PL = require('../js/planner.js');
const EX = require('../js/examples.js');

const names = (L) => L.strands.map(s => s.flow.to.name).sort();
const sources = (L) => L.strands.map(s => s.flow.from.name).sort();
const lane = (P, node, no) => P.nodes.find(N => N.name === node).lanes.find(L => L.no === no && (!L.single));

// kleiner deterministischer Zufallsgenerator
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function randomModel(seed) {
  const r = rng(seed);
  const n = 3 + Math.floor(r() * 5);
  const nodes = [];
  const base = r() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = base + (i / n) * Math.PI * 2 + (r() - 0.5) * (Math.PI / n) * 0.8;
    const d = 380 + r() * 260;
    nodes.push({ id: 'n' + i, name: 'N' + i, x: Math.round(600 + Math.cos(a) * d), y: Math.round(600 + Math.sin(a) * d),
      tracks: 1 + Math.floor(r() * 6), inCount: null, dir: null });
  }
  const connections = [];
  for (let i = 0; i < n; i++) for (let k = i + 1; k < n; k++) {
    if (r() < 0.55) connections.push({ id: `c${i}_${k}`, a: 'n' + i, b: 'n' + k, weight: 1 + Math.floor(r() * 3) });
  }
  return { settings: { traffic: r() < 0.5 ? 'right' : 'left' }, nodes, connections };
}

// Schnittpunkte der kompletten Strangverläufe (ohne gemeinsame Weichenpunkte)
function fullPathCrossings(P) {
  let count = 0;
  const S = P.strands;
  for (let i = 0; i < S.length; i++) for (let k = i + 1; k < S.length; k++) {
    const a = S[i], b = S[k];
    const joints = [a.path[0], a.path[a.path.length - 1], b.path[0], b.path[b.path.length - 1]];
    for (const h of G.intersections(a.path, a.cum, b.path, b.cum)) {
      if (joints.some(j => G.dist(j, h.p) < 4)) continue;
      count++;
    }
  }
  return count;
}

test('Beispiel: Gleisbelegung wie erwartet (Rechtsverkehr)', () => {
  const P = PL.plan(EX.get('skizze'));
  // Links: 4 Gleise → G1/G2 raus (links), G3/G4 rein (rechts)
  assert.deepEqual(names(lane(P, 'Links', 4)), ['Rechts', 'Unten rechts']);   // äußeres Einfahrgleis: Rechtsabbieger + geradeaus
  assert.deepEqual(names(lane(P, 'Links', 3)), ['Oben links']);               // inneres Einfahrgleis: Linksabbieger
  assert.deepEqual(sources(lane(P, 'Links', 1)), ['Oben links', 'Rechts']);
  assert.deepEqual(sources(lane(P, 'Links', 2)), ['Unten rechts']);
  const ur = P.nodes.find(N => N.name === 'Unten rechts');
  assert.equal(ur.inLanes[0].strands.length, 3);
  assert.equal(ur.outLanes[0].strands.length, 3);
  const oben = P.nodes.find(N => N.name === 'Oben');
  assert.ok(oben.single);
});

test('Beispiel: nur topologisch nötige Kreuzungen, jeweils genau einmal', () => {
  const P = PL.plan(EX.get('skizze'));
  assert.deepEqual(PL.geoCrossingPairs(P), PL.topoCrossingPairs(P));
  assert.equal(P.stats.crossings, 11);
  assert.equal(fullPathCrossings(P), P.crossings.length);
});

test('keine Kreuzung innerhalb einer Verbindung oder zwischen Strängen desselben Anschlusses', () => {
  const P = PL.plan(EX.get('skizze'));
  for (const x of P.crossings) {
    assert.notEqual(x.a.conn, x.b.conn, 'Hin- und Rückrichtung kreuzen sich');
    assert.notEqual(x.a.flow.from, x.b.flow.from, 'Abfahrten eines Anschlusses kreuzen sich');
    assert.notEqual(x.a.flow.to, x.b.flow.to, 'Ankünfte eines Anschlusses kreuzen sich');
  }
});

test('Signale: je genutztem Gleis genau ein E bzw. A in richtiger Richtung', () => {
  const P = PL.plan(EX.get('skizze'));
  for (const L of P.lanes) {
    if (!L.strands.length) continue;
    const kind = L.kind === 'in' ? 'E' : 'A';
    const sigs = P.signals.filter(s => s.kind === kind && s.lane === L);
    assert.equal(sigs.length, 1, `${L.id}: ${kind}-Signal`);
    const want = L.kind === 'in' ? L.node.u : G.mul(L.node.u, -1);
    assert.ok(G.dot(sigs[0].dir, want) > 0.999, `${L.id}: Richtung`);
    assert.equal(sigs[0].oneWay, !(L.single && L.kind === 'in'), `${L.id}: Einbahn`);
  }
  assert.ok(P.signals.filter(s => s.kind === 'Z').every(s => s.conditional));
});

test('Flachkreuzung per Überschreibung → Wartesignal davor', () => {
  const m = EX.get('skizze');
  const before = PL.plan(m);
  m.crossingOverrides = { 'c2|c3': 'flat' };                   // Rot × Gelb flach
  const P = PL.plan(m);
  const k = P.structures.find(s => s.key === 'c2|c3');
  assert.equal(k.mode, 'flat');
  assert.equal(P.stats.flat, 1);
  assert.ok(P.stats.Z > before.stats.Z);
  assert.ok(P.notes.some(n => n.level === 'warn' && n.text.includes('Flachkreuzung')));
  m.crossingOverrides = { 'c2|c3': 'c2' };                      // Rot oben
  assert.equal(PL.plan(m).structures.find(s => s.key === 'c2|c3').over.id, 'c2');
});

test('Linksverkehr am gespiegelten Beispiel ergibt dieselben Kreuzungen', () => {
  const m = EX.get('skizze');
  const right = PL.plan(m);
  m.settings.traffic = 'left';
  m.nodes.forEach(n => { n.x = 1400 - n.x; });
  const left = PL.plan(m);
  assert.equal(left.stats.crossings, right.stats.crossings);
  assert.equal(left.stats.switches, right.stats.switches);
  assert.deepEqual(PL.geoCrossingPairs(left), PL.topoCrossingPairs(left));
});

test('Zufallsknoten: Geometrie = Topologie, Übergänge kreuzungsfrei', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const P = PL.plan(randomModel(seed));
    assert.deepEqual(PL.geoCrossingPairs(P), PL.topoCrossingPairs(P), `seed ${seed}`);
    assert.equal(fullPathCrossings(P), P.crossings.length, `seed ${seed}: Übergangsbögen`);
  }
});

test('Gleisdreieck: je Abzweig eine unvermeidbare Kreuzung', () => {
  const P = PL.plan(EX.get('dreieck'));
  // Eine zweigleisige Abzweigung hat immer genau einen Konfliktpunkt (Flachkreuzung oder Überwerfung)
  assert.equal(P.stats.crossings, 3);
  assert.deepEqual(PL.geoCrossingPairs(P), PL.topoCrossingPairs(P));
  assert.equal(P.stats.diverge, 3);
  assert.equal(P.stats.merge, 3);
});

test('Verbindung „ebenerdig“: alle ihre Kreuzungen werden flach', () => {
  const m = EX.get('skizze');
  m.connections.find(c => c.id === 'c2').crossing = 'flat';            // Rot ebenerdig
  const P = PL.plan(m);
  for (const st of P.structures) {
    const involves = st.connA.id === 'c2' || st.connB.id === 'c2';
    assert.equal(st.mode, involves ? 'flat' : 'bridge', st.label);
  }
  assert.ok(P.stats.flat >= 1);
});

test('Verbindung „Brücke/Tunnel“ bei flachem Standard – und liegt dann oben', () => {
  const m = EX.get('skizze');
  m.settings.crossingDefault = 'flat';
  m.connections.find(c => c.id === 'c3').crossing = 'bridge';          // Gelb mit Brücken
  const P = PL.plan(m);
  for (const st of P.structures) {
    const involves = st.connA.id === 'c3' || st.connB.id === 'c3';
    assert.equal(st.mode, involves ? 'bridge' : 'flat', st.label);
    if (involves) assert.equal(st.over.id, 'c3', st.label);
  }
});

test('Vorrang: K-Schild vor „ebenerdig“ vor „Brücke/Tunnel“', () => {
  const m = EX.get('skizze');
  m.connections.find(c => c.id === 'c2').crossing = 'flat';
  m.connections.find(c => c.id === 'c3').crossing = 'bridge';
  let P = PL.plan(m);
  let st = P.structures.find(s => s.key === 'c2|c3');
  assert.equal(st.mode, 'flat');
  assert.equal(st.source, 'connection');
  assert.ok(P.notes.some(n => n.text.includes('Vorrang')));
  m.crossingOverrides = { 'c2|c3': 'c2' };
  st = PL.plan(m).structures.find(s => s.key === 'c2|c3');
  assert.equal(st.mode, 'bridge');
  assert.equal(st.over.id, 'c2');
  assert.equal(st.source, 'override');
});

test('Bauablauf: was unten liegt, kommt zuerst', () => {
  const check = (P, tag) => {
    for (const st of P.structures) {
      if (st.mode !== 'bridge') continue;
      assert.ok(P.buildLevel.get(st.over) > P.buildLevel.get(st.under), `${tag} ${st.label}: ${st.over.colorName} über ${st.under.colorName}`);
    }
  };
  const P = PL.plan(EX.get('skizze'));
  check(P, 'Skizze');
  const lv = Object.fromEntries([...P.buildLevel].map(([K, l]) => [K.colorName, l]));
  assert.equal(lv.Rot, 0);                                         // Rot liegt überall unten
  assert.ok(lv.Gelb > lv.Rot);
  assert.equal(P.guide.build[0].title, 'Zuläufe und Weichen');
  assert.equal(P.guide.build[P.guide.build.length - 1].title, 'Signale setzen');
  for (let seed = 1; seed <= 30; seed++) check(PL.plan(randomModel(seed)), `seed ${seed}`);
});

test('allocate: Gruppen nach Last, Zusatzgleise nach D\'Hondt', () => {
  const f = (w) => ({ w });
  const lanes = ['L0', 'L1'];
  const eq = [f(2), f(2), f(2)];
  const a = PL.allocate(eq, lanes);
  assert.deepEqual(eq.map(x => a.get(x)[0]), ['L0', 'L0', 'L1']);    // Gleichstand: größere Gruppe außen
  const heavy = [f(3), f(1), f(1)];
  const b = PL.allocate(heavy, lanes);
  assert.deepEqual(heavy.map(x => b.get(x)[0]), ['L0', 'L1', 'L1']);
  const one = [f(2)];
  assert.deepEqual(PL.allocate(one, lanes).get(one[0]), ['L0', 'L1']);
  const two = [f(1), f(3)];
  const c = PL.allocate(two, ['A', 'B', 'C', 'D']);
  assert.deepEqual(c.get(two[0]), ['A']);
  assert.deepEqual(c.get(two[1]), ['B', 'C', 'D']);
});

test('normalizeModel: ungültige und doppelte Verbindungen fliegen raus', () => {
  const m = PL.normalizeModel({
    nodes: [{ id: 'a', x: 0, y: 0, tracks: 12 }, { id: 'b', x: 100, y: 0, tracks: 0 }],
    connections: [{ id: 1, a: 'a', b: 'a' }, { id: 2, a: 'a', b: 'x' }, { id: 3, a: 'a', b: 'b' }, { id: 4, a: 'b', b: 'a' }],
  });
  assert.equal(m.nodes[0].tracks, 8);
  assert.equal(m.nodes[1].tracks, 1);
  assert.deepEqual(m.connections.map(c => c.id), ['3']);
  assert.equal(m.connections[0].crossing, 'auto');
  assert.equal(PL.normalizeModel({ nodes: m.nodes, connections: [{ id: 5, a: 'a', b: 'b', crossing: 'quatsch' }] }).connections[0].crossing, 'auto');
  assert.equal(PL.normalizeModel({ nodes: m.nodes, connections: [{ id: 5, a: 'a', b: 'b', crossing: 'flat' }] }).connections[0].crossing, 'flat');
});

test('leere und fast leere Modelle stürzen nicht ab', () => {
  assert.equal(PL.plan({}).strands.length, 0);
  assert.equal(PL.plan({ nodes: [{ id: 'a', x: 0, y: 0, tracks: 2 }] }).strands.length, 0);
  const P = PL.plan({ nodes: [{ id: 'a', x: 0, y: 0, tracks: 2, inCount: 0 }, { id: 'b', x: 500, y: 0, tracks: 2 }],
    connections: [{ id: 'k', a: 'a', b: 'b' }] });
  assert.ok(P.notes.some(n => n.level === 'error'));
});
