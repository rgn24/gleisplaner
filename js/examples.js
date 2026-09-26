/* Gleisknoten-Planer – Beispiele */
(function (root) {
  'use strict';

  // Jans Skizze: fünf Anschlüsse, fünf Verbindungen
  const skizze = {
    version: 1,
    settings: { traffic: 'right', crossingDefault: 'bridge',
      layers: { sketch: false, tracks: true, signals: true, labels: true } },
    nodes: [
      { id: 'n1', name: 'Oben links', x: 150, y: 280, tracks: 2, inCount: null, dir: null },
      { id: 'n2', name: 'Oben', x: 600, y: 130, tracks: 1, inCount: null, dir: null },
      { id: 'n3', name: 'Links', x: 80, y: 590, tracks: 4, inCount: null, dir: null },
      { id: 'n4', name: 'Rechts', x: 1320, y: 620, tracks: 4, inCount: null, dir: null },
      { id: 'n5', name: 'Unten rechts', x: 1090, y: 1090, tracks: 2, inCount: null, dir: null },
    ],
    connections: [
      { id: 'c1', a: 'n1', b: 'n3', color: '#f07f3c', weight: 2 },
      { id: 'c2', a: 'n2', b: 'n5', color: '#e5413b', weight: 2 },
      { id: 'c3', a: 'n3', b: 'n4', color: '#e2bd3a', weight: 2 },
      { id: 'c4', a: 'n3', b: 'n5', color: '#46a758', weight: 2 },
      { id: 'c5', a: 'n4', b: 'n5', color: '#4fb3ea', weight: 2 },
    ],
    crossingOverrides: {},
  };

  // Klassisches Gleisdreieck zum Ausprobieren
  const dreieck = {
    version: 1,
    settings: { traffic: 'right', crossingDefault: 'bridge',
      layers: { sketch: false, tracks: true, signals: true, labels: true } },
    nodes: [
      { id: 'a', name: 'West', x: 100, y: 500, tracks: 2, inCount: null, dir: null },
      { id: 'b', name: 'Ost', x: 1000, y: 500, tracks: 2, inCount: null, dir: null },
      { id: 'c', name: 'Süd', x: 550, y: 960, tracks: 2, inCount: null, dir: null },
    ],
    connections: [
      { id: 'k1', a: 'a', b: 'b', color: '#e2bd3a', weight: 3 },
      { id: 'k2', a: 'a', b: 'c', color: '#46a758', weight: 2 },
      { id: 'k3', a: 'b', b: 'c', color: '#4fb3ea', weight: 2 },
    ],
    crossingOverrides: {},
  };

  const api = {
    list: [
      { id: 'skizze', title: 'Deine Skizze (5 Anschlüsse)', model: skizze },
      { id: 'dreieck', title: 'Gleisdreieck (3 Anschlüsse)', model: dreieck },
    ],
    get(id) { const e = this.list.find(x => x.id === id); return e ? JSON.parse(JSON.stringify(e.model)) : null; },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.GP = root.GP || {};
  root.GP.examples = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
