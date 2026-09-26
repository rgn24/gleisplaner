/* Gleisknoten-Planer – gemeinsame Helfer für beide Planer (Version, Update-Hinweis) */
(function (root) {
  'use strict';
  const C = {};

  // Version aus dem ?v= der eigenen Script-Adresse (wird bei jeder Veröffentlichung hochgezählt)
  C.versionOf = (scriptName) => {
    const el = [...document.scripts].find(s => s.src.includes(scriptName));
    const m = el && /[?&]v=(\d+)/.exec(el.src);
    return m ? +m[1] : 0;
  };

  // GitHub Pages hält Seiten bis zu 10 Minuten im Browser-Cache. Deshalb nachsehen, ob es eine neuere
  // Fassung gibt, und dann einen Hinweis mit „Jetzt laden“ zeigen.
  C.watchUpdates = (scriptName) => {
    const mine = C.versionOf(scriptName);
    if (/[?&]v=\d+/.test(location.search)) history.replaceState(null, '', location.pathname + location.hash);
    document.querySelectorAll('[data-version]').forEach(el => { el.textContent = mine ? `Version ${mine}` : ''; });
    if (!mine || location.protocol === 'file:') return;
    const re = new RegExp(scriptName.replace(/\./g, '\\.') + '\\?v=(\\d+)');
    let last = 0;
    const show = (v) => {
      if (document.getElementById('updateBar')) return;
      const bar = document.createElement('div');
      bar.id = 'updateBar';
      bar.className = 'updatebar';
      bar.setAttribute('role', 'status');
      bar.innerHTML = `<span>Neue Version ${v} verfügbar</span><button class="btn primary">Jetzt laden</button>`;
      bar.querySelector('button').addEventListener('click', () => location.replace(`${location.pathname}?v=${v}${location.hash}`));
      document.body.appendChild(bar);
    };
    const check = async () => {
      if (Date.now() - last < 60000) return;
      last = Date.now();
      try {
        const html = await (await fetch(location.pathname, { cache: 'no-store' })).text();
        const m = re.exec(html);
        if (m && +m[1] > mine) show(+m[1]);
      } catch (e) { /* offline – dann eben nicht */ }
    };
    setTimeout(check, 1500);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  };

  root.GP = root.GP || {};
  root.GP.common = C;
})(typeof globalThis !== 'undefined' ? globalThis : this);
