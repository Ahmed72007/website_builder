// Renderer: turns a snapshot (or the live draft, for preview) into a full HTML document.
// Used by the public site renderer and by the editor's preview endpoint.
import { compileTheme, fontsUrl } from './theme.js';
import { renderSection, escape, SECTION_TYPES } from './registry.js';

const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{font-size:var(--base-size,16px);scroll-behavior:smooth}
body{margin:0;background:var(--color-background);color:var(--color-text);font-family:var(--font-body);line-height:1.6}
h1,h2,h3{font-family:var(--font-heading);line-height:1.15;margin:0 0 .5em}
h1{font-size:calc(2.4rem * var(--scale,1.25))} h2{font-size:calc(1.7rem * var(--scale,1.25))} h3{font-size:1.15rem}
img{max-width:100%;height:auto;border-radius:var(--radius)}
a{color:var(--color-primary)}
.wrap{max-width:1100px;margin:0 auto;padding:0 16px;display:flex;gap:32px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.wrap.center,.stack{flex-direction:column;text-align:center}
.stack{display:flex;gap:12px;align-items:center;max-width:720px;margin:0 auto}
.split>*{flex:1 1 320px}
.lead{font-size:1.15rem;opacity:.85}
.sec{padding:0 16px}
.sec>*:not(.wrap){max-width:1100px;margin-left:auto;margin-right:auto}
.pad-none{padding-top:0;padding-bottom:0}.pad-sm{padding-top:calc(16px*var(--space));padding-bottom:calc(16px*var(--space))}
.pad-md{padding-top:calc(40px*var(--space));padding-bottom:calc(40px*var(--space))}.pad-xl{padding-top:calc(72px*var(--space));padding-bottom:calc(72px*var(--space))}
.bg-surface{background:var(--color-surface)}.bg-background{background:var(--color-background)}
.bg-primary{background:var(--color-primary);color:#fff}.bg-secondary{background:var(--color-secondary);color:#fff}
.ta-center{text-align:center}.ta-right{text-align:right}
.btn{display:inline-block;padding:.7em 1.4em;background:var(--color-primary);color:#fff;border-radius:var(--btn-radius);box-shadow:var(--btn-shadow);text-decoration:none;font-weight:600;border:0;cursor:pointer;font:inherit}
.btn-accent{background:var(--color-accent);color:#111}
.grid{display:grid;gap:16px;max-width:1100px;margin:16px auto 0}.grid.three{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}.grid.one{grid-template-columns:1fr}
.card{background:var(--color-surface);border-radius:var(--radius);padding:20px}
details{border-bottom:1px solid var(--color-surface);padding:12px 0;max-width:720px;margin:0 auto}summary{cursor:pointer;font-weight:600}
.qa{max-width:720px;margin:0 auto 16px}
.form{display:grid;gap:12px;max-width:520px;margin:16px auto 0}.form label{display:grid;gap:4px;font-weight:600}
.form input,.form textarea{font:inherit;padding:10px;border:1px solid var(--color-muted);border-radius:var(--radius);background:var(--color-background);color:var(--color-text)}
.form textarea{min-height:120px}
.sec-header{position:sticky;top:0;z-index:10;background:var(--color-background);border-bottom:1px solid var(--color-surface)}
.v-transparent{position:absolute;left:0;right:0;background:transparent}
.bar{padding:12px 16px;gap:16px}.bar nav ul{list-style:none;display:flex;gap:16px;margin:0;padding:0;flex-wrap:wrap}
.brand{font-family:var(--font-heading);font-weight:700;color:var(--color-text);text-decoration:none;font-size:1.2rem}
.sec-footer{border-top:1px solid var(--color-surface);font-size:.9rem;opacity:.9}
.hide-desktop{display:none}
@media (max-width:1024px){.hide-tablet{display:none}}
@media (max-width:640px){.hide-mobile{display:none}.hide-desktop{display:initial}.ta-mobile-center{text-align:center}h1{font-size:1.9rem}.wrap{gap:16px}}
:focus-visible{outline:3px solid var(--color-accent);outline-offset:2px}
.skip{position:absolute;left:-999px}.skip:focus{left:8px;top:8px;background:#fff;padding:6px;z-index:99}
`;

export function fullPath(page, pagesById) {
  if (page.isHome) return '/';
  const parts = [];
  let cur = page;
  const seen = new Set();
  while (cur && !seen.has(cur._id)) {
    seen.add(cur._id);
    parts.unshift(cur.slug);
    cur = cur.parentId ? pagesById.get(cur.parentId) : null;
  }
  return '/' + parts.join('/');
}

function navHtml(pages, pagesById, base, currentId, headerLinks) {
  const top = pages.filter((p) => !p.parentId && !p.hideInNav).sort((a, b) => a.order - b.order);
  const item = (p) => {
    const kids = pages.filter((c) => c.parentId === p._id && !c.hideInNav).sort((a, b) => a.order - b.order);
    const href = base + fullPath(p, pagesById);
    const sub = kids.length ? `<ul>${kids.map(item).join('')}</ul>` : '';
    return `<li><a href="${escape(href)}"${p._id === currentId ? ' aria-current="page"' : ''}>${escape(p.title)}</a>${sub}</li>`;
  };
  const custom = String(headerLinks || '').split('\n').map((l) => l.split('|').map((x) => x.trim()))
    .filter((p) => p[0] && p[1]).map(([l, h]) => `<li><a href="${escape(/^(\/|#|https?:)/.test(h) ? h : '#')}">${escape(l)}</a></li>`).join('');
  return `<ul>${top.map(item).join('')}${custom}</ul>`;
}

// Build the full HTML document for one page.
// snapshot: { theme, globals: {header, footer}, pages, sections }
// opts: { site, page, base, editor(bool) }
export function renderDocument(snapshot, { site, page, base = '', editor = false }) {
  const pages = snapshot.pages || [];
  const pagesById = new Map(pages.map((p) => [p._id, p]));
  const sections = (snapshot.sections || []).filter((s) => s.pageId === page._id).sort((a, b) => a.order - b.order);
  const header = snapshot.globals?.header;
  const footer = snapshot.globals?.footer;
  const theme = snapshot.theme;
  const path = fullPath(page, pagesById);
  const nav = navHtml(pages, pagesById, base, page._id, header?.props?.links);
  const ctx = (sectionId) => ({ nav, sectionId, base });

  const body = [
    header && renderSection(header, ctx(header._id)),
    `<main id="main">${sections.map((s) => renderSection(s, ctx(s._id))).join('\n')}</main>`,
    footer && renderSection(footer, ctx(footer._id)),
  ].filter(Boolean).join('\n');

  // Structured data for FAQ sections (SEO plan item).
  const faq = sections.filter((s) => s.type === 'faq').flatMap((s) => String(s.props.items || '').split('\n')
    .map((l) => l.split('|').map((x) => x.trim())).filter((p) => p[0] && p[1]));
  const jsonld = [
    faq.length && { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
  ].filter(Boolean).map((j) => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, '\\u003c')}</script>`).join('');

  const seo = page.seo || {};
  const title = seo.title || `${page.title} · ${site.name}`;
  const desc = seo.description || '';
  const ogImage = seo.ogImage || '';
  const canonical = `${base}${path}`;
  const fonts = fontsUrl(theme);
  const previewScript = editor ? `<script>
    document.addEventListener('click',function(e){var s=e.target.closest('[data-section-id]');if(s&&s.dataset.sectionId){e.preventDefault();parent.postMessage({type:'select',id:s.dataset.sectionId},'*');}},true);
    </script>` : '';

  return `<!doctype html>
<html lang="${escape(site.settings?.language || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
${desc ? `<meta name="description" content="${escape(desc)}">` : ''}
<meta property="og:title" content="${escape(seo.title || page.title)}">
${desc ? `<meta property="og:description" content="${escape(desc)}">` : ''}
${ogImage ? `<meta property="og:image" content="${escape(ogImage)}">` : ''}
<meta property="og:type" content="website">
<link rel="canonical" href="${escape(canonical)}">
${seo.noindex || editor ? '<meta name="robots" content="noindex">' : ''}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="${escape(fonts)}">
<style>${compileTheme(theme)}\n${BASE_CSS}</style>
${jsonld}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${body}
${previewScript}
</body>
</html>`;
}

export function renderSitemap(origin, snapshot) {
  const urls = (snapshot.pages || []).filter((p) => !p.seo?.noindex).map((p) => {
    const pagesById = new Map(snapshot.pages.map((x) => [x._id, x]));
    return `<url><loc>${escape(origin + fullPath(p, pagesById))}</loc></url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`;
}

export function renderRobots(origin) {
  return `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`;
}

export { SECTION_TYPES };
