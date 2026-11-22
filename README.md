# Website Builder

A multi-tenant, no-code website builder: drag-and-drop sections, a theme system
(tokens → CSS variables), multi-page sites, publish/rollback with immutable
snapshots, custom domains, and a public renderer that serves published sites by
host or path.

Built from the *Dynamic Website Builder — Project Plan*. MVP scope from the plan
(pages, section library, headers/footers, themes, responsive overrides, publish,
versions, contact forms, super admin) is implemented in a deliberately small
form; see "Plan coverage" below.

## Quick start

Requires Node 22+. No install is needed for the JSON store.

```bash
npm start                      # http://localhost:3000
npm test                       # API + renderer tests (JSON store)
```

Open http://localhost:3000, sign up, create a site from a template, edit, publish,
then view it at http://localhost:3000/s/<subdomain>/.

### Using MongoDB Atlas

Set the connection string in your own environment (do not commit it):

```bash
export MONGODB_URI='mongodb+srv://<user>:<password>@<cluster>.mongodb.net/'
export MONGODB_DB=website_builder        # optional, default: website_builder
npm start
```

When `MONGODB_URI` is set the server uses MongoDB and creates the indexes from the
plan's data model on startup. Without it, data goes to `data/db.json`.

## Environment variables

| Variable        | Purpose                                                        |
|-----------------|----------------------------------------------------------------|
| `PORT`          | HTTP port (default 3000)                                       |
| `MONGODB_URI`   | Atlas connection string; enables the MongoDB store             |
| `MONGODB_DB`    | Database name (default `website_builder`)                      |
| `BASE_DOMAIN`   | e.g. `yourbuilder.com`; sites served at `<sub>.<BASE_DOMAIN>`  |
| `ADMIN_EMAILS`  | Comma-separated super-admin emails (`/api/v1/admin/tenants`)   |

## Layout

```
public/            editor SPA (index.html, editor.js, editor.css)
src/shared/        code used by BOTH editor and renderer
  registry.js      section registry: schema, defaults, variants, render, sanitizers
  theme.js         presets, token sanitizing, CSS compiler, WCAG contrast checks
  render.js        full-page HTML, nav from page tree, SEO, sitemap, robots
src/server/
  server.js        REST API (/api/v1), public renderer, static hosting
  store.js         MongoStore (Atlas) and JsonStore behind one interface
test/app.test.js   unit + end-to-end tests
```

## How it works

- **Section registry.** Each section type declares a `schema` (the editor's
  inspector is generated from it), `defaultProps`, `variants`, and `render`. The
  server validates every write against the same schema, and the renderer uses the
  same `render`, so the editor preview matches the live site.
- **Theme.** Sections only reference tokens (`var(--color-primary)`), so changing
  one color or preset restyles the whole site. Contrast warnings are computed
  against WCAG AA.
- **Drafts and publish.** The editor autosaves the draft (`PUT /sites/:id/draft`,
  with optimistic locking on `version`). Publish validates the draft (home page,
  header, footer present), writes an immutable `siteVersions` snapshot, and points
  `publishedVersionId` at it. Rollback just moves that pointer. The renderer only
  reads snapshots, so unpublished edits never reach visitors.
- **Tenancy.** Every site belongs to a workspace; every site route checks the
  caller's membership and role (owner > admin > editor > viewer).
- **Hosting.** Requests whose host matches `*.BASE_DOMAIN` or a verified custom
  domain are rendered directly. Locally, `/s/<subdomain>/…` is used.
- **Cache.** Rendered HTML is cached per snapshot id, so a new publish
  automatically revalidates. Responses also carry `s-maxage` for a CDN.

## API (v1)

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register`, `/auth/login`, `/auth/logout` | Bearer token |
| GET | `/auth/me` | |
| GET/POST | `/workspaces` | |
| POST | `/workspaces/:id/members` | Invite an existing user by email (admin+) |
| GET | `/templates` | |
| GET/POST | `/sites` | Create from `template` |
| GET/PATCH/DELETE | `/sites/:id` | Full site (pages, sections, versions, domains) on GET |
| PUT | `/sites/:id/draft` | Autosave; 409 if the draft changed elsewhere |
| POST | `/sites/:id/preview` | Draft HTML for one page (editor iframe) |
| POST | `/sites/:id/publish` | 422 with a list of problems if invalid |
| POST | `/sites/:id/unpublish` | |
| GET | `/sites/:id/versions` | Included in `GET /sites/:id` |
| POST | `/sites/:id/versions/:versionId/restore` | Rollback |
| GET | `/sites/:id/submissions` | Contact-form inbox |
| POST | `/sites/:id/domains`, `/domains/:id/verify` | DNS TXT verification |
| POST | `/public/forms/:sectionId/submit` | Rate-limited; form-encoded posts redirect back |
| GET | `/admin/tenants` | Super admin (`ADMIN_EMAILS`) |

## Plan coverage and known gaps

Implemented: multi-tenant workspaces and roles; sites from templates (3 starter
templates, 5 theme presets); section library (hero, features, rich text, CTA,
FAQ with JSON-LD, contact form, header, footer); page tree with per-page SEO,
slugs, home page, and menu visibility; responsive visibility toggles; publish,
version history and rollback; custom domains with TXT verification; contact
form inbox; sitemap.xml and robots.txt; contrast warnings.

Simplified or not yet done:

- **Editor undo/redo** keeps whole-draft snapshots instead of Immer patches, and
  autosave sends the full draft. Fine at MVP size; patches are the next step.
- **Drag-and-drop** uses native HTML5 drag in the layers list (no dnd-kit yet).
- **Responsive overrides** are limited to visibility per breakpoint; per-breakpoint
  padding and alignment are stored in the data model but not editable in the UI.
- **Images/media library, Tiptap rich text, Google Fonts picker, and stock search**
  are not built; image sections take a URL.
- **Form notifications** log to the console; wire Resend/SES in `server.js`.
- **SSL for custom domains** is expected from the hosting layer (Vercel, Caddy or
  Cloudflare for SaaS); the app only verifies ownership.
- **Super admin UI** is API-only.
- **Not deployed**: the plan's Next.js renderer, Redis cache, BullMQ jobs, and
  Storybook/Playwright suites are replaced by the single Node process above.
  The renderer can be split out later since `src/shared` has no server dependencies.
