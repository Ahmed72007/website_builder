import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

delete process.env.MONGODB_URI; // tests always use the JSON store
const { createApp } = await import('../src/server/server.js');
const { sanitizeProps, renderSection, defaultSection } = await import('../src/shared/registry.js');
const { compileTheme, defaultTheme, sanitizeTheme, contrastWarnings } = await import('../src/shared/theme.js');

// ---------- unit ----------
test('sanitizeProps drops unsafe links and keeps text as data', () => {
  const p = sanitizeProps('hero', { heading: '<script>x</script>', buttonHref: 'javascript:alert(1)' });
  assert.equal(p.buttonHref, '#');
  const html = renderSection({ type: 'hero', variant: 'centered', props: p, styles: {}, visibility: {} }, {});
  assert.ok(!html.includes('<script>x</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('theme compiles tokens to CSS variables and sanitizes input', () => {
  const css = compileTheme(defaultTheme());
  assert.match(css, /--color-primary: #E63946;/);
  assert.match(css, /prefers-color-scheme: dark/);
  const t = sanitizeTheme({ colors: { primary: 'red' }, radius: 'huge', typography: { headingFont: 'x;}</style>' } });
  assert.equal(t.colors.primary, defaultTheme().colors.primary);
  assert.equal(t.radius, defaultTheme().radius);
  assert.equal(t.typography.headingFont, defaultTheme().typography.headingFont);
  assert.ok(Array.isArray(contrastWarnings(defaultTheme())));
});

test('defaultSection uses the first allowed variant when given an invalid one', () => {
  assert.equal(defaultSection('hero', 'nope').variant, 'centered');
});

// ---------- API + renderer ----------
let app, base, dir, token, token2;
const call = async (method, p, body, tok = token) => {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-test-'));
  app = await createApp({ dataFile: path.join(dir, 'db.json') });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
});

after(async () => {
  await app?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('auth: register, login, reject bad password', async () => {
  const r = await call('POST', '/api/v1/auth/register', { email: 'owner@example.com', password: 'longpassword', name: 'Owner' }, null);
  assert.equal(r.status, 201);
  token = r.data.token;
  const r2 = await call('POST', '/api/v1/auth/register', { email: 'other@example.com', password: 'longpassword' }, null);
  token2 = r2.data.token;
  const bad = await call('POST', '/api/v1/auth/login', { email: 'owner@example.com', password: 'wrongpass1' }, null);
  assert.equal(bad.status, 401);
  const ok = await call('POST', '/api/v1/auth/login', { email: 'owner@example.com', password: 'longpassword' }, null);
  assert.equal(ok.status, 200);
  const anon = await call('GET', '/api/v1/sites', undefined, null);
  assert.equal(anon.status, 401);
});

let siteId, draft;
test('create site from template, edit draft with optimistic locking, publish', async () => {
  const { data: ws } = await call('GET', '/api/v1/workspaces');
  const wsId = ws.workspaces[0]._id;
  const created = await call('POST', '/api/v1/sites', { workspaceId: wsId, name: 'Acme', subdomain: 'acme-test', template: 'restaurant' });
  assert.equal(created.status, 201);
  siteId = created.data.site._id;

  const full = await call('GET', `/api/v1/sites/${siteId}`);
  assert.equal(full.status, 200);
  assert.ok(full.data.pages.length >= 2);
  assert.ok(full.data.sections.some((s) => s.type === 'header' && s.pageId === null));

  draft = { theme: full.data.theme, pages: full.data.pages, sections: full.data.sections };
  const stale = await call('PUT', `/api/v1/sites/${siteId}/draft`, { version: 999, ...draft });
  assert.equal(stale.status, 409);

  const hero = draft.sections.find((s) => s.type === 'hero');
  hero.props.heading = '<b>Hi</b> there';
  draft.theme.colors.primary = '#0077B6';
  const saved = await call('PUT', `/api/v1/sites/${siteId}/draft`, { version: full.data.site.draftVersion, ...draft });
  assert.equal(saved.status, 200);

  const bad = await call('POST', `/api/v1/sites/${siteId}/publish`);
  assert.equal(bad.status, 201, JSON.stringify(bad.data));
});

test('public renderer serves published snapshot only, escapes content, exposes sitemap/robots', async () => {
  const home = await call('GET', '/s/acme-test/', undefined, null);
  assert.equal(home.status, 200);
  assert.match(home.data, /&lt;b&gt;Hi&lt;\/b&gt; there/);
  assert.match(home.data, /--color-primary: #0077B6;/);
  assert.match(home.data, /<link rel="canonical"/);

  const about = await call('GET', '/s/acme-test/about', undefined, null);
  assert.equal(about.status, 200);
  assert.equal((await call('GET', '/s/acme-test/nope', undefined, null)).status, 404);

  const sm = await call('GET', '/s/acme-test/sitemap.xml', undefined, null);
  assert.match(sm.data, /<urlset/);
  const robots = await call('GET', '/s/acme-test/robots.txt', undefined, null);
  assert.match(robots.data, /Sitemap:/);
});

test('draft edits are not visible publicly until publish', async () => {
  const full = await call('GET', `/api/v1/sites/${siteId}`);
  const d = { theme: full.data.theme, pages: full.data.pages, sections: full.data.sections };
  d.sections.find((s) => s.type === 'hero').props.heading = 'UNPUBLISHED-TEXT';
  await call('PUT', `/api/v1/sites/${siteId}/draft`, { version: full.data.site.draftVersion, ...d });
  const live = await call('GET', '/s/acme-test/', undefined, null);
  assert.ok(!live.data.includes('UNPUBLISHED-TEXT'));
  const prev = await call('POST', `/api/v1/sites/${siteId}/preview`, { pageId: full.data.pages[0]._id });
  assert.ok(prev.data.includes('UNPUBLISHED-TEXT'));
});

test('forms accept submissions and store them for the site owner', async () => {
  const full = await call('GET', `/api/v1/sites/${siteId}`);
  const contact = full.data.sections.find((s) => s.type === 'contact');
  const r = await call('POST', `/api/v1/public/forms/${contact._id}/submit`, { name: 'Ann', email: 'ann@example.com', message: 'Hello' }, null);
  assert.equal(r.status, 201);
  const subs = await call('GET', `/api/v1/sites/${siteId}/submissions`);
  assert.equal(subs.data.submissions.length, 1);
});

test('tenant isolation: another user cannot read or edit the site', async () => {
  assert.equal((await call('GET', `/api/v1/sites/${siteId}`, undefined, token2)).status, 404);
  assert.equal((await call('PUT', `/api/v1/sites/${siteId}/draft`, { version: 1 }, token2)).status, 404);
});

test('unsafe subdomains and duplicates are rejected', async () => {
  const { data: ws } = await call('GET', '/api/v1/workspaces');
  const wsId = ws.workspaces[0]._id;
  assert.equal((await call('POST', '/api/v1/sites', { workspaceId: wsId, name: 'x', subdomain: 'admin' })).status, 400);
  assert.equal((await call('POST', '/api/v1/sites', { workspaceId: wsId, name: 'x', subdomain: 'acme-test' })).status, 409);
});
