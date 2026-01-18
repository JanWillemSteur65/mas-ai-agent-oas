(function () {
  const HASH = '#/relationships';
  const POLL_MS = 250;
  const MAX_POLLS = 80;

  function h(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (k === 'class') n.className = v;
        else if (k === 'style') Object.assign(n.style, v);
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
        else n.setAttribute(k, v);
      }
    }
    (children || []).forEach(c => {
      if (c == null) return;
      if (typeof c === 'string') n.appendChild(document.createTextNode(c));
      else n.appendChild(c);
    });
    return n;
  }

  function q(sel, root) { return (root || document).querySelector(sel); }

  function showMain(show) {
    const root = q('#root');
    if (root) root.style.display = show ? '' : 'none';
  }

  function ensureOverlay() {
    let wrap = q('#rel_admin_overlay');
    if (wrap) return wrap;
    wrap = h('div', { id: 'rel_admin_overlay', style: {
      display: 'none',
      position: 'fixed',
      inset: '0',
      overflow: 'auto',
      background: 'var(--cds-layer-01, #fff)',
      zIndex: '9999',
      padding: '16px'
    }}, []);
    document.body.appendChild(wrap);
    return wrap;
  }

  async function apiGet(url) {
    const r = await fetch(url, { credentials: 'include' });
    const txt = await r.text();
    let data;
    try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }
    if (!r.ok) throw new Error(data?.detail || data?.error || txt || (r.status + ' ' + r.statusText));
    return data;
  }

  async function apiPut(url, body) {
    const r = await fetch(url, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const txt = await r.text();
    let data;
    try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }
    if (!r.ok) throw new Error(data?.detail || data?.error || txt || (r.status + ' ' + r.statusText));
    return data;
  }

  function render() {
    const overlay = ensureOverlay();
    overlay.innerHTML = '';

    const state = {
      tenant: 'default',
      scope: 'tenant',
      items: [],
      loading: false,
      error: null,
      info: null
    };

    const title = h('div', { class: 'bx--type-productive-heading-04', style: { marginBottom: '8px' } }, ['Relationships']);

    const errBox = h('div', { style: { color: '#b00', margin: '8px 0', display: 'none' } }, []);
    const infoBox = h('div', { style: { color: '#0a0', margin: '8px 0', display: 'none' } }, []);

    const tenantInput = h('input', { value: state.tenant, style: { width: '220px', padding: '6px' } }, []);
    const scopeSel = h('select', { style: { width: '160px', padding: '6px' } }, [
      h('option', { value: 'tenant' }, ['Tenant override (editable)']),
      h('option', { value: 'defaults' }, ['Defaults (editable)']),
      h('option', { value: 'effective' }, ['Effective merged (read-only)'])
    ]);

    const btnLoad = h('button', { style: { padding: '6px 10px' }, onclick: () => load() }, ['Reload']);
    const btnSave = h('button', { style: { padding: '6px 10px' }, onclick: () => save() }, ['Save']);
    const btnClose = h('button', { style: { padding: '6px 10px' }, onclick: () => { location.hash = '#/'; } }, ['Close']);

    const controls = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' } }, [
      h('label', { style: { fontSize: '12px' } }, ['Tenant: ']),
      tenantInput,
      h('label', { style: { fontSize: '12px', marginLeft: '6px' } }, ['Scope: ']),
      scopeSel,
      btnLoad,
      btnSave,
      btnClose,
      h('span', { style: { fontSize: '12px', opacity: '0.7', marginLeft: '8px' } }, ['Tip: Scope "Effective" is read-only'])
    ]);

    const table = h('table', { style: { width: '100%', borderCollapse: 'collapse', marginTop: '8px' } }, []);

    function setError(msg) {
      errBox.style.display = msg ? '' : 'none';
      errBox.textContent = msg || '';
    }
    function setInfo(msg) {
      infoBox.style.display = msg ? '' : 'none';
      infoBox.textContent = msg || '';
    }

    function renderTable() {
      table.innerHTML = '';
      const head = h('tr', null, ['Root OS','Alias','Related OS','Join','Enabled','MaxKeys','Extra where',''].map(t =>
        h('th', { style: { textAlign: 'left', borderBottom: '1px solid #ddd', padding: '6px', fontSize: '12px' } }, [t])
      ));
      table.appendChild(head);
      (state.items || []).forEach((it, idx) => {
        const row = h('tr', null, []);
        function td(child) { return h('td', { style: { borderBottom: '1px solid #eee', padding: '6px', verticalAlign: 'top' } }, [child]); }
        const rootOs = h('input', { value: it.rootOs || '', style: { width: '140px' } }, []);
        const alias = h('input', { value: it.alias || '', style: { width: '120px' } }, []);
        const relatedOs = h('input', { value: it.relatedOs || '', style: { width: '150px' } }, []);
        const join = h('div', null, [
          h('input', { value: it.rootJoinField || '', placeholder: 'root field', style: { width: '120px' } }, []),
          h('span', { style: { padding: '0 6px', opacity: '0.7' } }, ['↔']),
          h('input', { value: it.relatedKeyField || '', placeholder: 'related key', style: { width: '120px' } }, [])
        ]);
        const enabled = h('input', { type: 'checkbox' }, []);
        enabled.checked = it.enabled !== false;
        const maxKeys = h('input', { type: 'number', value: (it.maxKeys ?? 200), style: { width: '90px' } }, []);
        const extra = h('input', { value: it.relatedWhereExtra || '', placeholder: 'optional', style: { width: '220px' } }, []);
        const del = h('button', { onclick: () => { state.items.splice(idx, 1); renderTable(); } }, ['Delete']);

        // bind
        rootOs.addEventListener('input', () => it.rootOs = rootOs.value);
        alias.addEventListener('input', () => it.alias = alias.value);
        relatedOs.addEventListener('input', () => it.relatedOs = relatedOs.value);
        join.querySelectorAll('input')[0].addEventListener('input', (e) => it.rootJoinField = e.target.value);
        join.querySelectorAll('input')[1].addEventListener('input', (e) => it.relatedKeyField = e.target.value);
        enabled.addEventListener('change', () => it.enabled = enabled.checked);
        maxKeys.addEventListener('input', () => it.maxKeys = Number(maxKeys.value || 0));
        extra.addEventListener('input', () => it.relatedWhereExtra = extra.value);

        row.appendChild(td(rootOs));
        row.appendChild(td(alias));
        row.appendChild(td(relatedOs));
        row.appendChild(td(join));
        row.appendChild(td(enabled));
        row.appendChild(td(maxKeys));
        row.appendChild(td(extra));
        row.appendChild(td(del));
        table.appendChild(row);
      });

      // add row button
      const addBtn = h('button', { style: { marginTop: '10px', padding: '6px 10px' }, onclick: () => {
        state.items.push({ rootOs: '', alias: '', relatedOs: '', rootJoinField: '', relatedKeyField: '', enabled: true, maxKeys: 200, relatedWhereExtra: '' });
        renderTable();
      }}, ['Add relationship']);
      overlay.appendChild(addBtn);
    }

    async function load() {
      setError(null); setInfo(null);
      state.tenant = tenantInput.value.trim() || 'default';
      state.scope = scopeSel.value;
      const qs = new URLSearchParams({ tenant: state.tenant, scope: state.scope });
      try {
        const data = await apiGet('/api/relationships?' + qs.toString());
        state.items = Array.isArray(data.relationships) ? data.relationships : (data.items || []);
        renderTable();
        setInfo('Loaded ' + state.items.length + ' relationships (' + data.scope + ').');
      } catch (e) {
        setError(String(e.message || e));
      }
    }

    function validate() {
      const bad = [];
      (state.items || []).forEach((it, i) => {
        if (!it.rootOs || !it.alias || !it.relatedOs || !it.rootJoinField || !it.relatedKeyField) bad.push(i + 1);
      });
      if (bad.length) throw new Error('Missing required fields in row(s): ' + bad.join(', '));
      const seen = new Set();
      for (const it of state.items) {
        const key = it.rootOs + '::' + it.alias;
        if (seen.has(key)) throw new Error('Duplicate rootOs+alias: ' + key);
        seen.add(key);
      }
    }

    async function save() {
      setError(null); setInfo(null);
      state.tenant = tenantInput.value.trim() || 'default';
      state.scope = scopeSel.value;
      if (state.scope === 'effective') { setError('Effective scope is read-only. Switch to Tenant or Defaults to save.'); return; }
      try {
        validate();
        const qs = new URLSearchParams({ tenant: state.tenant, scope: state.scope });
        const out = { relationships: state.items };
        const data = await apiPut('/api/relationships?' + qs.toString(), out);
        setInfo('Saved. Backup: ' + (data.backupFile || 'n/a'));
        await load();
      } catch (e) {
        setError(String(e.message || e));
      }
    }

    scopeSel.value = state.scope;
    tenantInput.addEventListener('change', () => { state.tenant = tenantInput.value.trim() || 'default'; });
    scopeSel.addEventListener('change', () => { state.scope = scopeSel.value; });

    overlay.appendChild(title);
    overlay.appendChild(controls);
    overlay.appendChild(errBox);
    overlay.appendChild(infoBox);
    overlay.appendChild(table);

    load();
  }

  function activate() {
    const overlay = ensureOverlay();
    overlay.style.display = '';
    showMain(false);
    render();
  }

  function deactivate() {
    const overlay = ensureOverlay();
    overlay.style.display = 'none';
    showMain(true);
  }

  function onRoute() {
    if (location.hash === HASH) activate();
    else deactivate();
  }

  function injectNav() {
    let polls = 0;
    const t = setInterval(() => {
      polls++;

      if (document.querySelector('#rel_nav_item')) { clearInterval(t); return; }

      // Try to find an existing side-nav link and walk up to its container.
      const anchors = Array.from(document.querySelectorAll('a'));
      const known = new Set(['Dashboard','Tools','Concepts','Tenants','Logs','Messages','Trace','Settings','Users']);
      const hit = anchors.find(a => known.has((a.textContent || '').trim()));

      // Carbon side nav typically uses <ul> lists, but markup can vary. Be flexible.
      const ul = hit ? hit.closest('ul') : null;
      const navHost = ul || document.querySelector('nav ul') || document.querySelector('aside ul') || null;

      if (!navHost) {
        if (polls > MAX_POLLS) clearInterval(t);
        return;
      }

      // Try to copy classes from an existing nav item for consistent styling.
      const sampleLi = (hit && hit.closest('li')) || navHost.querySelector('li');
      const sampleA  = hit || navHost.querySelector('a');

      const li = document.createElement('li');
      li.id = 'rel_nav_item';
      if (sampleLi && sampleLi.className) li.className = sampleLi.className;
      else {
        li.style.listStyle = 'none';
        li.style.margin = '4px 0';
      }

      const a = document.createElement('a');
      a.href = HASH;
      a.textContent = 'Relationships';
      if (sampleA && sampleA.className) a.className = sampleA.className;
      else {
        a.style.cursor = 'pointer';
        a.style.display = 'block';
        a.style.padding = '6px 12px';
        a.style.textDecoration = 'none';
        a.style.color = 'inherit';
      }

      a.addEventListener('click', (e) => {
        e.preventDefault();
        location.hash = HASH;
      });

      li.appendChild(a);

      // Insert near Settings/Users if we can, otherwise append.
      const settingsA = anchors.find(x => (x.textContent || '').trim() === 'Settings');
      const settingsLi = settingsA ? settingsA.closest('li') : null;
      if (settingsLi && settingsLi.parentElement === navHost) {
        settingsLi.insertAdjacentElement('afterend', li);
      } else {
        navHost.appendChild(li);
      }

      clearInterval(t);
    }, POLL_MS);
  }



  window.addEventListener('hashchange', onRoute);
  document.addEventListener('DOMContentLoaded', () => {
    injectNav();
    onRoute();
  });
})();
