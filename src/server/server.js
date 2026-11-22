// HTTP server: REST API (/api/v1), public site renderer (host or /s/:subdomain),
// and static hosting for the editor (/, /editor.js, /editor.css, /shared/*).
// Plain node:http, no framework. Used by `npm start` and by api/index.js on Vercel.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { applyPreset, sanitizeTheme, contrastWarnings } from '../shared/theme.js';
import { SECTION_TYPES, GLOBAL_TYPES, sanitizeProps, sanitizeStyles, sanitizeVisibility, defaultSection } from '../shared/registry.js';
import { renderDocument, renderSitemap, renderRobots, fullPath } from '../shared/render.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'src', 'shared');
const BASE_DOMAIN = (process.env.BASE_DOMAIN || '').toLowerCase();
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const RESERVED = new Set(['www', 'api', 'app', 'admin', 'static', 'mail', 'cdn', 's']);
const ROLE_RANK = { viewer: 0, editor: 1, admin: 2, owner: 3 };
const MAX_BODY = 1024 * 1024;
const PAD = ['none', 'sm', 'md', 'xl'];

export const TEMPLATES = {
  blank: { name: 'Blank', pages: [{ title: 'Home', slug: 'home', isHome: true, sections: [] }] },
  restaurant: {
    name: 'Restaurant',
    pages: [
      { title: 'Home', slug: 'home', isHome: true, sections: [['hero', 'centered'], ['features', 'grid-3'], ['faq', 'accordion'], ['contact', 'simple']] },
      { title: 'About', slug: 'about', sections: [['text', 'left']] },
    ],
  },
  cafe: {
    name: 'Café',
    pages: [
      { title: 'Home', slug: 'home', isHome: true, sections: [['hero', 'split-right'], ['features', 'grid-3'], ['cta', 'banner'], ['contact', 'simple']] },
      { title: 'Menu', slug: 'menu', sections: [['features', 'list']] },
      { title: 'About', slug: 'about', sections: [['text', 'left']] },
    ],
  },
  business: {
    name: 'Business',
    pages: [
      { title: 'Home', slug: 'home', isHome: true, sections: [['hero', 'split-right'], ['features', 'grid-3'], ['cta', 'banner'], ['contact', 'simple']] },
      { title: 'Services', slug: 'services', sections: [['features', 'list']] },
    ],
  },
  portfolio: {
    name: 'Portfolio',
    pages: [
      { title: 'Home', slug: 'home', isHome: true, sections: [['hero', 'centered'], ['text', 'center'], ['cta', 'box']] },
      { title: 'Work', slug: 'work', sections: [['features', 'grid-3']] },
      { title: 'Contact', slug: 'contact', sections: [['contact', 'simple']] },
    ],
  },
};

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const str = (v, max = 200) => String(v ?? '').slice(0, max);
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'page';
const stripSite = (s) => { const { theme, ...rest } = s; return rest; };

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

