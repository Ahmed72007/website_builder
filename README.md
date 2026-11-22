# Website Builder

A multi-tenant, no-code website builder: drag-and-drop sections, a theme system
(tokens → CSS variables), multi-page sites, a publish phase with immutable
versions and rollback, custom domains, form inbox, and a public renderer that
serves published sites by host or path.

Built from the *Dynamic Website Builder — Project Plan*.

## Quick start

Requires Node 20+. No install is needed for the JSON store.

```bash
npm start                      # http://localhost:3000
npm test                       # 22 API, renderer and feature tests
```

Open http://localhost:3000, sign up, create a site from a template, edit it,
publish, then view it at http://localhost:3000/s/<subdomain>/.

### MongoDB Atlas

Set the connection string in your own environment. Do not commit it.

```bash
export MONGODB_URI='mongodb+srv://<user>:<password>@<cluster>.mongodb.net/'
export MONGODB_DB=website_builder        # optional
npm start
```

With `MONGODB_URI` set, the server uses MongoDB and creates the plan's indexes on
startup. Without it, data goes to `data/db.json`.

Check the connection at `GET /api/v1/health`. It reports the store kind and latency.

## Environment variables

| Variable       | Purpose                                                       |
|----------------|---------------------------------------------------------------|
| `PORT`         | HTTP port (default 3000)                                      |
| `MONGODB_URI`  | Atlas connection string; enables the MongoDB store (required on Vercel) |
| `MONGODB_DB`   | Database name (default `website_builder`)                     |
| `BASE_DOMAIN`  | e.g. `yourbuilder.com`; sites are served at `<sub>.<BASE_DOMAIN>` |
| `ADMIN_EMAILS` | Comma-separated super-admin emails (`/api/v1/admin/tenants`)  |

## Layout

```
api/index.js          Vercel serverless entry (wraps the same app)
vercel.json           rewrites every path to the handler; bundles public/ and src/shared/
public/               editor SPA (index.html, editor.js, editor.css)
src/shared/           code used by BOTH editor and public site
  registry.js         section registry: schema, defaults, variants, render, sanitizers
  theme.js            presets, token sanitizing, CSS compiler, WCAG contrast checks
  render.js           full-page HTML, nav from page tree, SEO, sitemap, robots
src/server/
  server.js           REST API (/api/v1), public renderer, static hosting
  store.js            MongoStore (Atlas) and JsonStore behind one interface
test/                 app.test.js, features.test.js
```

## Using the editor

- **Pages**: add, duplicate, rename, reorder (↑ ↓), nest (Indent / Outdent), hide
  from menu, set the home page, and set SEO title, description and noindex.
- **Sections**: add from the library, drag to reorder in the layers list, duplicate,
  delete, and show or hide per breakpoint. Edit content and style in the Edit tab.
- **Click to select** a section directly in the preview.
- **Theme**: presets, seven colors, heading and body fonts, radius, spacing, button
  shape, dark mode. Contrast warnings appear as you edit.
- **Undo / redo** with Ctrl+Z and Ctrl+Shift+Z. **Save now** with Ctrl+S. Edits
  autosave about 0.5 s after you stop typing.
- **Publish** tab: readiness checklist, optional version note, publish, unpublish,
  version history, and one-click restore. The top bar shows Draft, Unpublished
  changes, or Live · vN.
- **Site** tab: rename, language, duplicate site, custom domains with DNS TXT
  verification, team invites (editor, admin, viewer), the form-submission inbox
  (read and delete), and site deletion for owners.

## Publish phase

1. Validation runs first: at least one page, one home page, a header and a footer.
   Failures are listed and nothing is written.
2. The draft is frozen into an immutable `siteVersions` snapshot with a number,
   timestamp, note, and the draft version it came from.
3. The site's `publishedVersionId` moves to that snapshot. Public pages use an
   ETag, and a new publish produces new cache keys, so visitors get fresh pages.
4. Unpublish clears the live pointer. Restore points it at an older snapshot. The
   draft is never changed by restore.

Unpublished edits never reach visitors, because the renderer reads only snapshots.

## How it works

- **Section registry.** Each type declares `schema` (the editor's inspector is
  generated from it), `defaults`, `variants`, and `render`. The server validates
  every write against the same schema, and the renderer uses the same `render`,
  so the preview matches the live site.
- **Fast preview.** The preview endpoint renders the unsaved draft on the server
  without a database write. The iframe is swapped only when the HTML changes.
- **Optimistic locking.** Autosave sends `version`. A stale tab gets a 409 and is
  told to reload, so it can't overwrite another tab's work.
- **Tenancy.** Every site belongs to a workspace. Every site route checks the
  caller's membership and role (owner > admin > editor > viewer).
- **Hosting.** Requests for `*.BASE_DOMAIN` or a verified custom domain render
  directly. Locally, `/s/<subdomain>/` is used.
- **Speed.** One round trip loads the editor. Sites lists omit theme payloads.
  Version lists omit snapshots. Rendered HTML is cached per snapshot. Responses
  return ETags and 304s, and assets revalidate with ETags.

## API (v1)

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Store kind and latency |
| POST | `/auth/register`, `/auth/login`, `/auth/logout` | Bearer token |
| GET | `/auth/me` | |
| GET/POST | `/workspaces` | |
| GET | `/workspaces/:id` | Members with email and role |
| POST | `/workspaces/:id/members` | Invite an existing user by email (admin+) |
| GET | `/templates` | Five starter templates |
| GET/POST | `/sites` | Create from `template` |
| GET/PATCH/DELETE | `/sites/:id` | Full editor payload on GET |
| POST | `/sites/:id/duplicate` | Copies the draft to a new subdomain |
| PUT | `/sites/:id/draft` | Autosave; 409 if the draft changed elsewhere |
| POST | `/sites/:id/preview` | Renders an unsaved draft for one page |
| POST | `/sites/:id/publish` | `{note}`; 422 with a list of problems when invalid |
| POST | `/sites/:id/unpublish` | |
| POST | `/sites/:id/versions/:versionId/restore` | Rollback |
| GET | `/sites/:id/submissions` | Contact-form inbox |
| PATCH/DELETE | `/sites/:id/submissions/:subId` | Mark read, delete |
| POST | `/sites/:id/domains` | Returns the TXT record to add |
| POST | `/domains/:id/verify`, DELETE `/domains/:id` | |
| POST | `/public/forms/:sectionId/submit` | Rate-limited; form posts redirect back |
| GET | `/admin/tenants` | Super admin (`ADMIN_EMAILS`) |

## Known limits

- **Undo history** keeps whole-draft snapshots rather than patches. Fine for sites
  of this size.
- **Images** are added by URL. There is no media library or upload yet.
- **Form notifications** are logged, not emailed. Wire Resend or SES in `server.js`.
- **Custom-domain SSL** comes from the hosting layer (Vercel, Caddy, or Cloudflare
  for SaaS). The app verifies ownership only.
- **Responsive overrides** cover visibility per breakpoint. Per-breakpoint padding
  is in the data model but not yet editable in the UI.
- **Not yet built:** AI generation, commerce, blog or CMS collections, real-time
  co-editing, and a super-admin UI (the admin API exists).
- **Editor tests** use a headless browser. The smoke test is not in the repo yet.
