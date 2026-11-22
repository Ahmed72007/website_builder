// Editor SPA. One delegated listener on #app handles every click, input and change,
// so panels repaint without rebinding. Shares the section registry and theme engine
// with the server through /shared/*. Undo/redo keeps draft snapshots; autosave
// sends the draft; preview renders the unsaved draft so the canvas is instant.
import { SECTION_TYPES, GLOBAL_TYPES, SECTION_LIST_TYPES, defaultSection } from '/shared/registry.js';
import { PRESETS, contrastWarnings } from '/shared/theme.js';

const app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => crypto.randomUUID();
const fmt = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

const S = {
  token: null, user: null,
  site: null, theme: null, pages: [], sections: [], versions: [], domains: [], members: [], submissions: [],
  pageId: null, selId: null, panel: 'inspector', device: 'desktop',
  history: [], hIndex: -1, lastLabel: '', lastT: 0,
  saveTimer: null, saving: false, savePending: false, saveState: 'Saved',
  previewTimer: null, lastHtml: '',
};

// ---------- api ----------
async function api(method, path, body) {
  const headers = {};
  if (S.token) headers.Authorization = `Bearer ${S.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api/v1${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const e = new Error((data && data.error) || res.statusText);
    e.status = res.status; e.data = data;
    throw e;
  }
  return data;
}
const fail = (err) => toast(err.message || 'Something went wrong', 'error');

const store = {
  get() { try { return JSON.parse(localStorage.getItem('wb-session') || 'null'); } catch { return null; } },
  set(v) { try { localStorage.setItem('wb-session', JSON.stringify(v)); } catch {} },
  clear() { try { localStorage.removeItem('wb-session'); } catch {} },
};

function toast(msg, kind = 'info') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = 'toast'), kind === 'error' ? 5000 : 2800);
}

// ---------- auth & dashboard ----------
function renderAuth(msg = '') {
  S.site = null;
  app.innerHTML = `<div class="card">
    <h1 class="brand-h">Site Builder</h1>
    <div class="seg full"><button data-act="authTab" data-mode="login" class="${S.authMode !== 'register' ? 'on' : ''}">Log in</button><button data-act="authTab" data-mode="register" class="${S.authMode === 'register' ? 'on' : ''}">Sign up</button></div>
    <form data-form="auth">
      ${S.authMode === 'register' ? '<label>Name<input name="name" autocomplete="name"></label>' : ''}
      <label>Email<input name="email" type="email" required autocomplete="email"></label>
      <label>Password<input name="password" type="password" required minlength="8" autocomplete="${S.authMode === 'register' ? 'new-password' : 'current-password'}"></label>
      <div class="err" role="alert">${esc(msg)}</div>
      <button class="primary wide" type="submit">${S.authMode === 'register' ? 'Create account' : 'Log in'}</button>
    </form></div>`;
}
S.authMode = 'login';

async function renderDashboard() {
  const [{ workspaces }, { sites }, { templates }] = await Promise.all([api('GET', '/workspaces'), api('GET', '/sites'), api('GET', '/templates')]);
  S.workspaces = workspaces;
  S.sites = sites;
  app.innerHTML = `<header class="top"><strong>Site Builder</strong>
      <div class="row"><span class="muted">${esc(S.user.email)}</span><button data-act="logout">Log out</button></div></header>
    <main class="wrap">
      <div class="row between"><h2 class="page-h">Your sites</h2></div>
      <section class="card-s">
        <h3>New site</h3>
        <form data-form="newSite" class="row wrap-row">
          <input name="name" placeholder="Site name" required class="w-200">
          <input name="subdomain" placeholder="subdomain (optional)" pattern="[a-z0-9\\-]{3,40}" class="w-200">
          <select name="template" class="w-200">${templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
          <button class="primary" type="submit">Create</button>
        </form>
      </section>
      <div class="site-list">${sites.map((s) => `<article class="card-s">
          <div class="row between"><strong>${esc(s.name)}</strong>${statusBadge(s)}</div>
          <div class="muted small">/s/${esc(s.subdomain)}</div>
          <div class="row mt">
            <button data-act="openSite" data-id="${s._id}" class="primary">Edit</button>
            ${s.publishedVersionId ? `<a class="btn-link" href="/s/${esc(s.subdomain)}/" target="_blank" rel="noopener">View live ↗</a>` : ''}
          </div></article>`).join('') || '<p class="muted">No sites yet. Create one above.</p>'}</div>
    </main>`;
}

const statusBadge = (s) => (s.publishedVersionId ? (s.draftVersion !== s.publishedDraftVersion ? '<span class="badge warn-b">Unpublished changes</span>' : '<span class="badge ok-b">Live</span>') : '<span class="badge">Draft</span>');

// ---------- editor data ----------
async function openSite(id) {
  const data = await api('GET', `/sites/${id}`);
  S.site = data.site; S.theme = data.theme; S.pages = data.pages; S.sections = data.sections;
  S.versions = data.versions; S.domains = data.domains || [];
  S.pageId = (S.pages.find((p) => p.isHome) || S.pages[0])?._id;
  S.selId = null; S.panel = 'inspector'; S.history = []; S.hIndex = -1; S.lastHtml = '';
  pushHistory('init', true);
  renderShell();
  requestPreview(0);
}

async function reloadMeta() {
  const d = await api('GET', `/sites/${S.site._id}`);
  S.site = d.site; S.versions = d.versions; S.domains = d.domains;
  paintBar();
}

const draft = () => ({ theme: S.theme, pages: S.pages, sections: S.sections });

function pushHistory(label, force = false) {
  const snap = JSON.stringify(draft());
  const t = Date.now();
  if (!force && label === S.lastLabel && t - S.lastT < 900 && S.hIndex >= 0) {
    S.history[S.hIndex] = snap;
  } else {
    S.history = S.history.slice(0, S.hIndex + 1);
    S.history.push(snap);
    if (S.history.length > 150) S.history.shift();
    S.hIndex = S.history.length - 1;
  }
  S.lastLabel = label; S.lastT = t;
}

// Every edit: record history, schedule autosave, refresh preview.
function commit(label = 'edit', { repaint = 'none' } = {}) {
  pushHistory(label);
  S.site.dirtyLocal = true;
  scheduleSave();
  requestPreview();
  if (repaint === 'all') paintAll();
  else if (repaint === 'right') paintRight();
  else if (repaint === 'left') paintLeft();
  paintBar();
}

function scheduleSave() {
  clearTimeout(S.saveTimer);
  setSave('Unsaved');
  S.saveTimer = setTimeout(saveDraft, 500);
}

async function saveDraft() {
  if (!S.site) return;
  if (S.saving) { S.savePending = true; return; }
  S.saving = true;
  setSave('Saving…');
  try {
    const out = await api('PUT', `/sites/${S.site._id}/draft`, { version: S.site.draftVersion, ...draft() });
    S.site.draftVersion = out.version;
    S.site.dirtyLocal = false;
    setSave('Saved', out.warnings);
  } catch (err) {
    if (err.status === 409) { setSave('Conflict'); toast('This site changed in another tab. Reload to continue.', 'error'); }
    else { setSave('Not saved'); fail(err); }
  } finally {
    S.saving = false;
    paintBar();
    if (S.savePending) { S.savePending = false; scheduleSave(); }
  }
}

function setSave(text, warnings = []) {
  S.saveState = text + (warnings.length ? ` · ${warnings.length} contrast issue${warnings.length > 1 ? 's' : ''}` : '');
  const el = document.getElementById('save');
  if (el) el.textContent = S.saveState;
}

// Preview renders the unsaved draft on the server (no DB write) and only swaps the iframe when the HTML changed.
function requestPreview(delay = 180) {
  clearTimeout(S.previewTimer);
  S.previewTimer = setTimeout(loadPreview, delay);
}
async function loadPreview() {
  if (!S.site) return;
  try {
    const html = await api('POST', `/sites/${S.site._id}/preview`, { pageId: S.pageId, draft: draft() });
    if (html === S.lastHtml) return;
    S.lastHtml = html;
    const f = document.getElementById('canvas');
    if (f) f.srcdoc = html;
  } catch (err) { /* keep last good preview */ }
}

// ---------- undo / redo ----------
function undo() { if (S.hIndex > 0) { S.hIndex--; applySnap(); } }
function redo() { if (S.hIndex < S.history.length - 1) { S.hIndex++; applySnap(); } }
function applySnap() {
  const d = JSON.parse(S.history[S.hIndex]);
  S.theme = d.theme; S.pages = d.pages; S.sections = d.sections;
  if (!S.pages.some((p) => p._id === S.pageId)) S.pageId = S.pages[0]?._id;
  if (!S.sections.some((s) => s._id === S.selId)) S.selId = null;
  scheduleSave(); requestPreview(0); paintAll();
}

// ---------- rendering ----------
function renderShell() {
  app.innerHTML = `<div class="editor">
    <header class="bar" id="bar"></header>
    <div class="cols">
      <aside class="side" id="left"></aside>
      <main class="canvas"><iframe id="canvas" title="Site preview" sandbox="allow-scripts allow-same-origin allow-forms"></iframe></main>
      <aside class="side right" id="right"></aside>
    </div></div>`;
  paintAll();
}

function paintAll() { paintBar(); paintLeft(); paintRight(); applyDevice(); }

function applyDevice() {
  const f = document.getElementById('canvas');
  if (f) f.style.maxWidth = { desktop: '100%', tablet: '768px', mobile: '390px' }[S.device];
}

const liveVersion = () => S.versions.find((v) => v._id === S.site.publishedVersionId);

function paintBar() {
  const bar = document.getElementById('bar');
  if (!bar || !S.site) return;
  const live = S.site.publishedVersionId;
  const dirty = S.site.draftVersion !== S.site.publishedDraftVersion || S.site.dirtyLocal;
  const lv = liveVersion();
  const badge = !live ? '<span class="badge">Draft</span>'
    : dirty ? '<span class="badge warn-b">Unpublished changes</span>'
    : `<span class="badge ok-b">Live · v${lv ? lv.number : '?'}</span>`;
  bar.innerHTML = `
    <div class="row grow"><button data-act="home" title="All sites">←</button>
      <span class="title">${esc(S.site.name)}</span>${badge}
      <span class="status" id="save">${esc(S.saveState)}</span></div>
    <div class="row">
      <button data-act="undo" id="undo" title="Undo (Ctrl+Z)" ${S.hIndex <= 0 ? 'disabled' : ''}>↶ Undo</button>
      <button data-act="redo" id="redo" title="Redo (Ctrl+Shift+Z)" ${S.hIndex >= S.history.length - 1 ? 'disabled' : ''}>↷ Redo</button>
      <div class="seg">${['desktop', 'tablet', 'mobile'].map((d) => `<button data-act="device" data-dev="${d}" class="${S.device === d ? 'on' : ''}">${d[0].toUpperCase() + d.slice(1)}</button>`).join('')}</div>
      ${live ? `<a class="btn-link" href="/s/${esc(S.site.subdomain)}/" target="_blank" rel="noopener">Live ↗</a>` : ''}
      <button class="primary" data-act="panel" data-panel="publish">Publish</button>
    </div>`;
  paintRightTabs();
}

function paintLeft() {
  const el = document.getElementById('left');
  if (!el) return;
  const pageList = S.pages.map((p) => {
    const depth = p.parentId ? 1 : 0;
    return `<li data-act="selPage" data-id="${p._id}" class="${p._id === S.pageId ? 'sel' : ''}" style="padding-left:${8 + depth * 16}px">
      <span class="grow">${esc(p.title)}</span>${p.isHome ? '<span class="tag">home</span>' : ''}${p.hideInNav ? '<span class="tag">hidden</span>' : ''}</li>`;
  }).join('');
  const layers = pageSections();
  const item = (s) => `<li draggable="true" data-sec="${s._id}" data-act="selSec" data-id="${s._id}" class="${s._id === S.selId ? 'sel' : ''}">
      <span class="grow">${esc(SECTION_TYPES[s.type].label)} <span class="muted small">· ${esc(s.variant)}</span></span></li>`;
  const g = (t) => { const s = globalOf(t); return s ? item(s) : ''; };
  el.innerHTML = `
    <h3>Pages</h3>
    <ul class="list" id="pages">${pageList}</ul>
    <div class="tools">
      <button data-act="addPage">+ Page</button><button data-act="dupPage">Duplicate</button>
      <button data-act="renamePage">Rename</button><button data-act="movePage" data-dir="-1" title="Move up">↑</button>
      <button data-act="movePage" data-dir="1" title="Move down">↓</button>
      <button data-act="indentPage" data-dir="1" title="Nest under previous page">Indent</button>
      <button data-act="indentPage" data-dir="-1" title="Move to top level">Outdent</button>
      <button data-act="delPage" class="danger">Delete</button>
    </div>
    <h3>Header</h3><ul class="list">${g('header')}</ul>
    <h3>Sections on this page</h3>
    <ul class="list" id="layers">${layers.map(item).join('') || '<li class="muted">Add a section below</li>'}</ul>
    <h3>Footer</h3><ul class="list">${g('footer')}</ul>
    <h3>Add section</h3>
    <div class="lib">${SECTION_LIST_TYPES.map((t) => `<button data-act="addSec" data-type="${t}">${esc(SECTION_TYPES[t].label)}</button>`).join('')}</div>`;
}

const pageSections = () => S.sections.filter((s) => s.pageId === S.pageId).sort((a, b) => a.order - b.order);
const globalOf = (type) => S.sections.find((s) => s.pageId == null && s.type === type);

function paintRightTabs() {
  // Tabs are part of the right panel; keep them in sync with S.panel.
}

function paintRight() {
  const el = document.getElementById('right');
  if (!el || !S.site) return;
  const tabs = `<div class="seg full tabs">${[['inspector', 'Edit'], ['publish', 'Publish'], ['site', 'Site']]
    .map(([k, l]) => `<button data-act="panel" data-panel="${k}" class="${S.panel === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  let body = '';
  if (S.panel === 'publish') body = publishHtml();
  else if (S.panel === 'site') body = siteHtml();
  else {
    const sec = S.sections.find((s) => s._id === S.selId);
    body = sec ? inspectorHtml(sec) : `${pageSettingsHtml(S.pages.find((p) => p._id === S.pageId))}<h2 class="mt">Theme</h2>${themeHtml()}`;
  }
  el.innerHTML = tabs + body;
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
    const max = f.max || 500;
    return f.kind === 'textarea' || f.kind === 'lines'
      ? `<label>${esc(f.label)}<textarea data-prop="${f.key}" maxlength="${max}">${v}</textarea></label>`
      : `<label>${esc(f.label)}<input data-prop="${f.key}" value="${v}" maxlength="${max}"></label>`;
  }).join('');
  const sel = (key, opts, val) => `<label>${key}<select data-style="${key}">${opts.map((o) => `<option value="${o}" ${o === val ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
  const isGlobal = GLOBAL_TYPES.includes(sec.type);
  return `<h2>${esc(def.label)}</h2>
    <div class="row">
      ${isGlobal ? '' : '<button data-act="moveSec" data-dir="-1">↑ Up</button><button data-act="moveSec" data-dir="1">↓ Down</button><button data-act="dupSec">Duplicate</button>'}
      ${isGlobal ? '' : '<button class="danger" data-act="delSec">Delete</button>'}
      <button data-act="deselect">Done</button></div>
    <h3>Content</h3>${fields}
    <h3>Style</h3>
    ${sel('variant', def.variants, sec.variant)}
    ${sel('paddingY', ['none', 'sm', 'md', 'xl'], sec.styles.base.paddingY)}
    ${sel('background', ['background', 'surface', 'primary', 'secondary'], sec.styles.base.background)}
    ${sel('textAlign', ['left', 'center', 'right'], sec.styles.base.textAlign)}
    <h3>Visibility</h3>
    <label class="inline"><input type="checkbox" data-vis="desktop" ${sec.visibility.desktop ? 'checked' : ''}> Desktop</label>
    <label class="inline"><input type="checkbox" data-vis="tablet" ${sec.visibility.tablet ? 'checked' : ''}> Tablet</label>
    <label class="inline"><input type="checkbox" data-vis="mobile" ${sec.visibility.mobile ? 'checked' : ''}> Mobile</label>`;
}

const COLOR_KEYS = ['primary', 'secondary', 'accent', 'background', 'surface', 'text', 'muted'];
function themeHtml() {
  const t = S.theme;
  const warn = contrastWarnings(t);
  return `<label>Preset<select data-preset><option value="">Choose…</option>${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.name)}</option>`).join('')}</select></label>
    <h3>Colors</h3>
    <div class="lib two">${COLOR_KEYS.map((k) => `<label>${k}<input type="color" data-color="${k}" value="${t.colors[k]}" class="swatch"></label>`).join('')}</div>
    <h3>Typography</h3>
    <datalist id="fonts"><option>Poppins</option><option>Inter</option><option>Montserrat</option><option>Open Sans</option><option>Playfair Display</option><option>Lato</option><option>Space Grotesk</option><option>Roboto</option></datalist>
    <label>Heading font<input list="fonts" data-font="headingFont" value="${esc(t.typography.headingFont)}"></label>
    <label>Body font<input list="fonts" data-font="bodyFont" value="${esc(t.typography.bodyFont)}"></label>
    <h3>Shape & spacing</h3>
    <label>Radius<select data-theme="radius">${['sm', 'md', 'lg', 'pill'].map((o) => `<option ${o === t.radius ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
    <label>Spacing<select data-theme="spacing">${['compact', 'comfortable', 'airy'].map((o) => `<option ${o === t.spacing ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
    <label>Buttons<select data-btn="shape">${['pill', 'rounded', 'square'].map((o) => `<option ${o === t.buttons.shape ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
    <label class="inline"><input type="checkbox" data-btn="shadow" ${t.buttons.shadow ? 'checked' : ''}> Button shadow</label>
    <label class="inline"><input type="checkbox" data-dark="enabled" ${t.darkMode.enabled ? 'checked' : ''}> Dark mode</label>
    ${warn.map((w) => `<p class="warn">⚠ ${esc(w)}</p>`).join('')}`;
}

// ----- publish panel -----
function checklist() {
  const pages = S.pages;
  const header = globalOf('header');
  const footer = globalOf('footer');
  const items = [
    [pages.length > 0, 'At least one page'],
    [pages.some((p) => p.isHome), 'A home page is set'],
    [!!header, 'Header is present'],
    [!!footer, 'Footer is present'],
  ];
  const warnings = contrastWarnings(S.theme).map((w) => `Contrast: ${w}`);
  return { items, ok: items.every(([v]) => v), warnings };
}

function publishHtml() {
  const live = S.site.publishedVersionId;
  const dirty = S.site.draftVersion !== S.site.publishedDraftVersion || S.site.dirtyLocal;
  const c = checklist();
  const lv = liveVersion();
  return `<h2>Publish</h2>
    <div class="status-card ${!live ? '' : dirty ? 'warn-card' : 'ok-card'}">
      ${!live ? 'This site is a draft and not visible to visitors yet.'
        : dirty ? `Live as v${lv ? lv.number : '?'}. You have unpublished changes.`
        : `Live as v${lv ? lv.number : '?'} since ${esc(fmt(lv?.publishedAt))}.`}
      ${live ? `<div class="mt"><a href="/s/${esc(S.site.subdomain)}/" target="_blank" rel="noopener">Open live site ↗</a></div>` : ''}
    </div>
    <h3>Checklist</h3>
    <ul class="checks">${c.items.map(([ok, t]) => `<li class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'} ${esc(t)}</li>`).join('')}
      ${c.warnings.map((w) => `<li class="warn">⚠ ${esc(w)}</li>`).join('')}</ul>
    <label>Version note (optional)<input id="pubNote" maxlength="200" placeholder="e.g. Spring menu"></label>
    <div class="row">
      <button class="primary" data-act="publish" ${c.ok ? '' : 'disabled'}>${live ? 'Publish changes' : 'Publish site'}</button>
      ${live ? '<button class="danger" data-act="unpublish">Unpublish</button>' : ''}
    </div>
    <h3>Version history</h3>
    <ul class="list">${S.versions.map((v) => `<li class="ver">
        <div class="grow"><div>v${v.number} ${v._id === S.site.publishedVersionId ? '<span class="badge ok-b">Live</span>' : ''}</div>
        <div class="muted small">${esc(fmt(v.publishedAt))}${v.note ? ' · ' + esc(v.note) : ''}</div></div>
        ${v._id === S.site.publishedVersionId ? '' : `<button data-act="restore" data-id="${v._id}">Restore</button>`}</li>`).join('') || '<li class="muted">No published versions yet</li>'}</ul>`;
}

// ----- site panel (settings, team, domains, submissions) -----
function siteHtml() {
  return `<h2>Site settings</h2>
    <form data-form="siteSettings">
      <label>Name<input name="name" value="${esc(S.site.name)}" maxlength="80" required></label>
      <label>Address<input value="/s/${esc(S.site.subdomain)}" disabled></label>
      <label>Language<input name="language" value="${esc(S.site.settings?.language || 'en')}" maxlength="10"></label>
      <div class="row"><button class="primary" type="submit">Save settings</button>
        <button type="button" data-act="duplicateSite">Duplicate site</button></div>
    </form>
    <h3>Custom domain</h3>
    <form data-form="domain" class="row"><input name="host" placeholder="www.example.com" class="grow"><button type="submit">Add</button></form>
    <div id="domainInfo" class="muted small mt"></div>
    <ul class="list" id="domains">${S.domains.map((x) => `<li><span class="grow">${esc(x.host)} ${x.verified ? '<span class="badge ok-b">verified</span>' : '<span class="badge warn-b">pending</span>'}</span>
      ${x.verified ? '' : `<button data-act="verifyDomain" data-id="${x._id}">Verify</button>`}<button class="danger" data-act="delDomain" data-id="${x._id}">✕</button></li>`).join('') || '<li class="muted">No custom domains</li>'}</ul>
    <h3>Team</h3>
    <form data-form="invite" class="row"><input name="email" type="email" placeholder="teammate@example.com" class="grow" required>
      <select name="role"><option value="editor">Editor</option><option value="admin">Admin</option><option value="viewer">Viewer</option></select><button type="submit">Invite</button></form>
    <ul class="list" id="members">${S.members.map((m) => `<li><span class="grow">${esc(m.email || m.userId)}</span><span class="tag">${esc(m.role)}</span></li>`).join('') || '<li class="muted">Loading…</li>'}</ul>
    <h3>Form submissions <span class="badge">${S.submissions.filter((s) => !s.read).length} new</span></h3>
    <ul class="list">${S.submissions.map((s) => `<li class="sub ${s.read ? '' : 'unread'}"><div class="grow">
        <div><strong>${esc(s.data.name)}</strong> <span class="muted small">${esc(s.data.email)}</span></div>
        <div class="small">${esc(s.data.message)}</div><div class="muted small">${esc(fmt(s.createdAt))}</div></div>
        <button data-act="readSub" data-id="${s._id}" data-read="${s.read ? '0' : '1'}">${s.read ? 'Unread' : 'Read'}</button>
        <button class="danger" data-act="delSub" data-id="${s._id}">✕</button></li>`).join('') || '<li class="muted">No submissions yet</li>'}</ul>
    <h3>Danger zone</h3>
    <button class="danger" data-act="deleteSite">Delete site</button>`;
}

async function loadSitePanel() {
  try {
    const [d, subs, ws] = await Promise.all([
      api('GET', `/sites/${S.site._id}`),
      api('GET', `/sites/${S.site._id}/submissions`),
      api('GET', `/workspaces/${S.site.workspaceId}`),
    ]);
    S.domains = d.domains; S.submissions = subs.submissions; S.members = ws.members;
    if (S.panel === 'site') paintRight();
  } catch (err) { fail(err); }
}

// ---------- actions ----------
const selectPage = (id) => { S.pageId = id; S.selId = null; paintLeft(); paintRight(); requestPreview(0); };

function addPage() {
  const title = prompt('Page title', 'New page');
  if (!title) return;
  const id = uid();
  S.pages.push({ _id: id, title: title.slice(0, 80), slug: slugify(title), parentId: null, order: S.pages.length, seo: {}, isHome: false, hideInNav: false });
  S.pageId = id; S.selId = null;
  commit('add-page', { repaint: 'all' });
}
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page';

function duplicatePage() {
  const pg = S.pages.find((p) => p._id === S.pageId);
  if (!pg) return;
  const id = uid();
  const copy = { ...structuredClone(pg), _id: id, title: `${pg.title} (copy)`, slug: `${pg.slug}-copy`, isHome: false, order: S.pages.length };
  S.pages.push(copy);
  pageSections().forEach((s) => S.sections.push({ ...structuredClone(s), _id: uid(), pageId: id }));
  S.pageId = id; S.selId = null;
  commit('dup-page', { repaint: 'all' });
}

function renamePage() {
  const pg = S.pages.find((p) => p._id === S.pageId);
  const t = pg && prompt('Rename page', pg.title);
  if (!t) return;
  pg.title = t.slice(0, 80);
  commit('rename', { repaint: 'all' });
}

function deletePage() {
  if (S.pages.length <= 1) return toast('A site needs at least one page', 'error');
  const pg = S.pages.find((p) => p._id === S.pageId);
  if (!pg || !confirm(`Delete "${pg.title}" and its sections?`)) return;
  S.pages = S.pages.filter((p) => p._id !== pg._id).map((p) => (p.parentId === pg._id ? { ...p, parentId: null } : p));
  S.sections = S.sections.filter((s) => s.pageId !== pg._id);
  if (pg.isHome && S.pages[0]) S.pages[0].isHome = true;
  S.pageId = S.pages[0]._id; S.selId = null;
  commit('delete-page', { repaint: 'all' });
}

function movePage(dir) {
  const top = S.pages.filter((p) => !p.parentId).sort((a, b) => a.order - b.order);
  const pg = S.pages.find((p) => p._id === S.pageId);
  const list = pg.parentId ? S.pages.filter((p) => p.parentId === pg.parentId).sort((a, b) => a.order - b.order) : top;
  const i = list.findIndex((p) => p._id === pg._id);
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  list.forEach((p, k) => (p.order = k));
  commit('move-page', { repaint: 'all' });
}

function indentPage(dir) {
  const pg = S.pages.find((p) => p._id === S.pageId);
  if (!pg) return;
  if (dir > 0) {
    const prev = S.pages.filter((p) => !p.parentId && p._id !== pg._id).sort((a, b) => a.order - b.order).filter((p) => p.order < pg.order).pop();
    if (!prev) return toast('Nothing above to nest under', 'error');
    pg.parentId = prev._id;
  } else pg.parentId = null;
  commit('indent-page', { repaint: 'all' });
}

function addSection(type) {
  const sec = { ...defaultSection(type, SECTION_TYPES[type].variants[0]), _id: uid(), siteId: S.site._id, pageId: S.pageId, order: pageSections().length };
  S.sections.push(sec);
  S.selId = sec._id; S.panel = 'inspector';
  commit(`add:${type}`, { repaint: 'all' });
}

function duplicateSection() {
  const sec = S.sections.find((s) => s._id === S.selId);
  if (!sec || GLOBAL_TYPES.includes(sec.type)) return;
  const copy = { ...structuredClone(sec), _id: uid(), order: sec.order + 0.5 };
  S.sections.push(copy);
  pageSections().forEach((s, k) => (s.order = k));
  S.selId = copy._id;
  commit('dup-section', { repaint: 'all' });
}

function deleteSection() {
  const sec = S.sections.find((s) => s._id === S.selId);
  if (!sec || GLOBAL_TYPES.includes(sec.type)) return;
  if (!confirm(`Delete this ${SECTION_TYPES[sec.type].label} section?`)) return;
  S.sections = S.sections.filter((s) => s._id !== sec._id);
  S.selId = null;
  commit('delete', { repaint: 'all' });
}

function moveSection(dir) {
  const list = pageSections();
  const i = list.findIndex((s) => s._id === S.selId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  list.forEach((s, k) => (s.order = k));
  commit('move', { repaint: 'all' });
}

function reorderLayers(fromId, toId) {
  const list = pageSections();
  const from = list.findIndex((s) => s._id === fromId);
  const to = list.findIndex((s) => s._id === toId);
  if (from < 0 || to < 0 || from === to) return;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  list.forEach((s, k) => (s.order = k));
  commit('reorder', { repaint: 'all' });
}

async function publish() {
  clearTimeout(S.saveTimer);
  await saveDraft();
  const note = document.getElementById('pubNote')?.value || '';
  try {
    const out = await api('POST', `/sites/${S.site._id}/publish`, { note });
    toast(`Published v${out.version.number}`, 'ok');
    await reloadMeta();
    paintRight();
  } catch (err) {
    if (err.data?.errors) toast('Cannot publish: ' + err.data.errors.join('; '), 'error');
    else fail(err);
  }
}

async function unpublish() {
  if (!confirm('Take the site offline? Visitors will see "not published" until you publish again.')) return;
  await api('POST', `/sites/${S.site._id}/unpublish`);
  toast('Site unpublished', 'ok');
  await reloadMeta(); paintRight();
}

async function restore(id) {
  if (!confirm('Make this version live? Your draft is not changed.')) return;
  await api('POST', `/sites/${S.site._id}/versions/${id}/restore`);
  toast('Version restored', 'ok');
  await reloadMeta(); paintRight();
}

// ---------- inspector & theme input ----------
function onInput(t) {
  const sec = S.sections.find((s) => s._id === S.selId);
  if (t.dataset.prop && sec) {
    sec.props = { ...sec.props, [t.dataset.prop]: t.value };
    return commit(`prop:${sec._id}:${t.dataset.prop}`);
  }
  if (t.dataset.pg && t.type !== 'checkbox') return setPage(t.dataset.pg, t.value, 'text');
  if (t.dataset.color) { S.theme = { ...S.theme, colors: { ...S.theme.colors, [t.dataset.color]: t.value } }; return commit('theme-color'); }
  if (t.dataset.font) { S.theme = { ...S.theme, typography: { ...S.theme.typography, [t.dataset.font]: t.value.trim() } }; return commit('theme-font'); }
}

function setPage(key, val, kind) {
  const pg = S.pages.find((p) => p._id === S.pageId);
  if (!pg) return;
  if (key.startsWith('seo.')) pg.seo = { ...pg.seo, [key.slice(4)]: val };
  else if (key === 'isHome') { if (val) S.pages.forEach((p) => (p.isHome = false)); pg.isHome = val; }
  else if (key === 'slug') pg.slug = String(val).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  else if (key === 'hideInNav') pg.hideInNav = val;
  else pg[key] = val;
  commit(`page:${pg._id}:${key}`, { repaint: kind === 'text' ? 'left' : 'all' });
}

function onChange(t) {
  const sec = S.sections.find((s) => s._id === S.selId);
  if (t.dataset.style && sec) {
    if (t.dataset.style === 'variant') sec.variant = t.value;
    else sec.styles = { ...sec.styles, base: { ...sec.styles.base, [t.dataset.style]: t.value } };
    return commit(`style:${sec._id}`, { repaint: 'right' });
  }
  if (t.dataset.vis && sec) {
    sec.visibility = { ...sec.visibility, [t.dataset.vis]: t.checked };
    return commit(`vis:${sec._id}`, { repaint: 'right' });
  }
  if (t.dataset.pg) return setPage(t.dataset.pg, t.type === 'checkbox' ? t.checked : t.value, 'change');
  if (t.dataset.theme) { S.theme = { ...S.theme, [t.dataset.theme]: t.value }; return commit('theme', { repaint: 'right' }); }
  if (t.dataset.btn) { S.theme = { ...S.theme, buttons: { ...S.theme.buttons, [t.dataset.btn]: t.type === 'checkbox' ? t.checked : t.value } }; return commit('theme', { repaint: 'right' }); }
  if (t.dataset.dark) { S.theme = { ...S.theme, darkMode: { ...S.theme.darkMode, enabled: t.checked } }; return commit('theme', { repaint: 'right' }); }
  if (t.dataset.preset !== undefined && t.value) { S.theme = structuredClone(PRESETS[t.value]); return commit('preset', { repaint: 'right' }); }
}

// ---------- forms ----------
async function onSubmit(form) {
  const kind = form.dataset.form;
  const data = Object.fromEntries(new FormData(form));
  try {
    if (kind === 'auth') {
      const out = await api('POST', S.authMode === 'register' ? '/auth/register' : '/auth/login', data);
      S.token = out.token; S.user = out.user; store.set({ token: out.token });
      return renderDashboard();
    }
    if (kind === 'newSite') {
      if (!data.subdomain) data.subdomain = slugify(data.name).slice(0, 40);
      const { site } = await api('POST', '/sites', { ...data, workspaceId: S.workspaces[0]._id });
      return openSite(site._id);
    }
    if (kind === 'siteSettings') {
      await api('PATCH', `/sites/${S.site._id}`, { name: data.name, settings: { language: data.language } });
      S.site.name = data.name; S.site.settings = { language: data.language };
      toast('Settings saved', 'ok'); return paintAll();
    }
    if (kind === 'domain') {
      const out = await api('POST', `/sites/${S.site._id}/domains`, { host: data.host });
      document.getElementById('domainInfo').textContent = out.instructions;
      return loadSitePanel();
    }
    if (kind === 'invite') {
      await api('POST', `/workspaces/${S.site.workspaceId}/members`, data);
      toast('Member added', 'ok');
      return loadSitePanel();
    }
  } catch (err) { fail(err); }
}

// ---------- actions dispatcher ----------
async function onAction(act, el) {
  try {
    switch (act) {
      case 'authTab': S.authMode = el.dataset.mode; return renderAuth();
      case 'logout':
        try { await api('POST', '/auth/logout'); } catch {}
        store.clear(); S.token = null; S.user = null; return renderAuth();
      case 'openSite': return openSite(el.dataset.id);
      case 'home':
        clearTimeout(S.saveTimer);
        if (S.site?.dirtyLocal || S.saving) await saveDraft();
        S.site = null; return renderDashboard();
      case 'undo': return undo();
      case 'redo': return redo();
      case 'device': S.device = el.dataset.dev; paintBar(); return applyDevice();
      case 'panel':
        S.panel = el.dataset.panel;
        paintAll();
        return S.panel === 'site' ? loadSitePanel() : undefined;
      case 'selPage': return selectPage(el.dataset.id);
      case 'selSec': {
        const s = S.sections.find((x) => x._id === el.dataset.id);
        if (!s) return;
        S.selId = s._id; S.panel = 'inspector';
        if (s.pageId && s.pageId !== S.pageId) S.pageId = s.pageId;
        return paintAll();
      }
      case 'deselect': S.selId = null; return paintRight();
      case 'addPage': return addPage();
      case 'dupPage': return duplicatePage();
      case 'renamePage': return renamePage();
      case 'delPage': return deletePage();
      case 'movePage': return movePage(Number(el.dataset.dir));
      case 'indentPage': return indentPage(Number(el.dataset.dir));
      case 'addSec': return addSection(el.dataset.type);
      case 'dupSec': return duplicateSection();
      case 'delSec': return deleteSection();
      case 'moveSec': return moveSection(Number(el.dataset.dir));
      case 'publish': return publish();
      case 'unpublish': return unpublish();
      case 'restore': return restore(el.dataset.id);
      case 'duplicateSite': {
        const sub = prompt('Subdomain for the copy (3-40 letters, digits or dashes)', `${S.site.subdomain}-copy`);
        if (!sub) return;
        const { site } = await api('POST', `/sites/${S.site._id}/duplicate`, { subdomain: sub, name: `${S.site.name} (copy)` });
        toast('Site duplicated', 'ok');
        return openSite(site._id);
      }
      case 'deleteSite': {
        if (!confirm(`Delete "${S.site.name}" permanently? This cannot be undone.`)) return;
        await api('DELETE', `/sites/${S.site._id}`);
        toast('Site deleted', 'ok');
        S.site = null; return renderDashboard();
      }
      case 'verifyDomain': {
        const out = await api('POST', `/domains/${el.dataset.id}/verify`);
        toast(out.verified ? 'Domain verified' : 'Not verified yet. DNS can take a few minutes.', out.verified ? 'ok' : 'error');
        return loadSitePanel();
      }
      case 'delDomain':
        if (!confirm('Remove this domain?')) return;
        await api('DELETE', `/domains/${el.dataset.id}`);
        return loadSitePanel();
      case 'readSub':
        await api('PATCH', `/sites/${S.site._id}/submissions/${el.dataset.id}`, { read: el.dataset.read === '1' });
        return loadSitePanel();
      case 'delSub':
        if (!confirm('Delete this submission?')) return;
        await api('DELETE', `/sites/${S.site._id}/submissions/${el.dataset.id}`);
        return loadSitePanel();
      default: return;
    }
  } catch (err) { fail(err); }
}

function bindRoot() {
  app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    if (el.tagName === 'A') return;
    if (el.dataset.act === 'selSec' && e.target.closest('button')) return;
    e.stopPropagation();
    onAction(el.dataset.act, el);
  });
  app.addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    onSubmit(form);
  });
  app.addEventListener('input', (e) => { if (e.target.closest('.right, .side.right, #right')) onInput(e.target); });
  app.addEventListener('change', (e) => {
    const t = e.target;
    if (t.closest('#right') || t.closest('#left')) onChange(t);
  });
  // Layers: HTML5 drag to reorder.
  let dragId = null;
  app.addEventListener('dragstart', (e) => { const li = e.target.closest('[data-sec]'); if (li) { dragId = li.dataset.sec; e.dataTransfer.effectAllowed = 'move'; } });
  app.addEventListener('dragover', (e) => { const li = e.target.closest('[data-sec]'); if (li && dragId) { e.preventDefault(); li.classList.add('dragover'); } });
  app.addEventListener('dragleave', (e) => { const li = e.target.closest('[data-sec]'); if (li) li.classList.remove('dragover'); });
  app.addEventListener('drop', (e) => {
    const li = e.target.closest('[data-sec]');
    if (!li || !dragId) return;
    e.preventDefault();
    li.classList.remove('dragover');
    reorderLayers(dragId, li.dataset.sec);
    dragId = null;
  });
  app.addEventListener('dragend', () => { dragId = null; });

  // Click a section inside the preview to select it.
  window.addEventListener('message', (e) => {
    const frame = document.getElementById('canvas');
    if (!frame || e.source !== frame.contentWindow || !e.data || e.data.type !== 'select') return;
    const s = S.sections.find((x) => x._id === e.data.id);
    if (!s) return;
    S.selId = s._id; S.panel = 'inspector';
    if (s.pageId) S.pageId = s.pageId;
    paintAll();
  });

  window.addEventListener('keydown', (e) => {
    if (!S.site || !(e.ctrlKey || e.metaKey)) return;
    if (e.target.matches?.('input,textarea,select')) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
    else if (k === 's') { e.preventDefault(); clearTimeout(S.saveTimer); saveDraft(); }
  });
  window.addEventListener('beforeunload', (e) => {
    if (S.site && (S.site.dirtyLocal || S.saving)) { e.preventDefault(); e.returnValue = ''; }
  });
}

// ---------- boot ----------
async function boot() {
  document.body.insertAdjacentHTML('beforeend', '<div id="toast" role="status" aria-live="polite"></div>');
  bindRoot();
  const saved = store.get();
  if (saved?.token) {
    S.token = saved.token;
    try {
      S.user = (await api('GET', '/auth/me')).user;
      return renderDashboard();
    } catch { S.token = null; store.clear(); }
  }
  renderAuth();
}
boot();