function send(res, status, body, headers = {}) {
  const isText = typeof body === 'string';
  res.writeHead(status, {
    'Content-Type': isText ? headers['Content-Type'] || 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(isText ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Body too large');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  if ((req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

const buckets = new Map();
function rateLimit(req, bucket, limit = 30) {
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  const key = `${bucket}:${ip}`;
  const t = Date.now();
  const e = buckets.get(key) || { n: 0, reset: t + 60000 };
  if (t > e.reset) { e.n = 0; e.reset = t + 60000; }
  e.n++;
  buckets.set(key, e);
  if (buckets.size > 10000) buckets.clear();
  if (e.n > limit) throw new HttpError(429, 'Too many requests, slow down');
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  return crypto.timingSafeEqual(crypto.scryptSync(pw, salt, 64), Buffer.from(hash, 'hex'));
}

// Validate and normalize a whole draft (pages + sections + theme). Used by autosave
// and by preview, so a preview shows exactly what would be saved.
export function sanitizeDraft(b = {}, siteId) {
  const theme = sanitizeTheme(b.theme);
  const pagesIn = Array.isArray(b.pages) ? b.pages.slice(0, 200) : [];
  const pageIds = new Set(pagesIn.map((pg) => str(pg._id, 64)));
  const used = new Map();
  const pages = pagesIn.map((pg, i) => {
    const parentId = pg.parentId && pageIds.has(pg.parentId) ? str(pg.parentId, 64) : null;
    let slug = slugify(pg.slug || pg.title);
    const key = `${parentId}|${slug}`;
    if (used.has(key)) slug = `${slug}-${used.get(key) + 1}`;
    used.set(key, (used.get(key) || 0) + 1);
    const seo = pg.seo || {};
    return {
      _id: str(pg._id, 64) || uid(), siteId, title: str(pg.title, 80) || 'Untitled', slug, parentId, order: i,
      seo: {
        title: str(seo.title, 70), description: str(seo.description, 170),
        ogImage: /^(https?:\/\/|\/)/.test(seo.ogImage || '') ? str(seo.ogImage, 500) : '', noindex: !!seo.noindex,
      },
      isHome: !!pg.isHome, hideInNav: !!pg.hideInNav,
    };
  });
  if (pages.length && !pages.some((pg) => pg.isHome)) (pages.find((pg) => !pg.parentId) || pages[0]).isHome = true;
  const homeIdx = pages.findIndex((pg) => pg.isHome);
  pages.forEach((pg, i) => { if (pg.isHome && i !== homeIdx) pg.isHome = false; });

  const pageSet = new Set(pages.map((pg) => pg._id));
  const counters = new Map();
  const sections = [];
  for (const s of (Array.isArray(b.sections) ? b.sections : []).slice(0, 2000)) {
    if (!SECTION_TYPES[s.type]) continue;
    const isGlobal = GLOBAL_TYPES.includes(s.type);
    const pageId = isGlobal ? null : (pageSet.has(s.pageId) ? s.pageId : null);
    if (!isGlobal && !pageId) continue;
    const def = SECTION_TYPES[s.type];
    const groupKey = isGlobal ? s.type : pageId;
    const order = counters.get(groupKey) || 0;
    counters.set(groupKey, order + 1);
    sections.push({
      _id: str(s._id, 64) || uid(), siteId, pageId, type: s.type,
      variant: def.variants.includes(s.variant) ? s.variant : def.variants[0],
      order, props: sanitizeProps(s.type, s.props), styles: sanitizeStyles(s.styles), visibility: sanitizeVisibility(s.visibility),
    });
  }
  for (const g of GLOBAL_TYPES) {
    if (!sections.some((s) => s.type === g)) sections.push({ ...defaultSection(g, SECTION_TYPES[g].variants[0]), _id: uid(), siteId, pageId: null, order: 0 });
  }
  return { theme, pages, sections };
}

export async function createApp({ dataFile = path.join(ROOT, 'data', 'db.json') } = {}) {
  const store = await createStore({ dataFile });
  const pageCache = new Map();
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler });
  };

  async function authUser(req) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) throw new HttpError(401, 'Login required');
    const s = await store.findOne('sessions', { _id: token });
    if (!s) throw new HttpError(401, 'Session expired');
    const user = await store.findOne('users', { _id: s.userId }, { exclude: ['passwordHash'] });
    if (!user) throw new HttpError(401, 'Session expired');
    return user;
  }

  async function siteFor(siteId, user, minRole = 'viewer') {
    const site = await store.findOne('sites', { _id: siteId });
    if (!site) throw new HttpError(404, 'Site not found');
    const ws = await store.findOne('workspaces', { _id: site.workspaceId });
    const member = ws?.members.find((m) => m.userId === user._id);
    if (!member) throw new HttpError(404, 'Site not found');
    if (ROLE_RANK[member.role] < ROLE_RANK[minRole]) throw new HttpError(403, 'Insufficient role');
    return { site, ws, role: member.role };
  }

  async function loadDraftSnapshot(siteId, site) {
    const [s, pages, all] = await Promise.all([
      site ? Promise.resolve(site) : store.findOne('sites', { _id: siteId }),
      store.find('pages', { siteId }),
      store.find('sections', { siteId }),
    ]);
    pages.sort((a, b) => a.order - b.order);
    all.sort((a, b) => a.order - b.order);
    const globals = {};
    for (const g of GLOBAL_TYPES) globals[g] = all.find((x) => x.pageId == null && x.type === g) || null;
    return { theme: s.theme, globals, pages, sections: all.filter((x) => x.pageId != null) };
  }

  const publicUser = (u) => ({ _id: u._id, email: u.email, name: u.name });
  const validSubdomain = (sub) => /^[a-z0-9-]{3,40}$/.test(sub) && !RESERVED.has(sub);

  // ----- health -----
  route('GET', '/api/v1/health', async (req, res) => {
    const t = Date.now();
    await store.findOne('users', { _id: '__health__' });
    send(res, 200, { ok: true, store: store.kind, latencyMs: Date.now() - t });
  });

  // ----- auth -----
  route('POST', '/api/v1/auth/register', async (req, res) => {
    rateLimit(req, 'auth', 10);
    const b = await readBody(req);
    const email = str(b.email, 200).trim().toLowerCase();
    const password = str(b.password, 200);
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Valid email required');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    if (await store.findOne('users', { email })) throw new HttpError(409, 'Email already registered');
    const user = { _id: uid(), email, name: str(b.name, 80) || email.split('@')[0], passwordHash: hashPassword(password), createdAt: now() };
    const ws = { _id: uid(), name: `${user.name}'s workspace`, ownerId: user._id, members: [{ userId: user._id, role: 'owner' }], planId: 'free', createdAt: now() };
    const token = crypto.randomBytes(32).toString('hex');
    await Promise.all([
      store.insertOne('users', user),
      store.insertOne('workspaces', ws),
      store.insertOne('sessions', { _id: token, userId: user._id, createdAt: now() }),
    ]);
    send(res, 201, { token, user: publicUser(user) });
  });

  route('POST', '/api/v1/auth/login', async (req, res) => {
    rateLimit(req, 'auth', 10);
    const b = await readBody(req);
    const user = await store.findOne('users', { email: str(b.email, 200).trim().toLowerCase() });
    if (!user || !verifyPassword(str(b.password, 200), user.passwordHash)) throw new HttpError(401, 'Wrong email or password');
    const token = crypto.randomBytes(32).toString('hex');
    await store.insertOne('sessions', { _id: token, userId: user._id, createdAt: now() });
    send(res, 200, { token, user: publicUser(user) });
  });

  route('POST', '/api/v1/auth/logout', async (req, res) => {
    await store.delete('sessions', { _id: (req.headers.authorization || '').slice(7) });
    send(res, 200, { ok: true });
  });

  route('GET', '/api/v1/auth/me', async (req, res) => send(res, 200, { user: publicUser(await authUser(req)) }));

  // ----- workspaces & team -----
  route('GET', '/api/v1/workspaces', async (req, res) => {
    const user = await authUser(req);
    const workspaces = await store.find('workspaces', { 'members.userId': user._id }, { exclude: [] });
    send(res, 200, { workspaces });
  });

  route('POST', '/api/v1/workspaces', async (req, res) => {
    const user = await authUser(req);
    const b = await readBody(req);
    const ws = { _id: uid(), name: str(b.name, 80) || 'Workspace', ownerId: user._id, members: [{ userId: user._id, role: 'owner' }], planId: 'free', createdAt: now() };
    await store.insertOne('workspaces', ws);
    send(res, 201, { workspace: ws });
  });

  route('GET', '/api/v1/workspaces/:id', async (req, res, p) => {
    const user = await authUser(req);
    const ws = await store.findOne('workspaces', { _id: p.id });
    if (!ws || !ws.members.some((m) => m.userId === user._id)) throw new HttpError(404, 'Workspace not found');
    const members = await Promise.all(ws.members.map(async (m) => {
      const u = await store.findOne('users', { _id: m.userId }, { exclude: ['passwordHash'] });
      return { userId: m.userId, role: m.role, email: u?.email || '', name: u?.name || '' };
    }));
    send(res, 200, { workspace: { _id: ws._id, name: ws.name }, members });
  });

  // Invite an existing user by email. Admins and owners only.
  route('POST', '/api/v1/workspaces/:id/members', async (req, res, p) => {
    const user = await authUser(req);
    const ws = await store.findOne('workspaces', { _id: p.id });
    const me = ws?.members.find((m) => m.userId === user._id);
    if (!me || ROLE_RANK[me.role] < ROLE_RANK.admin) throw new HttpError(403, 'Admin role required');
    const b = await readBody(req);
    const invitee = await store.findOne('users', { email: str(b.email, 200).trim().toLowerCase() });
    if (!invitee) throw new HttpError(404, 'No user with that email yet. They need to sign up first.');
    const role = ['admin', 'editor', 'viewer'].includes(b.role) ? b.role : 'editor';
    const members = ws.members.filter((m) => m.userId !== invitee._id).concat({ userId: invitee._id, role });
    await store.update('workspaces', { _id: ws._id }, { members });
    send(res, 200, { ok: true });
  });

  // ----- templates & sites -----
  route('GET', '/api/v1/templates', async (req, res) => {
    await authUser(req);
    send(res, 200, { templates: Object.entries(TEMPLATES).map(([id, t]) => ({ id, name: t.name })) });
  });

  route('GET', '/api/v1/sites', async (req, res) => {
    const user = await authUser(req);
    const wsId = new URL(req.url, 'http://x').searchParams.get('workspaceId');
    const workspaces = await store.find('workspaces', { 'members.userId': user._id }, { exclude: [] });
    const ids = workspaces.map((w) => w._id).filter((id) => !wsId || id === wsId);
    const lists = await Promise.all(ids.map((id) => store.find('sites', { workspaceId: id }, { exclude: ['theme'] })));
    const sites = lists.flat().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    send(res, 200, { sites });
  });

  route('POST', '/api/v1/sites', async (req, res) => {
    const user = await authUser(req);
    const b = await readBody(req);
    const ws = await store.findOne('workspaces', { _id: b.workspaceId });
    const member = ws?.members.find((m) => m.userId === user._id);
    if (!member || ROLE_RANK[member.role] < ROLE_RANK.editor) throw new HttpError(403, 'Editor role required');
    const subdomain = str(b.subdomain, 40).toLowerCase().trim() || slugify(b.name);
    if (!validSubdomain(subdomain)) throw new HttpError(400, 'Subdomain must be 3-40 letters, digits or dashes');
    if (await store.findOne('sites', { subdomain })) throw new HttpError(409, 'Subdomain taken');
    const template = TEMPLATES[b.template] || TEMPLATES.blank;
    const siteId = uid();
    const site = {
      _id: siteId, workspaceId: ws._id, name: str(b.name, 80) || 'My site', subdomain,
      theme: applyPreset('classic'), settings: { language: 'en' },
      status: 'draft', draftVersion: 1, publishedDraftVersion: null, publishedVersionId: null, versionCount: 0,
      createdAt: now(),
    };
    const pages = [];
    const sections = [];
    template.pages.forEach((tp, i) => {
      const pageId = uid();
      pages.push({ _id: pageId, siteId, title: tp.title, slug: tp.slug, parentId: null, order: i, seo: {}, isHome: !!tp.isHome, hideInNav: false });
      tp.sections.forEach(([type, variant], j) => sections.push({ ...defaultSection(type, variant), _id: uid(), siteId, pageId, order: j }));
    });
    sections.push({ ...defaultSection('header', 'sticky'), _id: uid(), siteId, pageId: null, order: 0 });
    sections.push({ ...defaultSection('footer', 'simple'), _id: uid(), siteId, pageId: null, order: 0 });
    await store.insertOne('sites', site);
    await store.insertMany('pages', pages);
    await store.insertMany('sections', sections);
    send(res, 201, { site: stripSite(site) });
  });

  // Full editor payload in one round trip.
  route('GET', '/api/v1/sites/:id', async (req, res, p) => {
    const user = await authUser(req);
    const { site } = await siteFor(p.id, user);
    const [pages, sections, versions, domains] = await Promise.all([
      store.find('pages', { siteId: site._id }),
      store.find('sections', { siteId: site._id }),
      store.find('siteVersions', { siteId: site._id }, { exclude: ['snapshot'] }),
      store.find('domains', { siteId: site._id }),
    ]);
    pages.sort((a, b) => a.order - b.order);
    sections.sort((a, b) => a.order - b.order);
    versions.sort((a, b) => b.number - a.number);
    send(res, 200, { site: stripSite(site), theme: site.theme, pages, sections, versions, domains, warnings: contrastWarnings(site.theme) });
  });

  route('PATCH', '/api/v1/sites/:id', async (req, res, p) => {
    const user = await authUser(req);
    await siteFor(p.id, user, 'admin');
    const b = await readBody(req);
    const patch = {};
    if (b.name !== undefined) patch.name = str(b.name, 80) || 'My site';
    if (b.settings?.language) patch.settings = { language: str(b.settings.language, 10) };
    if (Object.keys(patch).length) await store.update('sites', { _id: p.id }, patch);
    send(res, 200, { ok: true });
  });

  route('DELETE', '/api/v1/sites/:id', async (req, res, p) => {
    const user = await authUser(req);
    await siteFor(p.id, user, 'owner');
    await Promise.all(['pages', 'sections', 'siteVersions', 'formSubmissions', 'domains'].map((c) => store.delete(c, { siteId: p.id })));
    await store.delete('sites', { _id: p.id });
    pageCache.clear();
    send(res, 200, { ok: true });
  });

  // Copy a site (draft only) into a new site with its own subdomain.
  route('POST', '/api/v1/sites/:id/duplicate', async (req, res, p) => {
    const user = await authUser(req);
    const { site } = await siteFor(p.id, user, 'editor');
    const b = await readBody(req);
    const subdomain = str(b.subdomain, 40).toLowerCase().trim() || `${site.subdomain}-copy`;
    if (!validSubdomain(subdomain)) throw new HttpError(400, 'Subdomain must be 3-40 letters, digits or dashes');
    if (await store.findOne('sites', { subdomain })) throw new HttpError(409, 'Subdomain taken');
    const src = await loadDraftSnapshot(site._id, site);
    const newId = uid();
    const idMap = new Map();
    src.pages.forEach((pg) => idMap.set(pg._id, uid()));
    const pages = src.pages.map((pg) => ({ ...pg, _id: idMap.get(pg._id), siteId: newId, parentId: pg.parentId ? idMap.get(pg.parentId) || null : null }));
    const mapSec = (s) => ({ ...s, _id: uid(), siteId: newId, pageId: s.pageId == null ? null : idMap.get(s.pageId) || null });
    const sections = [...src.sections.map(mapSec), ...Object.values(src.globals).filter(Boolean).map(mapSec)];
    const copy = {
      _id: newId, workspaceId: site.workspaceId, name: str(b.name, 80) || `${site.name} (copy)`, subdomain,
      theme: site.theme, settings: site.settings, status: 'draft', draftVersion: 1, publishedDraftVersion: null,
      publishedVersionId: null, versionCount: 0, createdAt: now(),
    };
    await store.insertOne('sites', copy);
    await store.insertMany('pages', pages);
    await store.insertMany('sections', sections);
    send(res, 201, { site: stripSite(copy) });
  });

  // Autosave target: full draft replace with optimistic locking on `version`.
  route('PUT', '/api/v1/sites/:id/draft', async (req, res, p) => {
    const user = await authUser(req);
    const { site } = await siteFor(p.id, user, 'editor');
    const b = await readBody(req);
    if (Number(b.version) !== site.draftVersion) throw new HttpError(409, 'Draft changed elsewhere', { version: site.draftVersion });
    const { theme, pages, sections } = sanitizeDraft(b, site._id);
    await Promise.all([store.delete('pages', { siteId: site._id }), store.delete('sections', { siteId: site._id })]);
    await Promise.all([store.insertMany('pages', pages), store.insertMany('sections', sections)]);
    const version = site.draftVersion + 1;
    await store.update('sites', { _id: site._id }, { theme, draftVersion: version });
    send(res, 200, { version, warnings: contrastWarnings(theme) });
  });

  // Preview. Accepts the unsaved editor draft so the canvas updates instantly.
  route('POST', '/api/v1/sites/:id/preview', async (req, res, p) => {
    const user = await authUser(req);
    const { site } = await siteFor(p.id, user, 'viewer');
    const b = await readBody(req);
    const d = b.draft ? sanitizeDraft(b.draft, site._id) : null;
    const snapshot = d
      ? { theme: d.theme, globals: { header: d.sections.find((s) => s.type === 'header'), footer: d.sections.find((s) => s.type === 'footer') }, pages: d.pages, sections: d.sections.filter((s) => s.pageId != null) }
      : await loadDraftSnapshot(site._id, site);
    const page = snapshot.pages.find((pg) => pg._id === b.pageId) || snapshot.pages.find((pg) => pg.isHome);
    if (!page) throw new HttpError(404, 'No page');
    send(res, 200, renderDocument(snapshot, { site, page, base: '', editor: true }), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  });

  // Publish: validate, write an immutable snapshot, point the site at it.
  route('POST', '/api/v1/sites/:id/publish', async (req, res, p) => {
    const user = await authUser(req);
    const { site } = await siteFor(p.id, user, 'editor');
    const b = await readBody(req);
    const snapshot = await loadDraftSnapshot(site._id, site);
    const errors = [];
    if (!snapshot.pages.length) errors.push('Add at least one page');
    if (snapshot.pages.length && !snapshot.pages.some((pg) => pg.isHome)) errors.push('One page must be the home page');
    if (!snapshot.globals.header) errors.push('Header is missing');
    if (!snapshot.globals.footer) errors.push('Footer is missing');
    if (errors.length) throw new HttpError(422, 'Cannot publish', { errors });
    const number = (site.versionCount || 0) + 1;
    const publishedAt = now();
    const version = { _id: uid(), siteId: site._id, number, draftVersion: site.draftVersion, snapshot, publishedBy: user._id, publishedAt, note: str(b.note, 200) };
    await store.insertOne('siteVersions', version);
    await store.update('sites', { _id: site._id }, {
      publishedVersionId: version._id, publishedDraftVersion: site.draftVersion, versionCount: number, status: 'published', publishedAt,
    });
    send(res, 201, { version: { _id: version._id, number, publishedAt, note: version.note } });
  });

  route('POST', '/api/v1/sites/:id/unpublish', async (req, res, p) => {
    const user = await authUser(req);
    await siteFor(p.id, user, 'editor');
    await store.update('sites', { _id: p.id }, { publishedVersionId: null, publishedDraftVersion: null, status: 'draft' });
    send(res, 200, { ok: true });
  });

  // Rollback: point the live version at an older snapshot.
  route('POST', '/api/v1/sites/:id/versions/:versionId/restore', async (req, res, p) => {
    const user = await authUser(req);
    await siteFor(p.id, user, 'editor');
    const v = await store.findOne('siteVersions', { _id: p.versionId, siteId: p.id });
    if (!v) throw new HttpError(404, 'Version not found');
    await store.update('sites', { _id: p.id }, { publishedVersionId: v._id, publishedDraftVersion: v.draftVersion ?? null, status: 'published' });
    send(res, 200, { ok: true, restoredNumber: v.number });
  });

  // ----- submissions inbox -----
  route('GET', '/api/v1/sites/:id/submissions', async (req, res, p) => {
    const user = await authUser(req);
    await siteFor(p.id, user, 'viewer');
    const list = await store.find('formSubmissions', { siteId: p.id });
    send(res, 200, { submissions: list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 200) });
  });

  route('PATCH', '/api/v1/sites/:id/submissions/:subId', async (req, res, p) => {
    const user = await authUser(req);
    await siteFor(p.id, user, 'editor');
    const b = await readBody(req);
    await store.update('formSubmissions', { _id: p.subId, siteId: p.id }, { read: !!b.read });
    send(res, 200, { ok: true });
  });

  route('DELETE', '/api/v1/sites/:id/submissions/:subId', async (req, res, p) => {
    const user = await authUser(req);
    await siteFor(p.id, user, 'editor');
    await store.delete('formSubmissions', { _id: p.subId, siteId: p.id });
    send(res, 200, { ok: true });
  });

  // ----- custom domains (DNS TXT verification) -----
  route('POST', '/api/v1/sites/:id/domains', async (req, res, p) => {
    const user = await authUser(req);
    await siteFor(p.id, user, 'admin');
    const b = await readBody(req);
    const host = str(b.host, 253).toLowerCase().trim();
    if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(host) || (BASE_DOMAIN && host.endsWith(BASE_DOMAIN))) throw new HttpError(400, 'Enter a valid custom domain');
    if (await store.findOne('domains', { host })) throw new HttpError(409, 'Domain already in use');
    const dom = { _id: uid(), host, siteId: p.id, verified: false, token: crypto.randomBytes(12).toString('hex'), createdAt: now() };
    await store.insertOne('domains', dom);
    send(res, 201, { domain: dom, instructions: `Add a TXT record at _builder.${host} with value ${dom.token}, then click Verify.` });
  });

  route('POST', '/api/v1/domains/:id/verify', async (req, res, p) => {
    const user = await authUser(req);
    const dom = await store.findOne('domains', { _id: p.id });
    if (!dom) throw new HttpError(404, 'Domain not found');
    await siteFor(dom.siteId, user, 'admin');
    let ok = false;
    try {
      ok = (await dns.resolveTxt(`_builder.${dom.host}`)).flat().join('').includes(dom.token);
    } catch { ok = false; }
    if (ok) { await store.update('domains', { _id: dom._id }, { verified: true }); pageCache.clear(); }
    send(res, 200, { verified: ok });
  });

  route('DELETE', '/api/v1/domains/:id', async (req, res, p) => {
    const user = await authUser(req);
    const dom = await store.findOne('domains', { _id: p.id });
    if (!dom) throw new HttpError(404, 'Domain not found');
    await siteFor(dom.siteId, user, 'admin');
    await store.delete('domains', { _id: dom._id });
    pageCache.clear();
    send(res, 200, { ok: true });
  });

  // ----- public forms -----
  route('POST', '/api/v1/public/forms/:formId/submit', async (req, res, p) => {
    rateLimit(req, 'form', 20);
    const section = await store.findOne('sections', { _id: p.formId });
    if (!section || section.type !== 'contact') throw new HttpError(404, 'Form not found');
    const b = await readBody(req);
    const data = { name: str(b.name, 120), email: str(b.email, 200), message: str(b.message, 2000) };
    if (!data.name || !data.email || !data.message) throw new HttpError(400, 'Name, email and message are required');
    await store.insertOne('formSubmissions', { _id: uid(), siteId: section.siteId, formId: section._id, data, createdAt: now(), read: false });
    // Email notifications would go through Resend/SES; see README.
    const isForm = (req.headers['content-type'] || '').includes('urlencoded');
    if (isForm) {
      let back = '/';
      try { back = req.headers.referer ? new URL(req.headers.referer).pathname : '/'; } catch {}
      send(res, 303, '', { Location: `${back}?sent=1` });
    } else send(res, 201, { ok: true });
  });

  // ----- super admin -----
  route('GET', '/api/v1/admin/tenants', async (req, res) => {
    const user = await authUser(req);
    if (!ADMIN_EMAILS.includes(user.email)) throw new HttpError(403, 'Super admin only');
    const [workspaces, sites, users] = await Promise.all([store.find('workspaces'), store.find('sites', {}, { exclude: ['theme'] }), store.find('users', {}, { exclude: ['passwordHash'] })]);
    send(res, 200, {
      totals: { users: users.length, workspaces: workspaces.length, sites: sites.length, published: sites.filter((s) => s.publishedVersionId).length },
      workspaces: workspaces.map((w) => ({ _id: w._id, name: w.name, planId: w.planId, members: w.members.length, sites: sites.filter((s) => s.workspaceId === w._id).length })),
      templates: Object.entries(TEMPLATES).map(([id, t]) => ({ id, name: t.name })),
    });
  });

  // ----- public site rendering -----
  async function sitePublic(site, reqPath, base, origin) {
    if (!site.publishedVersionId) return { status: 404, body: 'This site is not published yet.' };
    const version = await store.findOne('siteVersions', { _id: site.publishedVersionId });
    if (!version) return { status: 404, body: 'Not found' };
    const snap = version.snapshot;
    if (reqPath === '/sitemap.xml') return { type: 'application/xml; charset=utf-8', body: renderSitemap(origin, snap), cache: 'public, s-maxage=3600' };
    if (reqPath === '/robots.txt') return { type: 'text/plain; charset=utf-8', body: renderRobots(origin), cache: 'public, s-maxage=3600' };
    const norm = reqPath.replace(/\/+$/, '') || '/';
    const pagesById = new Map(snap.pages.map((x) => [x._id, x]));
    const page = snap.pages.find((x) => fullPath(x, pagesById) === norm);
    if (!page) return { status: 404, body: 'Page not found' };
    const key = `${site._id}:${version._id}:${norm}:${base}`;
    if (!pageCache.has(key)) {
      if (pageCache.size > 500) pageCache.clear();
      pageCache.set(key, renderDocument(snap, { site, page, base }));
    }
    const etag = `"${crypto.createHash('sha1').update(key).digest('hex').slice(0, 20)}"`;
    return { type: 'text/html; charset=utf-8', body: pageCache.get(key), cache: 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400', etag };
  }

  // Responds with 304 when the browser already has this exact page version.
  const respond = (req, res, out) => {
    if (out.etag && req.headers['if-none-match'] === out.etag) {
      res.writeHead(304, { ETag: out.etag, 'Cache-Control': out.cache });
      return res.end();
    }
    const headers = { 'Content-Type': out.type || 'text/html; charset=utf-8' };
    if (out.cache) headers['Cache-Control'] = out.cache;
    if (out.etag) headers.ETag = out.etag;
    return send(res, out.status || 200, out.body, headers);
  };

  async function findSiteByHost(host) {
    const h = host.toLowerCase().split(':')[0];
    if (BASE_DOMAIN && h.endsWith('.' + BASE_DOMAIN)) {
      const sub = h.slice(0, -BASE_DOMAIN.length - 1);
      if (sub && !sub.includes('.') && !RESERVED.has(sub)) return store.findOne('sites', { subdomain: sub });
      return null;
    }
    const dom = await store.findOne('domains', { host: h, verified: true });
    return dom ? store.findOne('sites', { _id: dom.siteId }) : null;
  }

  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  function serveStatic(req, res, dir, rel) {
    const file = path.join(dir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
    const etag = `"${fs.statSync(file).mtimeMs.toString(36)}-${fs.statSync(file).size}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); res.end(); return true; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=0, must-revalidate', ETag: etag });
    fs.createReadStream(file).pipe(res);
    return true;
  }

  const handle = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      const host = (req.headers.host || '').toLowerCase();
      const proto = req.headers['x-forwarded-proto'] || 'http';

      if (pathname.startsWith('/api/v1/')) {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = pathname.match(r.re);
          if (!m) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          return await r.handler(req, res, params);
        }
        throw new HttpError(404, 'No such endpoint');
      }

      if (req.method === 'GET') {
        const hostSite = await findSiteByHost(host);
        if (hostSite) return respond(req, res, await sitePublic(hostSite, pathname, '', `${proto}://${host}`));
        const m = pathname.match(/^\/s\/([^/]+)(\/.*)?$/);
        if (m) {
          const site = await store.findOne('sites', { subdomain: m[1] });
          if (!site) return send(res, 404, 'Site not found');
          return respond(req, res, await sitePublic(site, m[2] || '/', `/s/${site.subdomain}`, `${proto}://${host}/s/${site.subdomain}`));
        }
        if (pathname === '/' || pathname === '/app') {
          if (serveStatic(req, res, PUBLIC_DIR, 'index.html')) return;
        }
        if (pathname.startsWith('/shared/') && serveStatic(req, res, SHARED_DIR, pathname.slice(8))) return;
        if (serveStatic(req, res, PUBLIC_DIR, pathname.slice(1))) return;
      }
      send(res, 404, 'Not found');
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...(err.extra || {}) });
      console.error(err);
      send(res, 500, { error: 'Internal error' });
    }
  };

  const server = http.createServer(handle);
  return { handle, server, store, close: async () => { server.close(); await store.close(); } };
}

// Run directly: `node src/server/server.js`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 3000);
  const app = await createApp();
  app.server.listen(port, () => console.log(`Website builder on http://localhost:${port} (store: ${app.store.kind})`));
}
