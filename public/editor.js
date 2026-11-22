// Editor SPA. Vanilla ES modules; shares section + theme definitions with the server
// via /shared/*. Undo/redo keeps draft snapshots; autosave sends the draft to PUT /draft.
import { SECTION_TYPES, GLOBAL_TYPES, SECTION_LIST_TYPES, defaultSection } from '/shared/registry.js';
import { PRESETS, contrastWarnings } from '/shared/theme.js';

const app = document.getElementById('app');
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => crypto.randomUUID();

const S = {
  token: null, user: null, workspaces: [], sites: [],
  site: null, theme: null, pages: [], sections: [], version: 1, versions: [], domains: [],
  pageId: null, selId: null, device: 'desktop', history: [], hIndex: -1, lastLabel: '', lastT: 0,
  saveTimer: null, saving: false, status: '',
};

// ---------- api ----------
async function api(method, path, body) {
  const headers = {};
  if (S.token) headers.Authorization = `Bearer ${S.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api/v1${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) { const e = new Error(data.error || res.statusText); e.status = res.status; e.data = data; throw e; }
  return data;
}

const session = {
  get() { try { return JSON.parse(localStorage.getItem('wb-session') || 'null'); } catch { return null; } },
  set(v) { try { localStorage.setItem('wb-session', JSON.stringify(v)); } catch {} },
  clear() { try { localStorage.removeItem('wb-session'); } catch {} },
};

// ---------- screens ----------
function renderAuth(msg = '') {
  app.innerHTML = `<div class="card">
    <h2>Site Builder</h2>
    <div class="seg" style="margin-bottom:10px"><button id="tabLogin" class="on">Log in</button><button id="tabReg">Sign up</button></div>
    <form id="authForm">
      <div id="nameRow" style="display:none"><label>Name<input name="name" autocomplete="name"></label></div>
      <label>Email<input name="email" type="email" required autocomplete="email"></label>
      <label>Password<input name="password" type="password" required minlength="8" autocomplete="current-password"></label>
      <div class="err" id="authErr">${esc(msg)}</div>
      <button class="primary" style="width:100%" type="submit" id="authBtn">Log in</button>
    </form></div>`;
  let mode = 'login';
  const setMode = (m) => {
    mode = m;
    $('#tabLogin').classList.toggle('on', m === 'login');
    $('#tabReg').classList.toggle('on', m === 'register');
    $('#nameRow').style.display = m === 'register' ? '' : 'none';
    $('#authBtn').textContent = m === 'login' ? 'Log in' : 'Create account';
    $('input[name=password]').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  };
  $('#tabLogin').onclick = () => setMode('login');
  $('#tabReg').onclick = () => setMode('register');
  $('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      const out = await api('POST', mode === 'login' ? '/auth/login' : '/auth/register', f);
      S.token = out.token; S.user = out.user; session.set({ token: out.token });
      await loadDashboard();
    } catch (err) { $('#authErr').textContent = err.message; }
  };
}

async function loadDashboard() {
  const [{ workspaces }, { sites }, { templates }] = await Promise.all([api('GET', '/workspaces'), api('GET', '/sites'), api('GET', '/templates')]);
  S.workspaces = workspaces;
  S.sites = sites;
  const ws = workspaces[0];
  app.innerHTML = `<div class="top"><strong>Site Builder</strong><div class="row"><span class="muted">${esc(S.user.email)}</span><button id="logout">Log out</button></div></div>
    <div class="wrap">
      <div class="row" style="justify-content:space-between;margin-bottom:16px"><h2 style="margin:0;font-size:20px">Your sites</h2></div>
      <div class="site-card" style="margin-bottom:16px"><h3 style="margin-top:0">New site</h3>
        <form id="newSite" class="row">
          <input name="name" placeholder="Site name" required style="max-width:200px">
          <input name="subdomain" placeholder="subdomain" pattern="[a-z0-9-]{3,40}" style="max-width:180px">
          <select name="template" style="max-width:180px">${templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
          <button class="primary" type="submit">Create</button>
          <span class="err" id="newErr"></span>
        </form></div>
      <div class="site-list">${S.sites.map((s) => `<div class="site-card">
          <strong>${esc(s.name)}</strong>
          <div class="muted">${esc(s.subdomain)}.${location.hostname === 'localhost' ? 'localhost:' + location.port + '/s/' + esc(s.subdomain) : ''} · ${esc(s.status)}</div>
          <div class="row" style="margin-top:10px"><button data-open="${s._id}" class="primary">Edit</button>
          ${location.hostname === 'localhost' ? `<a href="/s/${esc(s.subdomain)}" target="_blank" rel="noopener">View live</a>` : ''}</div>
        </div>`).join('') || '<p class="muted">No sites yet. Create one above.</p>'}</div>
    </div>`;
  $('#logout').onclick = async () => { try { await api('POST', '/auth/logout'); } catch {} session.clear(); S.token = null; renderAuth(); };
  $('#newSite').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (!f.subdomain) f.subdomain = f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    try {
      const { site } = await api('POST', '/sites', { ...f, workspaceId: ws._id });
      await openSite(site._id);
    } catch (err) { $('#newErr').textContent = err.message; }
  };
  app.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => openSite(b.dataset.open)));
}

// ---------- editor ----------
async function openSite(id) {
  const data = await api('GET', `/sites/${id}`);
  S.site = data.site; S.theme = data.theme; S.pages = data.pages; S.sections = data.sections;
  S.version = data.site.draftVersion; S.versions = data.versions; S.domains = data.domains || [];
  S.pageId = (S.pages.find((p) => p.isHome) || S.pages[0])?.id || S.pages[0]?._id;
  S.selId = null; S.history = []; S.hIndex = -1;
  pushHistory('init', true);
  renderEditor();
  refreshPreview();
}

const draft = () => ({ theme: S.theme, pages: S.pages, sections: S.sections });
function pushHistory(label, force = false) {
  const snap = JSON.stringify(draft());
  const t = Date.now();
  if (!force && label === S.lastLabel && t - S.lastT < 900 && S.hIndex >= 0) {
    S.history[S.hIndex] = snap; // coalesce typing into one undo step
  } else {
    S.history = S.history.slice(0, S.hIndex + 1);
    S.history.push(snap);
    if (S.history.length > 150) S.history.shift();
    S.hIndex = S.history.length - 1;
  }
  S.lastLabel = label; S.lastT = t;
}

function commit(label = 'edit') {
  pushHistory(label);
  scheduleSave();
  refreshUndoButtons();
}

function scheduleSave() {
  clearTimeout(S.saveTimer);
  setStatus('Unsaved changes…');
  S.saveTimer = setTimeout(saveDraft, 600);
}

async function saveDraft() {
  if (S.saving) { scheduleSave(); return; }
  S.saving = true;
  try {
    const payload = JSON.parse(JSON.stringify(draft()));
    const out = await api('PUT', `/sites/${S.site._id}/draft`, { version: S.version, ...payload });
    S.version = out.version;
    setStatus(out.warnings?.length ? 'Saved' : 'Saved', out.warnings);
    refreshPreview();
  } catch (err) {
    if (err.status === 409) { setStatus('Changed elsewhere — reload the site to continue'); }
    else setStatus('Save failed: ' + err.message);
  } finally { S.saving = false; }
}

function setStatus(text, warnings) {
  const el = $('#status');
  if (el) el.textContent = text + (warnings && warnings.length ? ' · contrast: ' + warnings.length + ' issue(s)' : '');
}

function refreshUndoButtons() {
  const u = $('#undo'), r = $('#redo');
  if (u) u.disabled = S.hIndex <= 0;
  if (r) r.disabled = S.hIndex >= S.history.length - 1;
}

function undo() { if (S.hIndex > 0) { S.hIndex--; applySnap(); } }
function redo() { if (S.hIndex < S.history.length - 1) { S.hIndex++; applySnap(); } }
function applySnap() {
  const d = JSON.parse(S.history[S.hIndex]);
  S.theme = d.theme; S.pages = d.pages; S.sections = d.sections;
  if (!S.pages.some((p) => p._id === S.pageId)) S.pageId = S.pages[0]?._id;
  if (!S.sections.some((s) => s._id === S.selId)) S.selId = null;
  scheduleSave();
  renderEditor();
}

async function refreshPreview() {
  if (!S.site) return;
  try {
    const html = await api('POST', `/sites/${S.site._id}/preview`, { pageId: S.pageId });
    const frame = $('#canvas');
    if (frame) frame.srcdoc = html;
  } catch (err) { setStatus('Preview failed: ' + err.message); }
}

const pageSections = () => S.sections.filter((s) => s.pageId === S.pageId).sort((a, b) => a.order - b.order);
const globalOf = (type) => S.sections.find((s) => s.pageId == null && s.type === type);
const find = (id) => S.sections.find((s) => s._id === id) || S.pages.find((p) => p._id === id);

function renderEditor() {
  app.innerHTML = `<div class="editor">
    <div class="bar">
      <span class="title">${esc(S.site.name)}</span>
      <button id="back">← Sites</button>
      <button id="undo" title="Undo (Ctrl+Z)">Undo</button>
      <button id="redo" title="Redo (Ctrl+Shift+Z)">Redo</button>
      <div class="seg" id="device"><button data-dev="desktop" class="${S.device === 'desktop' ? 'on' : ''}">Desktop</button><button data-dev="tablet" class="${S.device === 'tablet' ? 'on' : ''}">Tablet</button><button data-dev="mobile" class="${S.device === 'mobile' ? 'on' : ''}">Mobile</button></div>
      <button id="versions">Versions & domains</button>
      <span class="status" id="status">${esc(S.site.status)}</span>
      <button class="primary" id="publish">Publish</button>
    </div>
    <div class="cols">
      <aside class="side" id="left">${leftHtml()}</aside>
      <main class="canvas"><iframe id="canvas" title="Site preview" style="max-width:${{ desktop: '100%', tablet: '768px', mobile: '390px' }[S.device]}"></iframe></main>
      <aside class="side right" id="right">${rightHtml()}</aside>
    </div></div>`;
  wireEditor();
  refreshUndoButtons();
}

function leftHtml() {
  const pageList = S.pages.map((p) => `<li data-page="${p._id}" class="${p._id === S.pageId ? 'sel' : ''}"><span class="grow">${esc(p.title)}${p.isHome ? ' 🏠' : ''}</span></li>`).join('');
  const layers = pageSections();
  const layerItem = (s) => `<li draggable="true" data-sec="${s._id}" class="${s._id === S.selId ? 'sel' : ''}"><span class="grow">${esc(SECTION_TYPES[s.type].label)} <span class="muted">· ${esc(s.variant)}</span></span></li>`;
  return `<h3>Pages</h3>
    <ul class="list" id="pages">${pageList}</ul>
    <div class="row" style="margin-top:6px"><button id="addPage">+ Page</button><button id="renamePage">Rename</button><button id="delPage" class="danger">Delete</button></div>
    <h3>Header</h3><ul class="list">${layerItemGlobal('header', layerItem)}</ul>
    <h3>Sections on this page</h3>
    <ul class="list" id="layers">${layers.map(layerItem).join('') || '<li class="muted">Add a section below</li>'}</ul>
    <h3>Footer</h3><ul class="list">${layerItemGlobal('footer', layerItem)}</ul>
    <h3>Add section</h3>
    <div class="lib">${SECTION_LIST_TYPES.map((t) => `<button data-add="${t}">${esc(SECTION_TYPES[t].label)}</button>`).join('')}</div>`;
}
const layerItemGlobal = (type, item) => { const s = globalOf(type); return s ? item(s) : ''; };

function rightHtml() {
  const sel = S.sections.find((s) => s._id === S.selId);
  if (sel) return inspectorHtml(sel);
  const pg = S.pages.find((p) => p._id === S.pageId);
  return `${pageSettingsHtml(pg)}<h2 style="margin-top:18px">Theme</h2>${themeHtml()}`;
}

function pageSettingsHtml(pg) {
  if (!pg) return '';
  return `<h2>Page</h2>
    <label>Title<input data-pg="title" value="${esc(pg.title)}"></label>
    <label>URL slug<input data-pg="slug" value="${esc(pg.slug)}"></label>
    <label>SEO title<input data-pg="seo.title" value="${esc(pg.seo?.title || '')}" maxlength="70"></label>
    <label>SEO description<textarea data-pg="seo.description" maxlength="170">${esc(pg.seo?.description || '')}</textarea></label>
    <label class="inline"><input type="checkbox" data-pg="seo.noindex" ${pg.seo?.noindex ? 'checked' : ''}> Hide from search engines</label>
    <label class="inline"><input type="checkbox" data-pg="hideInNav" ${pg.hideInNav ? 'checked' : ''}> Hide from menu</label>
    <label class="inline"><input type="checkbox" data-pg="isHome" ${pg.isHome ? 'checked' : ''}> Home page</label>`;
}

function inspectorHtml(sec) {
  const def = SECTION_TYPES[sec.type];
  const fields = def.schema.map((f) => {
    const v = esc(sec.props[f.key] ?? '');
    if (f.kind === 'textarea' || f.kind === 'lines') return `<label>${esc(f.label)}<textarea data-prop="${f.key}" maxlength="${f.max || 500}">${v}</textarea></label>`;
    return `<label>${esc(f.label)}<input data-prop="${f.key}" value="${v}" maxlength="${f.max || 500}"></label>`;
  }).join('');
  const sel = (key, opts, val) => `<label>${key}<select data-style="${key}">${opts.map((o) => `<option value="${o}" ${o === val ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
  const idx = pageSections().findIndex((s) => s._id === sec.id || s._id === sec._id);
  return `<h2>${esc(def.label)}</h2>
    <div class="row"><button data-move="-1">↑ Up</button><button data-move="1">↓ Down</button><button class="danger" id="delSec">Delete</button></div>
    <h3>Content</h3>${fields}
    <h3>Style</h3>
    ${sel('variant', def.variants, sec.variant)}
    ${sel('paddingY', ['none', 'sm', 'md', 'xl'], sec.styles.base.paddingY)}
    ${sel('background', ['background', 'surface', 'primary', 'secondary'], sec.styles.base.background)}
    ${sel('textAlign', ['left', 'center', 'right'], sec.styles.base.textAlign)}
    <h3>Visibility</h3>
    <label class="inline"><input type="checkbox" data-vis="desktop" ${sec.visibility.desktop ? 'checked' : ''}> Desktop</label>
    <label class="inline"><input type="checkbox" data-vis="tablet" ${sec.visibility.tablet ? 'checked' : ''}> Tablet</label>
    <label class="inline"><input type="checkbox" data-vis="mobile" ${sec.visibility.mobile ? 'checked' : ''}> Mobile</label>
    <p class="muted" style="font-size:12px">${idx >= 0 ? `Position ${idx + 1} on page` : 'Site-wide section'}</p>`;
}

const COLOR_KEYS = ['primary', 'secondary', 'accent', 'background', 'surface', 'text', 'muted'];
function themeHtml() {
  const t = S.theme;
  const warn = contrastWarnings(t);
  return `<label>Preset<select id="preset"><option value="">Choose…</option>${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.name)}</option>`).join('')}</select></label>
    <h3>Colors</h3>
    <div class="lib" style="grid-template-columns:1fr 1fr">${COLOR_KEYS.map((k) => `<label>${k}<input type="color" data-color="${k}" value="${t.colors[k]}" style="height:34px;padding:2px"></label>`).join('')}</div>
    <h3>Typography</h3>
    <label>Heading font<input data-font="headingFont" value="${esc(t.typography.headingFont)}"></label>
    <label>Body font<input data-font="bodyFont" value="${esc(t.typography.bodyFont)}"></label>
    <h3>Shape & spacing</h3>
    <label>Radius<select data-theme="radius">${['sm', 'md', 'lg', 'pill'].map((o) => `<option ${o === t.radius ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
    <label>Spacing<select data-theme="spacing">${['compact', 'comfortable', 'airy'].map((o) => `<option ${o === t.spacing ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
    <label>Buttons<select data-btn="shape">${['pill', 'rounded', 'square'].map((o) => `<option ${o === t.buttons.shape ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
    <label class="inline"><input type="checkbox" data-btn="shadow" ${t.buttons.shadow ? 'checked' : ''}> Button shadow</label>
    <label class="inline"><input type="checkbox" data-dark="enabled" ${t.darkMode.enabled ? 'checked' : ''}> Dark mode</label>
    ${warn.map((w) => `<p class="warn">⚠ ${esc(w)}</p>`).join('')}`;
}

function wireEditor() {
  $('#back').onclick = async () => { clearTimeout(S.saveTimer); if (S.history.length) await saveDraft(); loadDashboard(); };
  $('#undo').onclick = undo;
  $('#redo').onclick = redo;
  $('#versions').onclick = () => showVersions();
  $('#publish').onclick = publish;
  $('#device').onclick = (e) => { const d = e.target.dataset.dev; if (d) { S.device = d; renderEditor(); refreshPreview(); } };

  $('#left').onclick = (e) => {
    const page = e.target.closest('[data-page]');
    const add = e.target.closest('[data-add]');
    if (e.target.id === 'addPage') return addPage();
    if (e.target.id === 'renamePage') return renamePage();
    if (e.target.id === 'delPage') return deletePage();
    if (add) return addSection(add.dataset.add);
    if (page) { S.pageId = page.dataset.page; S.selId = null; renderEditor(); refreshPreview(); return; }
    const li = e.target.closest('[data-sec]');
    if (li) { S.selId = li.dataset.sec; renderEditor(); }
  };
  wireLayerDrag();

  $('#right').oninput = (e) => onInspector(e, false);
  $('#right').onchange = (e) => onInspector(e, true);
  $('#right').onclick = (e) => {
    if (e.target.id === 'delSec') return deleteSection();
    const mv = e.target.closest('[data-move]');
    if (mv) return moveSection(Number(mv.dataset.move));
  };

  const frame = $('#canvas');
  window.onmessage = (e) => {
    if (e.data && e.data.type === 'select' && frame && e.source === frame.contentWindow) {
      const s = S.sections.find((x) => x._id === e.data.id);
      if (s) { S.selId = s._id; if (s.pageId) S.pageId = s.pageId; renderEditor(); refreshPreview(); }
    }
  };
  window.onkeydown = (e) => {
    if (!(e.ctrlKey || e.metaKey) || !S.site) return;
    if (e.target.matches?.('input,textarea,select')) return;
    if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); redo(); }
  };
}

function onInspector(e, final) {
  const t = e.target;
  const sec = S.sections.find((s) => s._id === S.selId);
  const pg = S.pages.find((p) => p._id === S.pageId);
  if (t.dataset.prop && sec) {
    sec.props = { ...sec.props, [t.dataset.prop]: t.value };
    return commit(`prop:${sec._id}:${t.dataset.prop}`);
  }
  if (t.dataset.style && sec) {
    if (t.dataset.style === 'variant') sec.variant = t.value;
    else {
      const map = { paddingY: 'paddingY', background: 'background', textAlign: 'textAlign' };
      sec.styles = { ...sec.styles, base: { ...sec.styles.base, [map[t.dataset.style]]: t.value } };
    }
    commit(`style:${sec._id}`); return renderEditor();
  }
  if (t.dataset.vis && sec) {
    sec.visibility = { ...sec.visibility, [t.dataset.vis]: t.checked };
    commit(`vis:${sec._id}`); return;
  }
  if (t.dataset.pg && pg) {
    const key = t.dataset.pg;
    let val = t.type === 'checkbox' ? t.checked : t.value;
    if (key.startsWith('seo.')) pg.seo = { ...pg.seo, [key.slice(4)]: val };
    else if (key === 'isHome' && val) { S.pages.forEach((p) => (p.isHome = false)); pg.isHome = true; }
    else if (key === 'slug') pg.slug = t.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    else pg[key] = val;
    if (final || t.type === 'checkbox') { commit(`page:${pg._id}:${key}`); renderEditor(); }
    else commit(`page:${pg._id}:${key}`);
    return;
  }
  if (t.dataset.color) { S.theme = { ...S.theme, colors: { ...S.theme.colors, [t.dataset.color]: t.value } }; commit('theme-color'); return renderEditor(); }
  if (t.dataset.font) { S.theme = { ...S.theme, typography: { ...S.theme.typography, [t.dataset.font]: t.value.trim() } }; commit('theme-font'); return; }
  if (t.dataset.theme) { S.theme = { ...S.theme, [t.dataset.theme]: t.value }; commit('theme'); return renderEditor(); }
  if (t.dataset.btn) { S.theme = { ...S.theme, buttons: { ...S.theme.buttons, [t.dataset.btn]: t.value } }; commit('theme'); return renderEditor(); }
  if (t.dataset.dark) { S.theme = { ...S.theme, darkMode: { ...S.theme.darkMode, enabled: t.checked } }; commit('theme'); return renderEditor(); }
  if (t.id === 'preset' && t.value) {
    S.theme = structuredClone(PRESETS[t.value]);
    commit('preset'); renderEditor();
  }
}

function addPage() {
  const title = prompt('Page title', 'New page');
  if (!title) return;
  const id = uid();
  S.pages.push({ _id: id, title, slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page', parentId: null, order: S.pages.length, seo: {}, isHome: false, hideInNav: false });
  S.pageId = id; S.selId = null;
  commit('add-page'); renderEditor(); refreshPreview();
}
function renamePage() {
  const pg = S.pages.find((p) => p._id === S.pageId);
  const t = pg && prompt('Rename page', pg.title);
  if (!t) return;
  pg.title = t; commit('rename'); renderEditor();
}
function deletePage() {
  if (S.pages.length <= 1) return alert('A site needs at least one page.');
  const pg = S.pages.find((p) => p._id === S.pageId);
  if (!pg || !confirm(`Delete "${pg.title}" and its sections?`)) return;
  S.pages = S.pages.filter((p) => p._id !== pg.id && p._id !== pg._id);
  S.sections = S.sections.filter((s) => s.pageId !== pg._id);
  if (pg.isHome && S.pages[0]) S.pages[0].isHome = true;
  S.pageId = S.pages[0]._id; S.selId = null;
  commit('delete-page'); renderEditor(); refreshPreview();
}
function addSection(type) {
  const sec = { ...defaultSection(type, SECTION_TYPES[type].variants[0]), _id: uid(), siteId: S.site._id, pageId: S.pageId, order: pageSections().length };
  S.sections.push(sec);
  S.selId = sec._id;
  commit(`add:${type}`); renderEditor(); refreshPreview();
}
function deleteSection() {
  const sec = S.sections.find((s) => s._id === S.selId);
  if (!sec || !confirm(`Delete this ${SECTION_TYPES[sec.type].label} section?`)) return;
  if (GLOBAL_TYPES.includes(sec.type)) return alert('Header and footer can be restyled but not deleted.');
  S.sections = S.sections.filter((s) => s._id !== sec._id);
  S.selId = null;
  commit('delete'); renderEditor(); refreshPreview();
}
function moveSection(dir) {
  const list = pageSections();
  const i = list.findIndex((s) => s._id === S.selId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  list.forEach((s, k) => (s.order = k));
  commit('move'); renderEditor(); refreshPreview();
}

// HTML5 drag-and-drop reorder in the layers list.
function wireLayerDrag() {
  const list = $('#layers');
  if (!list) return;
  let dragId = null;
  list.querySelectorAll('[data-sec]').forEach((li) => {
    li.ondragstart = () => { dragId = li.dataset.sec; };
    li.ondragover = (e) => { e.preventDefault(); li.classList.add('dragover'); };
    li.ondragleave = () => li.classList.remove('dragover');
    li.ondrop = (e) => {
      e.preventDefault();
      const from = pageSections().findIndex((s) => s._id === dragId);
      const to = pageSections().findIndex((s) => s._id === li.dataset.sec);
      if (from < 0 || to < 0 || from === to) return;
      const list2 = pageSections();
      const [moved] = list2.splice(from, 1);
      list2.splice(to, 0, moved);
      list2.forEach((s, k) => (s.order = k));
      commit('reorder'); renderEditor(); refreshPreview();
    };
  });
}

async function publish() {
  clearTimeout(S.saveTimer);
  await saveDraft();
  try {
    const out = await api('POST', `/sites/${S.site._id}/publish`);
    S.site.status = 'published';
    alert(`Published version ${out.version.number}. Live at ${S.site.subdomain}.${location.hostname === 'localhost' ? `localhost:${location.port}/s/${S.site.subdomain}` : 'your domain'}`);
    const d = await api('GET', `/sites/${S.site._id}`);
    S.versions = d.versions; S.domains = d.domains;
    renderEditor();
  } catch (err) {
    alert(err.data?.errors ? 'Cannot publish:\n- ' + err.data.errors.join('\n- ') : err.message);
  }
}

async function showVersions() {
  const d = await api('GET', `/sites/${S.site._id}`);
  S.versions = d.versions; S.domains = d.domains;
  const right = $('#right');
  right.innerHTML = `<h2>Version history</h2>
    <ul class="list">${S.versions.map((v) => `<li><span class="grow">v${v.number} <span class="muted">${new Date(v.publishedAt).toLocaleString()}</span>${v._id === S.site.publishedVersionId ? ' <span class="ok">live</span>' : ''}</span>
      ${v._id === S.site.publishedVersionId ? '' : `<button data-restore="${v._id}">Restore</button>`}</li>`).join('') || '<li class="muted">No published versions yet</li>'}</ul>
    <h2 style="margin-top:18px">Custom domain</h2>
    <label>Domain<input id="domainInput" placeholder="www.example.com"></label>
    <div class="row"><button id="addDomain">Add domain</button></div>
    <div id="domainInfo" class="muted" style="font-size:12px;margin-top:8px"></div>
    <ul class="list" style="margin-top:8px">${S.domains.map((x) => `<li><span class="grow">${esc(x.host)} ${x.verified ? '<span class="ok">verified</span>' : '<span class="warn">pending</span>'}</span>${x.verified ? '' : `<button data-verify="${x._id}">Verify</button>`}</li>`).join('')}</ul>
    <div class="row" style="margin-top:16px"><button id="closeVersions">Back to inspector</button></div>`;
  right.querySelectorAll('[data-restore]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Make this version the live site?')) return;
    await api('POST', `/sites/${S.site._id}/versions/${b.dataset.restore}/restore`);
    S.site.publishedVersionId = b.dataset.restore; S.site.status = 'published';
    showVersions();
  }));
  right.querySelectorAll('[data-verify]').forEach((b) => (b.onclick = async () => {
    const out = await api('POST', `/domains/${b.dataset.verify}/verify`);
    alert(out.verified ? 'Domain verified' : 'Not verified yet. DNS may take a few minutes to update.');
    showVersions();
  }));
  $('#addDomain').onclick = async () => {
    try {
      const out = await api('POST', `/sites/${S.site._id}/domains`, { host: $('#domainInput').value });
      $('#domainInfo').textContent = out.instructions;
      showVersions();
    } catch (err) { $('#domainInfo').textContent = err.message; }
  };
  $('#closeVersions').onclick = () => renderEditor();
}

// ---------- boot ----------
async function boot() {
  const saved = session.get();
  if (saved?.token) {
    S.token = saved.token;
    try {
      const { user } = await api('GET', '/auth/me');
      S.user = user;
      return loadDashboard();
    } catch { S.token = null; session.clear(); }
  }
  renderAuth();
}
boot();
