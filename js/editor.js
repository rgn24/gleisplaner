/* Gleisknoten-Planer – Bedienung: Zeichenfläche, Seitenleiste, Speichern, Export */
(function () {
  'use strict';
  const { geo: G, planner: PL, render: R, examples: EX } = window.GP;
  const $ = (s, r = document) => r.querySelector(s);
  const svg = $('#canvas');
  const STORE = 'gleisplaner:v1';
  const BIG = { x: -60000, y: -60000, w: 120000, h: 120000 };
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const snap10 = (v) => Math.round(v / 10) * 10;
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // localStorage kann fehlen oder gesperrt sein – dann einfach ohne Autosave weiter
  const store = {
    get() { try { return localStorage.getItem(STORE); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(STORE, v); } catch (e) { /* ignorieren */ } },
  };
  function loadStored() {
    const raw = store.get();
    if (!raw) return null;
    try { return PL.normalizeModel(JSON.parse(raw)); } catch (e) { return null; }
  }

  // Animation ist eine Vorliebe des Betrachters, nicht Teil des Plans → eigener Schlüssel
  const ANIM_KEY = 'gleisplaner:anim';
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  let animOn = (() => {
    try { const v = localStorage.getItem(ANIM_KEY); return v == null ? !reduceMotion : v === '1'; } catch (e) { return !reduceMotion; }
  })();

  let model = loadStored() || PL.normalizeModel(EX.get('skizze'));
  let plan = null;
  let sel = null;            // { type: 'node' | 'conn' | 'struct', id }
  let hover = null;          // Referenz (E3, W2, K1, lane:…)
  let drag = null;
  let connectDrag = null;
  let raf = 0;
  const view = { x: 0, y: 0, k: 1 };
  let autoFit = true;                 // bis der Nutzer selbst schiebt/zoomt, passt sich die Ansicht an
  let lastSize = { w: 0, h: 0 };
  const hist = { undo: [], redo: [] };
  const openSecs = { build: true, nodes: true, signals: true, switches: false, structures: true };

  const nodeById = (id) => model.nodes.find(n => n.id === id);
  const connById = (id) => model.connections.find(c => c.id === id);
  const save = () => store.set(JSON.stringify(model));
  const snapshot = () => JSON.stringify(model);

  // ── Verlauf ──
  function pushHistory(snap) {
    hist.undo.push(snap || snapshot());
    if (hist.undo.length > 120) hist.undo.shift();
    hist.redo.length = 0;
  }
  function commit(fn) {
    pushHistory();
    fn();
    model = PL.normalizeModel(model);
    validateSel();
    refresh();
    save();
  }
  function undo() {
    if (!hist.undo.length) return;
    hist.redo.push(snapshot());
    model = PL.normalizeModel(JSON.parse(hist.undo.pop()));
    validateSel(); refresh(); save();
  }
  function redo() {
    if (!hist.redo.length) return;
    hist.undo.push(snapshot());
    model = PL.normalizeModel(JSON.parse(hist.redo.pop()));
    validateSel(); refresh(); save();
  }
  function validateSel() {
    if (!sel) return;
    if (sel.type === 'node' && !nodeById(sel.id)) sel = null;
    else if (sel.type === 'conn' && !connById(sel.id)) sel = null;
  }

  // ── Ansicht ──
  function applyView() {
    const w = svg.clientWidth || 800, h = svg.clientHeight || 600;
    lastSize = { w, h };
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${w / view.k} ${h / view.k}`);
  }
  function onResize() {
    const w = svg.clientWidth || 800, h = svg.clientHeight || 600;
    if (w === lastSize.w && h === lastSize.h) return;
    if (autoFit) { fit(); return; }
    // Mittelpunkt der Ansicht beibehalten
    view.x += (lastSize.w - w) / view.k / 2;
    view.y += (lastSize.h - h) / view.k / 2;
    applyView();
  }
  function contentBox(P, pad) {
    const pts = [];
    for (const N of P.nodes) {
      const back = G.mul(N.u, -1), hw = R.nodeHalfWidth(N);
      pts.push(G.add(N.pos, G.mul(back, (N.stubLen || 106) + 44)));
      pts.push(G.add(N.pos, G.mul(N.r, hw + 30)), G.add(N.pos, G.mul(N.r, -hw - 30)));
      pts.push(G.add(N.pos, G.mul(N.u, 60)));
    }
    if (P.center && P.strands.length) {
      pts.push(G.add(P.center, G.v(P.ring + 30, P.ring + 30)), G.sub(P.center, G.v(P.ring + 30, P.ring + 30)));
    }
    const b = G.bbox(pts);
    // Beschriftung links/rechts braucht etwas Luft
    return { x0: b.x0 - pad - 60, y0: b.y0 - pad, x1: b.x1 + pad + 60, y1: b.y1 + pad };
  }
  function fit() {
    autoFit = true;
    if (!plan || !plan.nodes.length) { view.k = 1; view.x = -((svg.clientWidth || 800) / 2); view.y = -((svg.clientHeight || 600) / 2); applyView(); return; }
    const b = contentBox(plan, 20);
    const w = svg.clientWidth || 800, h = svg.clientHeight || 600;
    view.k = clamp(Math.min(w / (b.x1 - b.x0), h / (b.y1 - b.y0)), 0.12, 2.5);
    view.x = (b.x0 + b.x1) / 2 - w / view.k / 2;
    view.y = (b.y0 + b.y1) / 2 - h / view.k / 2;
    applyView();
  }
  function toWorld(ev) {
    const r = svg.getBoundingClientRect();
    return G.v(view.x + (ev.clientX - r.left) / view.k, view.y + (ev.clientY - r.top) / view.k);
  }

  // ── Zeichnen ──
  function draw() {
    R.render(svg, plan, model, { sel, viewBox: BIG, connectDrag });
    applyView();
    if (hover) R.highlight(svg, plan, hover);
    renderStats();
  }
  function refresh() {
    plan = PL.plan(model);
    draw();
    renderSide();
  }
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; plan = PL.plan(model); draw(); });
  }

  function renderStats() {
    const s = plan.stats || {};
    const box = $('#stats');
    if (!plan.strands.length) { box.innerHTML = ''; return; }
    box.innerHTML = [
      `<span class="chip"><b>${s.strands}</b> Einrichtungsgleise</span>`,
      `<span class="chip"><b>${s.switches}</b> Weichen</span>`,
      `<span class="chip"><b>${s.bridges}</b> Brücken/Tunnel</span>`,
      s.flat ? `<span class="chip warn"><b>${s.flat}</b> Flachkreuzungen</span>` : '',
      `<span class="chip"><b>${s.signals}</b> Signale</span>`,
    ].join('');
  }

  // ── Änderungen am Modell ──
  function nextColor() {
    const used = new Set(model.connections.map(c => c.color.toLowerCase()));
    const free = PL.PALETTE.find(p => !used.has(p.hex.toLowerCase()));
    return (free || PL.PALETTE[model.connections.length % PL.PALETTE.length]).hex;
  }
  function addNode(p) {
    const id = uid('n');
    commit(() => {
      model.nodes.push({ id, name: `Anschluss ${model.nodes.length + 1}`, x: snap10(p.x), y: snap10(p.y), tracks: 2, inCount: null, dir: null });
    });
    sel = { type: 'node', id };
    refresh();
  }
  function toggleConnection(a, b) {
    const ex = model.connections.find(c => (c.a === a && c.b === b) || (c.a === b && c.b === a));
    if (ex) { commit(() => { model.connections = model.connections.filter(c => c !== ex); }); toast('Verbindung entfernt'); return; }
    const id = uid('c');
    commit(() => { model.connections.push({ id, a, b, color: nextColor(), weight: 2 }); });
    sel = { type: 'conn', id };
    refresh();
  }
  function deleteSelection() {
    if (!sel) return;
    if (sel.type === 'node') {
      const id = sel.id;
      commit(() => {
        model.nodes = model.nodes.filter(n => n.id !== id);
        model.connections = model.connections.filter(c => c.a !== id && c.b !== id);
      });
    } else if (sel.type === 'conn') {
      const id = sel.id;
      commit(() => { model.connections = model.connections.filter(c => c.id !== id); });
    }
    sel = null;
    refresh();
  }
  const defLabel = () => (model.settings.crossingDefault === 'flat' ? 'flach' : 'Brücke');
  const dirName = (t) => `${t.flow.from.name} → ${t.flow.to.name}` + (t.flow.strands.length > 1 ? ` · Gleis ${t.j + 1}` : '');
  const trackLabel = (v) => (v === 'flat' ? 'ebenerdig' : v === 'bridge' ? 'Brücke/Tunnel' : 'wie Verbindung');
  const findStructure = (key) => plan.structures.find(st => st.key === key || st.crossings.some(x => x.trackKey === key));
  const isPairKey = (k) => !k.includes(':');
  // Ältere Überschreibungen für ein ganzes Verbindungspaar auf die einzelnen Gleis-Kreuzungen übertragen,
  // damit man danach eine Fahrtrichtung ändern kann, ohne die andere mitzuziehen
  function materializePairs(test) {
    for (const k of Object.keys(model.crossingOverrides)) {
      if (!isPairKey(k) || !test(k)) continue;
      const v = model.crossingOverrides[k];
      for (const x of plan.crossings) if (x.pairKey === k && !(x.trackKey in model.crossingOverrides)) model.crossingOverrides[x.trackKey] = v;
      delete model.crossingOverrides[k];
    }
  }
  const resetToast = (n) => { if (n) toast(n === 1 ? 'Eine einzeln eingestellte Kreuzung zurückgesetzt' : `${n} einzeln eingestellte Kreuzungen zurückgesetzt`); };

  // Beide Richtungen einer Verbindung: Einstellungen einzelner Gleise und K-Schilder dieser Verbindung entfallen,
  // damit das Ergebnis vorhersehbar bleibt (⌘Z holt sie zurück)
  function setConnCrossing(id, value) {
    const c = connById(id);
    if (!c) return;
    const mine = (part) => part === id || part.startsWith(id + ':');
    const keys = Object.keys(model.crossingOverrides).filter(k => k.split('|').some(mine));
    const tracks = Object.keys(model.trackCrossing || {}).filter(mine);
    if ((c.crossing || 'auto') === value && !keys.length && !tracks.length) return;
    commit(() => {
      connById(id).crossing = value;
      keys.forEach(k => { delete model.crossingOverrides[k]; });
      tracks.forEach(k => { delete model.trackCrossing[k]; });
    });
    if (tracks.length) toast('Gilt jetzt für beide Richtungen – Einstellungen einzelner Gleise zurückgesetzt');
    else resetToast(keys.length);
  }
  // Nur ein Gleis (eine Fahrtrichtung)
  function setTrackCrossing(id, value) {
    const t = plan.strands.find(s => s.id === id);
    if (!t || ((model.trackCrossing || {})[id] || 'auto') === value) return;
    let removed = 0;
    commit(() => {
      materializePairs(k => k.split('|').includes(t.conn.id));
      for (const k of Object.keys(model.crossingOverrides)) if (k.split('|').includes(id)) { delete model.crossingOverrides[k]; removed++; }
      if (value === 'auto') delete model.trackCrossing[id]; else model.trackCrossing[id] = value;
    });
    resetToast(removed);
  }
  // Ein Kreuzungsbauwerk (K-Schild): gilt für alle Gleis-Kreuzungen darin
  function setStructureMode(key, value) {
    const st = findStructure(key);
    if (!st) return;
    commit(() => {
      materializePairs(k => k === st.pairKey);
      for (const x of st.crossings) {
        if (value == null) delete model.crossingOverrides[x.trackKey];
        else model.crossingOverrides[x.trackKey] = value;
      }
    });
  }
  function cycleStructure(key) {
    const st = findStructure(key);
    if (!st) return;
    // Reihenfolge: Standard oben → andere Verbindung oben → flach
    const other = st.defOver === st.connA ? st.connB : st.connA;
    const opts = [st.defOver.id, other.id, 'flat'];
    const cur = st.mode === 'flat' ? 'flat' : st.over.id;
    sel = { type: 'struct', id: st.key };
    setStructureMode(st.key, opts[(opts.indexOf(cur) + 1) % opts.length]);
  }
  function nodeAt(p, exceptId) {
    for (const N of plan.nodes) {
      if (N.id === exceptId) continue;
      const rel = G.sub(p, N.pos);
      if (Math.abs(G.dot(rel, N.r)) <= R.nodeHalfWidth(N) + 8 && Math.abs(G.dot(rel, N.u)) <= 26) return N;
    }
    return null;
  }

  // ── Zeichenfläche: Zeiger ──
  svg.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    const t = ev.target.closest('[data-handle],[data-node],[data-struct],[data-strand],[data-conn]');
    const start = { x: ev.clientX, y: ev.clientY };
    const p = toWorld(ev);
    try { svg.setPointerCapture(ev.pointerId); } catch (e) { /* egal */ }
    if (t && t.dataset.handle === 'rotate') drag = { kind: 'rotate', id: t.dataset.node, start, snap: snapshot() };
    else if (t && t.dataset.handle === 'connect') drag = { kind: 'connect', id: t.dataset.node, start };
    else if (t && t.dataset.node) {
      const n = nodeById(t.dataset.node);
      drag = { kind: 'node', id: n.id, start, off: G.sub(G.v(n.x, n.y), p), snap: snapshot() };
    } else if (t && t.dataset.struct) drag = { kind: 'struct', key: t.dataset.struct, start };
    else if (t && t.dataset.strand) drag = { kind: 'track', id: t.dataset.strand, start };
    else if (t && t.dataset.conn) drag = { kind: 'conn', id: t.dataset.conn, start };
    else drag = { kind: 'pan', start };
    drag.vx = view.x; drag.vy = view.y; drag.moved = false;
  });

  svg.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.start.x, dy = ev.clientY - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    const p = toWorld(ev);
    if (drag.kind === 'struct' || drag.kind === 'conn' || drag.kind === 'track') drag.kind = 'pan';
    if (drag.kind === 'pan') {
      view.x = drag.vx - dx / view.k; view.y = drag.vy - dy / view.k;
      autoFit = false;
      svg.classList.add('panning');
      applyView();
    } else if (drag.kind === 'node') {
      const n = nodeById(drag.id);
      n.x = snap10(p.x + drag.off.x); n.y = snap10(p.y + drag.off.y);
      if (!sel || sel.id !== n.id) { sel = { type: 'node', id: n.id }; }
      schedule();
    } else if (drag.kind === 'rotate') {
      const n = nodeById(drag.id);
      n.dir = Math.round(G.toDeg(G.angleOf(G.sub(p, G.v(n.x, n.y)))) / 15) * 15;
      schedule();
    } else if (drag.kind === 'connect') {
      const n = nodeById(drag.id);
      connectDrag = { from: G.v(n.x, n.y), to: p };
      schedule();
    }
  });

  function endDrag(ev, cancelled) {
    const d = drag;
    drag = null;
    svg.classList.remove('panning');
    if (!d) return;
    if (d.kind === 'node' || d.kind === 'rotate') {
      if (d.moved) { pushHistory(d.snap); model = PL.normalizeModel(model); save(); }
      else if (d.kind === 'node') sel = { type: 'node', id: d.id };
      refresh();
    } else if (d.kind === 'connect') {
      connectDrag = null;
      const target = !cancelled && d.moved ? nodeAt(toWorld(ev), d.id) : null;
      if (target) toggleConnection(d.id, target.id);
      else draw();
    } else if (cancelled) {
      return;
    } else if (d.kind === 'struct') cycleStructure(d.key);
    else if (d.kind === 'conn') { sel = { type: 'conn', id: d.id }; refresh(); }
    else if (d.kind === 'track') { sel = { type: 'track', id: d.id }; refresh(); }
    else if (d.kind === 'pan' && !d.moved && sel) { sel = null; refresh(); }
  }
  svg.addEventListener('pointerup', (ev) => endDrag(ev, false));
  svg.addEventListener('pointercancel', (ev) => endDrag(ev, true));

  svg.addEventListener('dblclick', (ev) => {
    const t = ev.target.closest('[data-handle],[data-node],[data-struct],[data-conn],[data-ref]');
    if (t && t.dataset.handle === 'rotate') {
      const id = t.dataset.node;
      commit(() => { nodeById(id).dir = null; });
      toast('Richtung wieder automatisch');
      return;
    }
    if (!t) addNode(toWorld(ev));
  });

  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    autoFit = false;
    const zoom = ev.ctrlKey || ev.deltaMode === 1 || (ev.deltaX === 0 && Math.abs(ev.deltaY) >= 50);
    if (zoom) {
      const p = toWorld(ev);
      const r = svg.getBoundingClientRect();
      view.k = clamp(view.k * Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0016)), 0.12, 4);
      view.x = p.x - (ev.clientX - r.left) / view.k;
      view.y = p.y - (ev.clientY - r.top) / view.k;
    } else {
      view.x += ev.deltaX / view.k;
      view.y += ev.deltaY / view.k;
    }
    applyView();
  }, { passive: false });

  window.addEventListener('resize', onResize);
  if (window.ResizeObserver) new ResizeObserver(onResize).observe(svg);

  // ── Seitenleiste ──
  const dots = (cols) => `<span class="cols">${cols.map(c => `<span class="dot" style="background:${esc(c)}"></span>`).join('')}</span>`;
  const sigColor = { E: 'var(--sig-e)', A: 'var(--sig-a)', Z: 'var(--sig-z)' };

  function selPanelHtml() {
    if (sel && sel.type === 'node') {
      const n = nodeById(sel.id);
      const N = plan.nodes.find(x => x.id === n.id);
      const others = model.nodes.filter(o => o.id !== n.id);
      const linkOf = (o) => model.connections.find(c => (c.a === n.id && c.b === o.id) || (c.a === o.id && c.b === n.id));
      const auto = PL.defaultInCount(n.tracks);
      const inOpts = [`<option value="">automatisch (${auto} rein)</option>`]
        .concat(Array.from({ length: n.tracks + 1 }, (_, i) => `<option value="${i}" ${n.inCount === i ? 'selected' : ''}>${i} rein · ${n.tracks - i} raus</option>`));
      return `<h2>Anschluss</h2>
        <div class="row"><input type="text" id="fName" value="${esc(n.name)}" maxlength="40" aria-label="Name"></div>
        <div class="row"><span>Gleise</span><div class="stepper">
          <button class="btn icon" data-step="-1" aria-label="Weniger Gleise" ${n.tracks <= 1 ? 'disabled' : ''}>−</button>
          <output>${n.tracks}</output>
          <button class="btn icon" data-step="1" aria-label="Mehr Gleise" ${n.tracks >= 8 ? 'disabled' : ''}>+</button></div></div>
        ${n.tracks > 1
          ? `<div class="row"><span>Aufteilung</span><select id="fIn" aria-label="Einfahrgleise">${inOpts.join('')}</select></div>`
          : '<p class="fine">1 Gleis = eingleisige Strecke; im Knoten wird sie in Ein- und Ausfahrgleis gespreizt.</p>'}
        <div class="row"><span>Richtung</span><span>${n.dir == null ? 'automatisch zur Knotenmitte' : `${Math.round(((N.dirDeg % 360) + 360) % 360)}° <button class="link" id="fDirAuto">auf automatisch</button>`}</span></div>
        <h3>Verbindungen</h3>
        <div class="checks">${others.length ? others.map(o => {
          const c = linkOf(o);
          return `<label><input type="checkbox" data-link="${esc(o.id)}" ${c ? 'checked' : ''}><span class="dot" style="background:${c ? esc(c.color) : 'transparent'};border:1px solid var(--line)"></span>${esc(o.name)}</label>`;
        }).join('') : '<p class="empty">Noch keine anderen Anschlüsse.</p>'}</div>
        <div class="actions"><button class="btn danger" id="fDelNode">Anschluss löschen</button></div>`;
    }
    const structItem = (st) => {
      const how = st.mode === 'flat' ? 'flach' : `Brücke, ${esc(st.over.colorName)} oben`;
      return `<li class="item clickable" data-ref="${st.label}" data-struct="${esc(st.key)}"><span class="tag">${st.label}</span>
        <span>${dots([st.connA.color, st.connB.color])}${esc(st.text)} · ${how}${st.source === 'override' ? ' · einzeln' : ''}</span></li>`;
    };
    if (sel && sel.type === 'track') {
      const t = plan.strands.find(x => x.id === sel.id);
      if (t) {
        const K = t.conn, c = connById(K.id);
        const cur = (model.trackCrossing || {})[t.id] || 'auto';
        const connTxt = c.crossing === 'flat' ? 'ebenerdig' : c.crossing === 'bridge' ? 'Brücke/Tunnel' : `Standard, zurzeit ${defLabel()}`;
        const mine = plan.structures.filter(st => st.crossings.some(x => x.a === t || x.b === t));
        const opt = (v, label) => `<button class="btn" data-tcross="${v}" aria-pressed="${cur === v}">${label}</button>`;
        const others = K.strands.filter(o => o !== t);
        return `<h2>Gleis · eine Fahrtrichtung</h2>
          <p class="lead"><span class="dot" style="background:${esc(K.color)}"></span> ${esc(dirName(t))}</p>
          <p class="fine">${esc(K.colorName)}, Verbindung ${esc(K.label)}. Einstellungen hier gelten nur für dieses Gleis – die Gegenrichtung bleibt, wie sie ist.</p>
          <h3>Kreuzungen dieses Gleises</h3>
          <div class="seg small" role="group" aria-label="Kreuzungen dieses Gleises">${opt('auto', 'Wie Verbindung')}${opt('bridge', 'Brücke/Tunnel')}${opt('flat', 'Ebenerdig')}</div>
          <p class="fine">„Wie Verbindung“ heißt zurzeit: ${esc(connTxt)}. „Ebenerdig“ hat Vorrang vor „Brücke/Tunnel“; einzelne Stellen stellst du über ihr K-Schild um.</p>
          ${mine.length ? `<ul class="items">${mine.map(structItem).join('')}</ul>` : '<p class="empty">Dieses Gleis kreuzt nichts.</p>'}
          ${others.length ? `<h3>Andere Richtung</h3><div class="checks">${others.map(o =>
            `<button class="link" data-seltrack="${esc(o.id)}" data-ref="track:${esc(o.id)}">${esc(dirName(o))} – ${trackLabel((model.trackCrossing || {})[o.id])}</button>`).join('')}</div>` : ''}
          <div class="actions"><button class="btn" data-selconn="${esc(K.id)}">Ganze Verbindung (beide Richtungen) …</button></div>`;
      }
    }
    if (sel && sel.type === 'conn') {
      const c = connById(sel.id);
      const a = nodeById(c.a), b = nodeById(c.b);
      const K = plan.connections.find(k => k.id === c.id);
      const mine = plan.structures.filter(st => st.connA.id === c.id || st.connB.id === c.id);
      const crossOpt = (v, label) => `<button class="btn" data-crossing="${v}" aria-pressed="${(c.crossing || 'auto') === v}">${label}</button>`;
      const tracks = K ? K.strands : [];
      return `<h2>Verbindung · beide Richtungen</h2>
        <p class="lead"><span class="dot" style="background:${esc(c.color)}"></span> ${esc(a.name)} ↔ ${esc(b.name)}</p>
        <h3>Kreuzungen – beide Richtungen</h3>
        <div class="seg small" role="group" aria-label="Kreuzungen dieser Verbindung">
          ${crossOpt('auto', 'Standard')}${crossOpt('bridge', 'Brücke/Tunnel')}${crossOpt('flat', 'Ebenerdig')}</div>
        <p class="fine">Gilt für alle Gleise von ${esc(PL.colorName(c.color))} (Standard zurzeit: ${defLabel()}). Nur eine Richtung ändern: unten das Gleis wählen oder in der Zeichnung direkt anklicken.</p>
        ${tracks.length ? `<div class="checks">${tracks.map(t =>
          `<button class="link" data-seltrack="${esc(t.id)}" data-ref="track:${esc(t.id)}">${esc(dirName(t))} – ${trackLabel((model.trackCrossing || {})[t.id])}</button>`).join('')}</div>` : ''}
        ${mine.length ? `<ul class="items">${mine.map(structItem).join('')}</ul>` : '<p class="empty">Kreuzt keine andere Verbindung.</p>'}
        <div class="row"><span>Farbe</span></div>
        <div class="swatches">${PL.PALETTE.map(p => `<button class="swatch" style="background:${p.hex}" data-color="${p.hex}" aria-label="${p.name}" aria-pressed="${p.hex.toLowerCase() === c.color.toLowerCase()}"></button>`).join('')}</div>
        <div class="row"><span>Verkehr</span><div class="seg small" role="group" aria-label="Verkehr">${[1, 2, 3].map(w =>
          `<button class="btn" data-weight="${w}" aria-pressed="${c.weight === w}">${PL.WEIGHTS[w]}</button>`).join('')}</div></div>
        <p class="fine">Mehr Verkehr bekommt eher ein eigenes Gleis. Bei Brücken liegt standardmäßig die Verbindung mit weniger Verkehr oben.</p>
        <div class="actions"><button class="btn danger" id="fDelConn">Verbindung löschen</button></div>`;
    }
    if (sel && sel.type === 'struct') {
      const st = findStructure(sel.id);
      if (st) {
        const cur = st.mode === 'flat' ? 'flat' : st.over.id;
        const opt = (v, label) => `<label><input type="radio" name="stmode" value="${esc(v)}" ${cur === v ? 'checked' : ''}> ${label}</label>`;
        const why = (list) => list.map(t => `${t.conn.colorName} ${dirName(t)}`).join(' und ');
        return `<h2>Kreuzung ${st.label}</h2>
          <p class="lead">${dots([st.connA.color, st.connB.color])}${esc(st.text)}</p>
          <p>${esc(st.connA.label)} kreuzt ${esc(st.connB.label)} · ${st.tracksA}×${st.tracksB} ${st.tracksA * st.tracksB === 1 ? 'Gleis' : 'Gleise'}</p>
          <div class="checks" style="margin-top:10px">
            ${opt(st.connA.id, `Brücke/Tunnel – ${esc(st.connA.colorName)} oben`)}
            ${opt(st.connB.id, `Brücke/Tunnel – ${esc(st.connB.colorName)} oben`)}
            ${opt('flat', 'Flachkreuzung (Züge müssen sich abwechseln)')}
          </div>
          <p class="fine">${st.source === 'override'
            ? `Einzeln eingestellt. <button class="link" data-unoverride="${esc(st.key)}">Wieder den Gleisen und Verbindungen folgen</button>`
            : st.source === 'track' || st.source === 'connection'
              ? (st.mode === 'flat' ? `Flach, weil ${esc(why(st.flatBy))} auf „ebenerdig“ steht.` : `Brücke/Tunnel, weil ${esc(why(st.wantsBridge))} so eingestellt ist.`)
              : `Folgt dem Standard (${defLabel()}).`}</p>`;
      }
    }
    return `<h2>Auswahl</h2>
      <p>Klicke einen Anschluss, eine Verbindung oder ein K-Schild an, um es zu bearbeiten. Doppelklick auf die freie Fläche setzt einen neuen Anschluss.</p>`;
  }

  function guideHtml(P) {
    if (!P.nodes.length) return '<h2>Bauanleitung</h2><p class="empty">Noch leer – lege Anschlüsse an oder lade über „Datei“ ein Beispiel.</p>';
    const sec = (id, title, count, body) =>
      `<details data-sec="${id}" ${openSecs[id] ? 'open' : ''}><summary>${title}<span class="count">${count}</span></summary>${body}</details>`;
    const nodes = P.guide.nodes.map(g => `<div class="nodecard">
        <div class="title">${esc(g.title)} <span>${esc(g.sub)}</span></div>
        <ul class="lanes">${g.rows.map(r => `<li data-ref="${r.kind === 'single' ? 'node:' + esc(g.node.id) : 'lane:' + esc(r.lanes[0].id)}">
          <span class="no">${r.no}</span><span class="dir">${r.kind === 'in' ? '→' : r.kind === 'out' ? '←' : '⇄'}</span>
          <span>${r.colors.length ? dots(r.colors) : ''}${esc(r.text)}</span></li>`).join('')}</ul></div>`).join('');
    const sigs = P.guide.signals.map(r => `<li class="item" data-ref="${r.label}">
        <span class="tag" style="color:${sigColor[r.kind]}">${r.label}</span>
        <span>${esc(r.place)}<br><span class="sub"><span class="arrow" style="transform:rotate(${Math.round(r.angle)}deg)">➜</span>
        ${esc(r.dir)} · Einbahn: <b>${r.oneWay ? 'Ja' : 'Nein'}</b> · ${esc(r.cond)}</span></span></li>`).join('');
    const sws = P.guide.switches.map(r => `<li class="item" data-ref="${r.label}"><span class="tag">${r.label}</span>
        <span>${r.colors.length ? dots(r.colors) : ''}${esc(r.text)}</span></li>`).join('');
    const sts = P.guide.structures.map(r => `<li class="item clickable" data-ref="${r.label}" data-struct="${esc(r.key)}"><span class="tag">${r.label}</span>
        <span>${dots(r.colors)}<b>${esc(r.text)}</b><br><span class="sub">${esc(r.detail)}</span><br>
        <button class="pillbtn ${r.ref.mode === 'flat' ? 'flat' : ''}" data-cycle="${esc(r.key)}" title="Umschalten">${esc(r.mode)} ⟳</button></span></li>`).join('');
    const steps = (P.guide.build || []).map((st, i) => `<li class="step"${st.refs && st.refs.length ? ` data-ref="${esc(st.refs.join(' '))}"` : ''}>
        <div class="steptitle"><span class="stepno">${i + 1}</span>${esc(st.title)}</div>
        <div class="sub">${esc(st.text)}</div>
        ${st.items ? `<ul class="items">${st.items.map(it => `<li class="item" data-ref="${esc(it.ref)}"><span class="tag">${dots(it.colors)}</span>
          <span><b>${esc(it.title)}</b><br><span class="sub">${esc(it.text)}</span></span></li>`).join('')}</ul>` : ''}
        ${st.warn ? `<div class="note warn">${esc(st.warn)}</div>` : ''}</li>`).join('');
    return `<h2>Bauanleitung</h2><div class="guide">
      ${steps ? sec('build', 'Bauablauf', `${P.guide.build.length} Schritte`, `<ol class="steps">${steps}</ol>`) : ''}
      ${sec('nodes', 'Gleisbelegung je Anschluss', P.nodes.length, nodes + '<p class="fine">G1, G2 … von außen in den Knoten geschaut, von links nach rechts. → rein, ← raus.</p>')}
      ${sec('signals', 'Signale', P.signals.length, P.signals.length ? `<ul class="items">${sigs}</ul><p class="fine">Pfeil = Fahrtrichtung, für die das Signal gilt. Im Spiel Signal setzen, in diese Richtung drehen und „Einbahn“ wie angegeben einstellen.</p>` : '<p class="empty">Noch keine Signale.</p>')}
      ${sec('structures', 'Kreuzungen', P.structures.length, P.structures.length ? `<ul class="items">${sts}</ul>` : '<p class="empty">Keine Kreuzungen nötig.</p>')}
      ${sec('switches', 'Weichen', P.switches.length, P.switches.length ? `<ul class="items">${sws}</ul>` : '<p class="empty">Keine Weichen nötig.</p>')}
    </div>`;
  }

  function notesHtml(P) {
    if (!P.notes.length) return '<h2>Hinweise</h2><p class="empty">Keine Hinweise.</p>';
    return `<h2>Hinweise</h2><ul class="notes">${P.notes.map(n =>
      `<li class="note ${n.level}"${n.refs && n.refs.length ? ` data-ref="${esc(n.refs.join(' '))}"` : ''}>${esc(n.text)}</li>`).join('')}</ul>`;
  }

  function renderSide() {
    const active = document.activeElement;
    const keepFocus = active && active.id === 'fName' ? { start: active.selectionStart, end: active.selectionEnd } : null;
    $('#panelSel').innerHTML = selPanelHtml();
    if (keepFocus) { const f = $('#fName'); if (f) { f.focus(); f.setSelectionRange(keepFocus.start, keepFocus.end); } }
    $('#panelGuide').innerHTML = guideHtml(plan);
    $('#panelNotes').innerHTML = notesHtml(plan);
    document.querySelectorAll('[data-layer]').forEach(b => b.setAttribute('aria-pressed', String(!!model.settings.layers[b.dataset.layer])));
    document.querySelectorAll('[data-setting]').forEach(b => b.setAttribute('aria-pressed', String(model.settings[b.dataset.setting] === b.dataset.value)));
    $('#btnResetOverrides').hidden = !Object.keys(model.crossingOverrides || {}).length && !Object.keys(model.trackCrossing || {}).length;
    $('#btnUndo').disabled = !hist.undo.length;
    $('#btnRedo').disabled = !hist.redo.length;
    if (hover) document.querySelectorAll(`.side [data-ref="${CSS.escape(hover)}"]`).forEach(e => e.classList.add('hl'));
  }

  // Eingaben in der Auswahl-Leiste
  let nameSnap = null;
  $('#panelSel').addEventListener('focusin', (ev) => { if (ev.target.id === 'fName') nameSnap = snapshot(); });
  $('#panelSel').addEventListener('input', (ev) => {
    if (ev.target.id !== 'fName' || !sel) return;
    const n = nodeById(sel.id);
    n.name = ev.target.value.slice(0, 40) || n.name;
    plan = PL.plan(model); draw();
    $('#panelGuide').innerHTML = guideHtml(plan);
  });
  $('#panelSel').addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.id === 'fName') {
      if (nameSnap && nameSnap !== snapshot()) pushHistory(nameSnap);
      nameSnap = null; model = PL.normalizeModel(model); save(); refresh();
    } else if (t.id === 'fIn') {
      const v = t.value === '' ? null : +t.value;
      commit(() => { nodeById(sel.id).inCount = v; });
    } else if (t.dataset.link) {
      toggleConnection(sel.id, t.dataset.link);
    } else if (t.name === 'stmode') {
      setStructureMode(sel.id, t.value);
    }
  });
  $('#panelSel').addEventListener('click', (ev) => {
    const row = ev.target.closest('[data-struct]');
    if (row) { sel = { type: 'struct', id: row.dataset.struct }; refresh(); return; }
    const t = ev.target.closest('button');
    if (!t || !sel) return;
    if (t.dataset.crossing) { setConnCrossing(sel.id, t.dataset.crossing); return; }
    if (t.dataset.tcross) { setTrackCrossing(sel.id, t.dataset.tcross); return; }
    if (t.dataset.seltrack) { sel = { type: 'track', id: t.dataset.seltrack }; refresh(); return; }
    if (t.dataset.selconn) { sel = { type: 'conn', id: t.dataset.selconn }; refresh(); return; }
    if (t.dataset.unoverride) { setStructureMode(t.dataset.unoverride, null); return; }
    if (t.dataset.step) {
      const n = nodeById(sel.id);
      commit(() => { n.tracks = clamp(n.tracks + (+t.dataset.step), 1, 8); if (n.inCount != null && n.inCount > n.tracks) n.inCount = null; });
    } else if (t.id === 'fDirAuto') commit(() => { nodeById(sel.id).dir = null; });
    else if (t.id === 'fDelNode' || t.id === 'fDelConn') deleteSelection();
    else if (t.dataset.color) commit(() => { connById(sel.id).color = t.dataset.color; });
    else if (t.dataset.weight) commit(() => { connById(sel.id).weight = +t.dataset.weight; });
  });

  // Bauanleitung: Abschnitte merken, Kreuzungen umschalten/auswählen
  $('#panelGuide').addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (d.dataset && d.dataset.sec) openSecs[d.dataset.sec] = d.open;
  }, true);
  $('#panelGuide').addEventListener('click', (ev) => {
    const c = ev.target.closest('[data-cycle]');
    if (c) { cycleStructure(c.dataset.cycle); return; }
    const row = ev.target.closest('[data-struct]');
    if (row) { sel = { type: 'struct', id: row.dataset.struct }; refresh(); }
  });

  // Hover-Kopplung Liste ↔ Zeichnung
  document.addEventListener('mouseover', (ev) => {
    const t = ev.target.closest && ev.target.closest('[data-ref]');
    const ref = t ? t.dataset.ref : null;
    if (ref === hover) return;
    hover = ref;
    R.highlight(svg, plan, hover);
    document.querySelectorAll('.side .hl').forEach(e => e.classList.remove('hl'));
    if (ref) document.querySelectorAll(`.side [data-ref="${CSS.escape(ref)}"]`).forEach(e => e.classList.add('hl'));
  });

  // ── Werkzeugleiste & Einstellungen ──
  $('#btnAdd').addEventListener('click', () => {
    const r = svg.getBoundingClientRect();
    addNode(G.v(view.x + r.width / view.k / 2, view.y + r.height / view.k / 2));
  });
  $('#btnUndo').addEventListener('click', undo);
  $('#btnRedo').addEventListener('click', redo);
  $('#btnFit').addEventListener('click', fit);
  function updateAnimButton() {
    const b = $('#btnAnim');
    b.textContent = animOn ? '⏸' : '⏵';
    b.title = animOn ? 'Pfeil-Animation anhalten' : 'Fahrtrichtung animieren';
    b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-pressed', String(animOn));
  }
  $('#btnAnim').addEventListener('click', () => {
    animOn = !animOn;
    try { localStorage.setItem(ANIM_KEY, animOn ? '1' : '0'); } catch (e) { /* ignorieren */ }
    R.setAnimation(svg, animOn);
    updateAnimButton();
  });
  document.querySelectorAll('[data-layer]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.layer;
    model.settings.layers[k] = !model.settings.layers[k];
    save(); draw(); renderSide();
  }));
  document.querySelectorAll('[data-setting]').forEach(b => b.addEventListener('click', () => {
    if (model.settings[b.dataset.setting] === b.dataset.value) return;
    commit(() => { model.settings[b.dataset.setting] = b.dataset.value; });
  }));
  $('#btnResetOverrides').addEventListener('click', () => commit(() => { model.crossingOverrides = {}; model.trackCrossing = {}; }));

  // ── Datei-Menü ──
  const menu = $('#menuList'), menuBtn = $('#btnMenu');
  const closeMenu = () => { menu.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); };
  menuBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    menu.hidden = !menu.hidden;
    menuBtn.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', (ev) => { if (!menu.hidden && !ev.target.closest('.menu')) closeMenu(); });
  menu.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    closeMenu();
    const act = b.dataset.act;
    if (act.startsWith('example:')) {
      commit(() => { model = EX.get(act.slice(8)); });
      sel = null; refresh(); fit();
      toast('Beispiel geladen – ⌘Z macht es rückgängig');
    } else if (act === 'new') {
      commit(() => { model = PL.emptyModel(); });
      sel = null; refresh(); fit();
      toast('Leerer Plan – Doppelklick setzt einen Anschluss');
    } else if (act === 'save-json') {
      download(new Blob([JSON.stringify(model, null, 2)], { type: 'application/json' }), 'gleisknoten.json');
    } else if (act === 'load-json') {
      $('#fileInput').click();
    } else if (act === 'export-svg') {
      const s = new XMLSerializer().serializeToString(exportSvg());
      download(new Blob([s], { type: 'image/svg+xml' }), 'gleisknoten.svg');
    } else if (act === 'export-png') exportPng();
  });
  $('#fileInput').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      const data = PL.normalizeModel(JSON.parse(await file.text()));
      commit(() => { model = data; });
      sel = null; refresh(); fit();
      toast(`„${file.name}“ geladen`);
    } catch (e) {
      toast('Die Datei ist kein gültiger Plan');
    }
  });

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  function exportSvg() {
    const b = contentBox(plan, 30);
    const w = Math.round(b.x1 - b.x0), h = Math.round(b.y1 - b.y0);
    const out = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    out.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    out.setAttribute('viewBox', `${b.x0} ${b.y0} ${w} ${h}`);
    out.setAttribute('width', w);
    out.setAttribute('height', h);
    R.render(out, plan, model, { sel: null, viewBox: { x: b.x0, y: b.y0, w, h }, exporting: true });
    return out;
  }
  function exportPng() {
    const node = exportSvg();
    const w = +node.getAttribute('width'), h = +node.getAttribute('height');
    const scale = Math.min(2, 4096 / Math.max(w, h));
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = Math.round(w * scale); c.height = Math.round(h * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(bl => (bl ? download(bl, 'gleisknoten.png') : toast('PNG-Export fehlgeschlagen')), 'image/png');
    };
    img.onerror = () => toast('PNG-Export fehlgeschlagen');
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(node));
  }

  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ── Tastatur ──
  document.addEventListener('keydown', (ev) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName);
    const mod = ev.metaKey || ev.ctrlKey;
    const key = ev.key.toLowerCase();
    if (mod && key === 'z' && !typing) { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); }
    else if (mod && key === 'y' && !typing) { ev.preventDefault(); redo(); }
    else if ((ev.key === 'Delete' || ev.key === 'Backspace') && !typing && sel && (sel.type === 'node' || sel.type === 'conn')) { ev.preventDefault(); deleteSelection(); }
    else if (ev.key === 'Escape') {
      if (!menu.hidden) closeMenu();
      else if (typing) ev.target.blur();
      else if (sel) { sel = null; refresh(); }
    }
  });

  // ── Start ──
  refresh();
  requestAnimationFrame(fit);
  if (window.GP.common) window.GP.common.watchUpdates('editor.js');
  R.setAnimation(svg, animOn);
  updateAnimButton();
  window.GP.editor = { get model() { return model; }, get plan() { return plan; }, refresh, fit };
})();
