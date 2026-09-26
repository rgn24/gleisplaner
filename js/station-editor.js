/* Bahnhofsplaner – Bedienung: Seitenleiste, Zeichenfläche, Speichern, Export */
(function () {
  'use strict';
  const { geo: G, station: ST, stationRender: SR, render: R } = window.GP;
  const $ = (s, r = document) => r.querySelector(s);
  const svg = $('#canvas');
  const STORE = 'gleisplaner:station:v1';
  const ANIM_KEY = 'gleisplaner:anim';
  const BIG = { x: -60000, y: -60000, w: 120000, h: 120000 };
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const store = {
    get() { try { return localStorage.getItem(STORE); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(STORE, v); } catch (e) { /* ignorieren */ } },
  };
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  let animOn = (() => {
    try { const v = localStorage.getItem(ANIM_KEY); return v == null ? !reduceMotion : v === '1'; } catch (e) { return !reduceMotion; }
  })();

  let model = (() => { const raw = store.get(); try { return raw ? ST.normalizeStation(JSON.parse(raw)) : null; } catch (e) { return null; } })()
    || ST.example('durchgang');
  let plan = null;
  let hover = null;
  let drag = null;
  const view = { x: 0, y: 0, k: 1 };
  let autoFit = true;
  let lastSize = { w: 0, h: 0 };
  const hist = { undo: [], redo: [] };
  const openSecs = { build: true, rows: true, lines: false, signals: true, crossings: true, switches: false };

  const save = () => store.set(JSON.stringify(model));
  const snapshot = () => JSON.stringify(model);
  function commit(fn) {
    hist.undo.push(snapshot());
    if (hist.undo.length > 120) hist.undo.shift();
    hist.redo.length = 0;
    fn();
    model = ST.normalizeStation(model);
    refresh();
    save();
  }
  function undo() {
    if (!hist.undo.length) return;
    hist.redo.push(snapshot());
    model = ST.normalizeStation(JSON.parse(hist.undo.pop()));
    refresh(); save();
  }
  function redo() {
    if (!hist.redo.length) return;
    hist.undo.push(snapshot());
    model = ST.normalizeStation(JSON.parse(hist.redo.pop()));
    refresh(); save();
  }

  // ── Ansicht ──
  function applyView() {
    const w = svg.clientWidth || 800, h = svg.clientHeight || 600;
    lastSize = { w, h };
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${w / view.k} ${h / view.k}`);
  }
  function fit() {
    autoFit = true;
    const b = SR.bounds(plan);
    const pad = 30;
    const w = svg.clientWidth || 800, h = svg.clientHeight || 600;
    view.k = clamp(Math.min(w / (b.x1 - b.x0 + 2 * pad), h / (b.y1 - b.y0 + 2 * pad)), 0.15, 3);
    view.x = (b.x0 + b.x1) / 2 - w / view.k / 2;
    view.y = (b.y0 + b.y1) / 2 - h / view.k / 2;
    applyView();
  }
  function onResize() {
    const w = svg.clientWidth || 800, h = svg.clientHeight || 600;
    if (w === lastSize.w && h === lastSize.h) return;
    if (autoFit) { fit(); return; }
    view.x += (lastSize.w - w) / view.k / 2;
    view.y += (lastSize.h - h) / view.k / 2;
    applyView();
  }
  const toWorld = (ev) => {
    const r = svg.getBoundingClientRect();
    return G.v(view.x + (ev.clientX - r.left) / view.k, view.y + (ev.clientY - r.top) / view.k);
  };

  function draw() {
    SR.render(svg, plan, model, { viewBox: BIG });
    applyView();
    if (hover) SR.highlight(svg, plan, hover);
    const s = plan.stats;
    $('#stats').innerHTML = plan.rows.length ? [
      `<span class="chip"><b>${s.rows}</b> Bahnsteiggleise</span>`,
      `<span class="chip"><b>${s.switches}</b> Weichen</span>`,
      s.crossings ? `<span class="chip warn"><b>${s.crossings}</b> Flachkreuzungen</span>` : '',
      `<span class="chip"><b>${s.signals}</b> Signale</span>`,
      `<span class="chip">${plan.kind === 'terminus' ? 'Kopfbahnhof' : plan.kind === 'through' ? 'Durchgangsbahnhof' : 'ohne Strecke'}</span>`,
    ].join('') : '';
  }
  function refresh() {
    plan = ST.plan(model);
    draw();
    renderSide();
  }

  // ── Zeichenfläche: verschieben, zoomen, Gleis anklicken ──
  svg.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    try { svg.setPointerCapture(ev.pointerId); } catch (e) { /* egal */ }
    const t = ev.target.closest('[data-ref]');
    drag = { start: { x: ev.clientX, y: ev.clientY }, vx: view.x, vy: view.y, moved: false, ref: t ? t.dataset.ref : null };
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.start.x, dy = ev.clientY - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    autoFit = false;
    view.x = drag.vx - dx / view.k;
    view.y = drag.vy - dy / view.k;
    svg.classList.add('panning');
    applyView();
  });
  const endDrag = () => {
    const d = drag;
    drag = null;
    svg.classList.remove('panning');
    if (!d || d.moved || !d.ref) return;
    // Klick auf ein Gleis: in der Seitenleiste zeigen
    const item = document.querySelector(`#panelStation [data-ref="${CSS.escape(d.ref)}"]`);
    if (item) {
      item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      item.classList.remove('flash'); void item.offsetWidth; item.classList.add('flash');
    }
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', () => { drag = null; svg.classList.remove('panning'); });
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    autoFit = false;
    const zoom = ev.ctrlKey || ev.deltaMode === 1 || (ev.deltaX === 0 && Math.abs(ev.deltaY) >= 50);
    if (zoom) {
      const p = toWorld(ev), r = svg.getBoundingClientRect();
      view.k = clamp(view.k * Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0016)), 0.15, 5);
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
  const sigColor = { E: 'var(--sig-e)', A: 'var(--sig-a)', B: 'var(--sig-z)' };
  const typeSeg = (attr, cur, opts) => `<div class="seg small" role="group">${opts.map(([v, label, title]) =>
    `<button class="btn" ${attr}="${v}" aria-pressed="${cur === v}" title="${title}">${label}</button>`).join('')}</div>`;

  function stationHtml() {
    const terminus = plan.kind === 'terminus';
    const rows = model.platforms.map((p, i) => {
      const r = plan.rows[i];
      const autoTxt = r && p.use === 'auto' ? ST.USE_NAME[r.use] : '';
      const useSel = `<select data-ruse="${esc(p.id)}" aria-label="Richtung Gleis ${i + 1}" ${terminus ? 'disabled title="Kopfbahnhof: alle Gleise in beide Richtungen"' : ''}>
        ${[['auto', `auto${autoTxt ? ` (${autoTxt.split(' ')[0]})` : ''}`], ['east', '→ rechts'], ['west', '← links'], ['both', '⇄ beide']].map(([v, t]) =>
          `<option value="${v}" ${p.use === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
      return `<li class="prow" data-ref="row:${esc(p.id)}"><span class="no">${i + 1}</span>
        <button class="btn typebtn" data-rtype="${esc(p.id)}" data-v="${p.type === 'P' ? 'G' : 'P'}" title="Zugart umschalten (Personen/Güter)">
          <span class="dot" style="background:${ST.TYPE_COLOR[p.type]}"></span>${ST.TYPE_NAME[p.type]}</button>
        ${useSel}
        <span class="rowbtns">
          <button class="btn" data-rmove="${esc(p.id)}" data-d="-1" title="nach oben" aria-label="Gleis ${i + 1} nach oben" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn" data-rmove="${esc(p.id)}" data-d="1" title="nach unten" aria-label="Gleis ${i + 1} nach unten" ${i === model.platforms.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn" data-rdel="${esc(p.id)}" title="entfernen" aria-label="Gleis ${i + 1} entfernen">✕</button>
        </span></li>`;
    }).join('');
    const sideHtml = (X) => {
      const tracks = model[X].tracks, sd = plan.sides[X];
      const list = tracks.map((t, j) => {
        const ls = sd.lines.filter(l => l.trackId === t.id);
        const dirTxt = ls.length === 2 ? 'beide' : ls[0] ? (ls[0].dir === 'in' ? 'rein' : 'raus') : '';
        return `<li class="pline" data-ref="line:${X}:${esc(ls.length === 1 ? ls[0].id : t.id)}"><span class="no">${X === 'left' ? 'L' : 'R'}${j + 1}</span>
          <span class="dirtag">${dirTxt}</span>
          ${typeSeg(`data-ltype="${X}:${j}" data-v`, t.type, [['P', 'P', 'nur Personenzüge'], ['G', 'G', 'nur Güterzüge'], ['PG', 'P+G', 'Personen- und Güterzüge']])}</li>`;
      }).join('');
      return `<div class="row"><span>${X === 'left' ? 'Links' : 'Rechts'}</span><div class="stepper">
          <button class="btn icon" data-lstep="${X}" data-d="-1" aria-label="Weniger Gleise ${X === 'left' ? 'links' : 'rechts'}" ${tracks.length ? '' : 'disabled'}>−</button>
          <output>${tracks.length}</output>
          <button class="btn icon" data-lstep="${X}" data-d="1" aria-label="Mehr Gleise ${X === 'left' ? 'links' : 'rechts'}" ${tracks.length >= 8 ? 'disabled' : ''}>+</button></div></div>
        ${list ? `<ul class="plines">${list}</ul>` : ''}`;
    };
    return `<h2>Bahnhof</h2>
      <div class="row"><input type="text" id="fName" value="${esc(model.name)}" maxlength="40" aria-label="Name des Bahnhofs"></div>
      <h3>Bahnsteiggleise <span class="count">von oben nach unten</span></h3>
      ${rows ? `<ul class="prows">${rows}</ul>` : '<p class="empty">Noch keine Bahnsteiggleise.</p>'}
      <div class="actions">
        <button class="btn" data-addrow="P">＋ Personengleis</button>
        <button class="btn" data-addrow="G">＋ Gütergleis</button>
      </div>
      <p class="fine">Richtung „auto“: beim Durchgangsbahnhof obere Hälfte ${plan.side > 0 ? 'nach links, untere nach rechts' : 'nach rechts, untere nach links'} – so kreuzen sich die Fahrten im Vorfeld nicht.</p>
      <h3>Streckengleise</h3>
      ${sideHtml('left')}${sideHtml('right')}
      <p class="fine">Nur eine Seite = Kopfbahnhof, 1 Gleis = eingleisige Strecke. Rein/raus ergibt sich aus dem ${plan.side > 0 ? 'Rechts' : 'Links'}verkehr.</p>`;
  }

  function guideHtml(P) {
    if (!P.rows.length) return '<h2>Bauanleitung</h2><p class="empty">Noch leer – lege Bahnsteiggleise an oder lade über „Datei“ ein Beispiel.</p>';
    const sec = (id, title, count, body) =>
      `<details data-sec="${id}" ${openSecs[id] ? 'open' : ''}><summary>${title}<span class="count">${count}</span></summary>${body}</details>`;
    const items = (list) => `<ul class="items">${list.map(it => `<li class="item" data-ref="${esc(it.ref)}">
        <span class="tag">${it.label ? esc(it.label) : dots(it.colors || [])}</span>
        <span>${it.title ? `<b>${esc(it.title)}</b><br><span class="sub">${esc(it.text)}</span>` : esc(it.text)}</span></li>`).join('')}</ul>`;
    const steps = P.guide.build.map((st, i) => `<li class="step"${st.refs && st.refs.length ? ` data-ref="${esc(st.refs.join(' '))}"` : ''}>
        <div class="steptitle"><span class="stepno">${i + 1}</span>${esc(st.title)}</div><div class="sub">${esc(st.text)}</div></li>`).join('');
    const sigs = P.guide.signals.map(r => `<li class="item" data-ref="${r.label}">
        <span class="tag" style="color:${sigColor[r.kind]}">${r.label}</span>
        <span>${esc(r.place)}<br><span class="sub"><span class="arrow" style="transform:rotate(${Math.round(r.angle)}deg)">➜</span>
        ${esc(r.dir)} · Einbahn: <b>${r.oneWay ? 'Ja' : 'Nein'}</b> · ${esc(r.cond)}</span></span></li>`).join('');
    return `<h2>Bauanleitung</h2><div class="guide">
      ${steps ? sec('build', 'Bauablauf', `${P.guide.build.length} Schritte`, `<ol class="steps">${steps}</ol>`) : ''}
      ${sec('rows', 'Bahnsteiggleise', P.rows.length, items(P.guide.rows))}
      ${P.guide.lines.length ? sec('lines', 'Streckengleise', P.guide.lines.length, items(P.guide.lines)) : ''}
      ${P.signals.length ? sec('signals', 'Signale', P.signals.length, `<ul class="items">${sigs}</ul><p class="fine">Pfeil = Fahrtrichtung, für die das Signal gilt.</p>`) : ''}
      ${P.crossings.length ? sec('crossings', 'Flachkreuzungen', P.crossings.length, items(P.guide.crossings)) : ''}
      ${P.switches.length ? sec('switches', 'Weichen', P.stats.switches, items(P.guide.switches)) : ''}
    </div>`;
  }

  function notesHtml(P) {
    if (!P.notes.length) return '<h2>Hinweise</h2><p class="empty">Keine Hinweise.</p>';
    return `<h2>Hinweise</h2><ul class="notes">${P.notes.map(n =>
      `<li class="note ${n.level}"${n.refs && n.refs.length ? ` data-ref="${esc(n.refs.join(' '))}"` : ''}>${esc(n.text)}</li>`).join('')}</ul>`;
  }

  function renderSide() {
    const active = document.activeElement;
    const keep = active && active.id === 'fName' ? { s: active.selectionStart, e: active.selectionEnd } : null;
    $('#panelStation').innerHTML = stationHtml();
    if (keep) { const f = $('#fName'); if (f) { f.focus(); f.setSelectionRange(keep.s, keep.e); } }
    $('#panelGuide').innerHTML = guideHtml(plan);
    $('#panelNotes').innerHTML = notesHtml(plan);
    document.querySelectorAll('[data-layer]').forEach(b => b.setAttribute('aria-pressed', String(!!model.settings.layers[b.dataset.layer])));
    document.querySelectorAll('[data-setting]').forEach(b => b.setAttribute('aria-pressed', String(model.settings[b.dataset.setting] === b.dataset.value)));
    $('#btnUndo').disabled = !hist.undo.length;
    $('#btnRedo').disabled = !hist.redo.length;
    if (hover) document.querySelectorAll(`.side [data-ref="${CSS.escape(hover)}"]`).forEach(e => e.classList.add('hl'));
  }

  // Eingaben im Bahnhofs-Panel
  let nameSnap = null;
  const panel = $('#panelStation');
  panel.addEventListener('focusin', (ev) => { if (ev.target.id === 'fName') nameSnap = snapshot(); });
  panel.addEventListener('input', (ev) => {
    if (ev.target.id !== 'fName') return;
    model.name = ev.target.value.slice(0, 40) || model.name;
    draw();
  });
  panel.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.id === 'fName') {
      if (nameSnap && nameSnap !== snapshot()) { hist.undo.push(nameSnap); hist.redo.length = 0; }
      nameSnap = null; model = ST.normalizeStation(model); save(); refresh();
    } else if (t.dataset.ruse) {
      const id = t.dataset.ruse;
      commit(() => { model.platforms.find(p => p.id === id).use = t.value; });
    }
  });
  panel.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    const d = +b.dataset.d || 0;
    if (b.dataset.rtype) {
      const id = b.dataset.rtype, v = b.dataset.v;
      commit(() => { model.platforms.find(p => p.id === id).type = v; });
    } else if (b.dataset.rmove) {
      const i = model.platforms.findIndex(p => p.id === b.dataset.rmove), j = i + d;
      if (j < 0 || j >= model.platforms.length) return;
      commit(() => { const a = model.platforms; [a[i], a[j]] = [a[j], a[i]]; });
    } else if (b.dataset.rdel) {
      const id = b.dataset.rdel;
      commit(() => { model.platforms = model.platforms.filter(p => p.id !== id); });
    } else if (b.dataset.addrow) {
      addRow(b.dataset.addrow);
    } else if (b.dataset.lstep) {
      const X = b.dataset.lstep;
      commit(() => {
        const t = model[X].tracks;
        if (d > 0 && t.length < 8) t.push({ id: uid(X[0]), type: 'PG' });
        if (d < 0 && t.length) t.pop();
      });
    } else if (b.dataset.ltype) {
      const [X, j] = b.dataset.ltype.split(':');
      commit(() => { model[X].tracks[+j].type = b.dataset.v; });
    }
  });
  function addRow(type) {
    if (model.platforms.length >= 16) { toast('Mehr als 16 Bahnsteiggleise gehen nicht'); return; }
    commit(() => { model.platforms.push({ id: uid('p'), type, use: 'auto' }); });
  }

  // Bauanleitung: offene Abschnitte merken
  $('#panelGuide').addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (d.dataset && d.dataset.sec) openSecs[d.dataset.sec] = d.open;
  }, true);

  // Hover-Kopplung Liste ↔ Zeichnung
  document.addEventListener('mouseover', (ev) => {
    const t = ev.target.closest && ev.target.closest('[data-ref]');
    const ref = t ? t.dataset.ref : null;
    if (ref === hover) return;
    hover = ref;
    SR.highlight(svg, plan, hover);
    document.querySelectorAll('.side .hl').forEach(e => e.classList.remove('hl'));
    if (ref) document.querySelectorAll(`.side [data-ref="${CSS.escape(ref)}"]`).forEach(e => e.classList.add('hl'));
  });

  // ── Werkzeugleiste, Einstellungen, Datei ──
  $('#btnAddRow').addEventListener('click', () => addRow('P'));
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
      commit(() => { model = ST.example(act.slice(8)); });
      fit();
      toast('Beispiel geladen – ⌘Z macht es rückgängig');
    } else if (act === 'new') {
      commit(() => { model = ST.normalizeStation({ name: 'Neuer Bahnhof', platforms: [{ type: 'P' }, { type: 'P' }], left: { tracks: [{ type: 'PG' }, { type: 'PG' }] }, right: { tracks: [{ type: 'PG' }, { type: 'PG' }] } }); });
      fit();
      toast('Neuer Bahnhof – Gleise rechts in der Seitenleiste einstellen');
    } else if (act === 'save-json') {
      download(new Blob([JSON.stringify(model, null, 2)], { type: 'application/json' }), 'bahnhof.json');
    } else if (act === 'load-json') {
      $('#fileInput').click();
    } else if (act === 'export-svg') {
      download(new Blob([new XMLSerializer().serializeToString(exportSvg())], { type: 'image/svg+xml' }), 'bahnhof.svg');
    } else if (act === 'export-png') exportPng();
  });
  $('#fileInput').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.kind !== 'station') throw new Error('kein Bahnhof');
      commit(() => { model = ST.normalizeStation(data); });
      fit();
      toast(`„${file.name}“ geladen`);
    } catch (e) {
      toast('Die Datei ist kein gültiger Bahnhofsplan');
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
    const b = SR.bounds(plan), pad = 30;
    const vb = { x: b.x0 - pad, y: b.y0 - pad, w: Math.round(b.x1 - b.x0 + 2 * pad), h: Math.round(b.y1 - b.y0 + 2 * pad) };
    const out = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    out.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    out.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    out.setAttribute('width', vb.w);
    out.setAttribute('height', vb.h);
    SR.render(out, plan, model, { viewBox: vb, exporting: true });
    return out;
  }
  function exportPng() {
    const node = exportSvg();
    const w = +node.getAttribute('width'), h = +node.getAttribute('height');
    const scale = Math.min(2.5, 4096 / Math.max(w, h));
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = Math.round(w * scale); c.height = Math.round(h * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(bl => (bl ? download(bl, 'bahnhof.png') : toast('PNG-Export fehlgeschlagen')), 'image/png');
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

  document.addEventListener('keydown', (ev) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName);
    const mod = ev.metaKey || ev.ctrlKey, key = ev.key.toLowerCase();
    if (mod && key === 'z' && !typing) { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); }
    else if (mod && key === 'y' && !typing) { ev.preventDefault(); redo(); }
    else if (ev.key === 'Escape') { if (!menu.hidden) closeMenu(); else if (typing) ev.target.blur(); }
  });

  // ── Start ──
  refresh();
  requestAnimationFrame(fit);
  R.setAnimation(svg, animOn);
  updateAnimButton();
  if (window.GP.common) window.GP.common.watchUpdates('station-editor.js');
  window.GP.stationEditor = { get model() { return model; }, get plan() { return plan; }, refresh, fit };
})();
