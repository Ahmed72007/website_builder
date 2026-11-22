import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

delete process.env.MONGODB_URI;
const { createApp, sanitizeDraft } = await import('../src/server/server.js');

let app, base, dir, token, siteId, wsId;
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-feat-'));
  app = await createApp({ dataFile: path.join(dir, 'db.json') });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
  const reg = await call('POST', '/api/v1/auth/register', { email: 'feat@example.com', password: 'longpassword' }, null);
  token = reg.data.token;
  wsId = (await call('GET', '/api/v1/workspaces')).data.workspaces[0]._id;
  siteId = (await call('POST', '/api/v1/sites', { workspaceId: wsId, name: 'Cafe', subdomain: 'cafe-feat', template: 'cafe' })).data.site._id;
});

after(async () => {
  await app?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('health endpoint reports store kind and latency', async () => {
  const h = await call('GET', '/api/v1/health', undefined, null);
  assert.equal(h.status, 200);
  assert.equal(h.data.store, 'json');
  assert.equal(typeof h.data.latencyMs, 'number');
});

test('sites list does not include the theme payload and is scoped to the user', async () => {
  const r = await call('GET', '/api/v1/sites');
  assert.equal(r.data.sites.length, 1);
  assert.equal(r.data.sites[0].theme, undefined);
  const other = await call('POST', '/api/v1/auth/register', { email: 'lister@example.com', password: 'longpassword' }, null);
  const r2 = await call('GET', '/api/v1/sites', undefined, other.data.token);
  assert.equal(r2.data.sites.length, 0);
});

test('draft preview renders unsaved edits without writing to the database', async () => {
  const full = (await call('GET', `/api/v1/sites/${siteId}`)).data;
  const draft = { theme: full.theme, pages: full.pages, sections: full.sections };
  draft.sections.find((s) => s.type === 'hero').props.heading = 'UNSAVED-EDIT';
  const prev = await call('POST', `/api/v1/sites/${siteId}/preview`, { pageId: full.pages[0]._id, draft });
  assert.ok(prev.data.includes('UNSAVED-EDIT'));
  const again = (await call('GET', `/api/v1/sites/${siteId}`)).data;
  assert.ok(!again.sections.some((s) => s.props?.heading === 'UNSAVED-EDIT'));
});

test('sanitizeDraft strips injected classes and bad variants', () => {
  const d = sanitizeDraft({
    theme: {},
    pages: [{ _id: 'p1', title: 'Home', isHome: true }],
    sections: [{ type: 'hero', pageId: 'p1', variant: 'bogus', styles: { base: { paddingY: '"><script>' } } }],
  }, 'site');
  const hero = d.sections.find((s) => s.type === 'hero');
  assert.equal(hero.variant, 'centered');
  assert.equal(hero.styles.base.paddingY, 'md');
  assert.ok(d.sections.some((s) => s.type === 'header') && d.sections.some((s) => s.type === 'footer'));
});

test('publish records number, note and draft version; unpublish clears live state', async () => {
  const pub = await call('POST', `/api/v1/sites/${siteId}/publish`, { note: 'First' });
  assert.equal(pub.status, 201, JSON.stringify(pub.data));
  assert.equal(pub.data.version.number, 1);
  assert.equal(pub.data.version.note, 'First');
  const site = (await call('GET', `/api/v1/sites/${siteId}`)).data.site;
  assert.equal(site.publishedDraftVersion, site.draftVersion);
  const un = await call('POST', `/api/v1/sites/${siteId}/unpublish`);
  assert.equal(un.status, 200);
  const live = await call('GET', '/s/cafe-feat/', undefined, null);
  assert.equal(live.status, 404);
});

test('public pages return an ETag and honour If-None-Match with 304', async () => {
  await call('POST', `/api/v1/sites/${siteId}/publish`, {});
  const first = await call('GET', '/s/cafe-feat/', undefined, null);
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const res = await fetch(`${base}/s/cafe-feat/`, { headers: { 'If-None-Match': etag } });
  assert.equal(res.status, 304);
});

test('restore switches the live version back and keeps the draft version reference', async () => {
  const list = (await call('GET', `/api/v1/sites/${siteId}`)).data.versions;
  const oldest = list[list.length - 1];
  const r = await call('POST', `/api/v1/sites/${siteId}/versions/${oldest._id}/restore`);
  assert.equal(r.status, 200);
  assert.equal(r.data.restoredNumber, oldest.number);
});

test('duplicate site copies pages and sections under a new subdomain', async () => {
  const dup = await call('POST', `/api/v1/sites/${siteId}/duplicate`, { subdomain: 'cafe-copy-feat' });
  assert.equal(dup.status, 201);
  const copyId = dup.data.site._id;
  const full = (await call('GET', `/api/v1/sites/${copyId}`)).data;
  const src = (await call('GET', `/api/v1/sites/${siteId}`)).data;
  assert.equal(full.pages.length, src.pages.length);
  assert.equal(full.sections.length, src.sections.length);
  assert.ok(full.pages.every((p) => p.siteId === copyId));
  assert.ok(!full.pages.some((p) => src.pages.some((q) => q._id === p._id)), 'ids must be new');
  const dupAgain = await call('POST', `/api/v1/sites/${siteId}/duplicate`, { subdomain: 'cafe-copy-feat' });
  assert.equal(dupAgain.status, 409);
});

test('submissions can be marked read and deleted', async () => {
  const full = (await call('GET', `/api/v1/sites/${siteId}`)).data;
  const contact = full.sections.find((s) => s.type === 'contact');
  await call('POST', `/api/v1/public/forms/${contact._id}/submit`, { name: 'Bo', email: 'bo@example.com', message: 'Hi' }, null);
  const { submissions } = (await call('GET', `/api/v1/sites/${siteId}/submissions`)).data;
  const sub = submissions[0];
  assert.equal(sub.read, false);
  await call('PATCH', `/api/v1/sites/${siteId}/submissions/${sub._id}`, { read: true });
  const after1 = (await call('GET', `/api/v1/sites/${siteId}/submissions`)).data.submissions[0];
  assert.equal(after1.read, true);
  await call('DELETE', `/api/v1/sites/${siteId}/submissions/${sub._id}`);
  assert.equal((await call('GET', `/api/v1/sites/${siteId}/submissions`)).data.submissions.length, 0);
});

test('workspace members endpoint returns emails and roles', async () => {
  const r = await call('GET', `/api/v1/workspaces/${wsId}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.members[0].email, 'feat@example.com');
  assert.equal(r.data.members[0].role, 'owner');
});

test('sitemap and robots are generated from the published snapshot', async () => {
  await call('POST', `/api/v1/sites/${siteId}/publish`, {});
  const sm = await call('GET', '/s/cafe-feat/sitemap.xml', undefined, null);
  assert.match(sm.data, /<loc>[^<]*\/menu<\/loc>/);
  assert.equal((await call('GET', '/s/cafe-feat/robots.txt', undefined, null)).status, 200);
});

test('static editor assets are served with ETags', async () => {
  const r = await fetch(`${base}/editor.js`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
  assert.ok(r.headers.get('etag'));
});
