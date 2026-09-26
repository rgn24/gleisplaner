// Tests für den Bahnhofsplaner:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const ST = require('../js/station.js');

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function randomStation(seed) {
  const r = rng(seed);
  const n = 1 + Math.floor(r() * 9);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const tracks = (k) => Array.from({ length: k }, () => ({ type: pick(['P', 'G', 'PG', 'PG']) }));
  return {
    settings: { traffic: r() < 0.5 ? 'right' : 'left' },
    platforms: Array.from({ length: n }, () => ({ type: pick(['P', 'P', 'G']), use: pick(['auto', 'auto', 'auto', 'east', 'west', 'both']) })),
    left: { tracks: tracks(Math.floor(r() * 5)) },
    right: { tracks: tracks(Math.floor(r() * 5)) },
  };
}

test('Durchgangsbahnhof: Richtungsgleise, Zugarten passen, keine Kreuzung', () => {
  const S = ST.plan(ST.example('durchgang'));
  assert.equal(S.kind, 'through');
  assert.deepEqual(S.rows.map(r => r.use), ['west', 'west', 'west', 'east', 'east', 'east']);
  for (const r of S.rows) {
    for (const X of ['left', 'right']) {
      const l = r.at[X];
      assert.ok(l, `Gleis ${r.no} ${X}`);
      assert.ok(l.type === 'PG' || l.type === r.type, `Gleis ${r.no}: Zugart`);
      const expect = (X === 'left') === (r.use === 'east') ? 'in' : 'out';
      assert.equal(l.dir, expect, `Gleis ${r.no} ${X}: Richtung`);
    }
  }
  assert.equal(S.stats.crossings, 0);
  assert.equal(S.crossovers.length, 0, 'getrennte Personen-/Gütergleise brauchen keinen Gleiswechsel');
  const n = (k) => S.signals.filter(s => s.kind === k).length;
  assert.equal(n('E'), 4); assert.equal(n('B'), 4); assert.equal(n('A'), 6);
  assert.ok(S.signals.filter(s => s.kind === 'A').every(s => s.oneWay));
});

test('Kopfbahnhof: alle Gleise wenden, gekreuzter Gleiswechsel, Prellböcke', () => {
  const S = ST.plan(ST.example('kopf'));
  assert.equal(S.kind, 'terminus');
  assert.ok(S.rows.every(r => r.use === 'both' && r.at.left && !r.at.right));
  assert.equal(S.crossovers.length, 1);
  assert.equal(S.buffers.length, 4);
  assert.ok(S.signals.filter(s => s.kind === 'A').every(s => !s.oneWay), 'Ausfahrsignale ohne Einbahn');
  assert.equal(S.stats.crossings, 0);
});

test('Kreuzungsbahnhof an eingleisiger Strecke: Spreizweichen, Einfahrsignal ohne Einbahn', () => {
  const S = ST.plan(ST.example('kreuzung'));
  assert.equal(S.stats.switches, 2);
  const E = S.signals.filter(s => s.kind === 'E');
  assert.equal(E.length, 2);
  assert.ok(E.every(s => !s.oneWay));
  assert.equal(S.stats.crossings, 0);
});

test('Typen an der falschen Stelle: Kreuzung wird erkannt und gemeldet', () => {
  const S = ST.plan({
    platforms: [{ type: 'G' }, { type: 'P' }],
    left: { tracks: [{ type: 'G' }, { type: 'P' }] },          // oben raus (G), unten rein (P) – passt
    right: { tracks: [{ type: 'G' }, { type: 'P' }] },         // oben rein (G), unten raus (P)
  });
  assert.equal(S.stats.crossings, 0);
  const T = ST.plan({
    platforms: [{ type: 'P', use: 'east' }, { type: 'P', use: 'west' }],   // Richtungen vertauscht
    left: { tracks: [{ type: 'PG' }, { type: 'PG' }] },
    right: { tracks: [{ type: 'PG' }, { type: 'PG' }] },
  });
  assert.ok(T.stats.crossings > 0);
  assert.ok(T.notes.some(n => n.level === 'warn' && n.text.includes('ebenerdig')));
  const U = ST.plan({ platforms: [{ type: 'G' }], left: { tracks: [{ type: 'P' }] }, right: { tracks: [] } });
  assert.ok(U.notes.some(n => n.level === 'error'));
});

test('Linksverkehr spiegelt: gleiche Weichen- und Kreuzungszahl', () => {
  for (const id of ['durchgang', 'kopf', 'kreuzung']) {
    const m = ST.example(id);
    const a = ST.plan(m);
    m.settings.traffic = 'left';
    const b = ST.plan(m);
    assert.equal(b.stats.switches, a.stats.switches, id);
    assert.equal(b.stats.crossings, a.stats.crossings, id);
  }
});

test('Zufallsbahnhöfe: jede Verbindung da oder gemeldet, keine Abstürze', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const S = ST.plan(randomStation(seed));
    for (const X of ['left', 'right']) {
      const sd = S.sides[X];
      if (!sd.lines.length) continue;
      for (const r of S.rows) {
        if (!ST.category(r, X)) continue;
        assert.ok(r.at[X] || sd.missing.includes(r), `seed ${seed}: Gleis ${r.no} ${X}`);
      }
      if (sd.monotone && !S.rows.some(r => r.set !== 'auto')) assert.equal(S.crossings.filter(c => c.side === X).length, 0, `seed ${seed} ${X}: monoton, trotzdem Kreuzung`);
    }
    assert.ok(S.guide.build.length >= 1 || !S.rows.length, `seed ${seed}: Bauablauf`);
  }
});

test('normalizeStation: Grenzen und Standardwerte', () => {
  const m = ST.normalizeStation({ platforms: Array.from({ length: 30 }, () => ({ type: 'X' })), left: { tracks: [{ type: 'Q' }] } });
  assert.equal(m.platforms.length, 16);
  assert.equal(m.platforms[0].type, 'P');
  assert.equal(m.platforms[0].use, 'auto');
  assert.equal(m.left.tracks[0].type, 'PG');
  assert.deepEqual(m.right.tracks, []);
});
