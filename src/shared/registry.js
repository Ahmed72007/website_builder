// Section registry: one definition per section type. The editor uses `schema`
// to generate the inspector and the server uses it to validate every write.
// The renderer uses `render` for live sites and the editor preview alike.

export const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SAFE_HREF = /^(\/(?!\/)|#|https?:\/\/|mailto:|tel:)/i;
const safeHref = (v) => (SAFE_HREF.test(String(v || '')) ? String(v) : '#');

// Parse "Title | text" lines into items.
const lines = (v) => String(v || '').split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((p) => p[0]);

const cta = (label, href, cls = 'btn') => (label ? `<a class="${cls}" href="${escape(safeHref(href))}">${escape(label)}</a>` : '');

export const SECTION_TYPES = {
  hero: {
    label: 'Hero',
    variants: ['centered', 'split-right', 'split-left'],
    schema: [
      { key: 'heading', kind: 'text', label: 'Heading', max: 120 },
      { key: 'subheading', kind: 'textarea', label: 'Subheading', max: 400 },
      { key: 'image', kind: 'image', label: 'Image URL' },
      { key: 'buttonLabel', kind: 'text', label: 'Button label', max: 40 },
      { key: 'buttonHref', kind: 'link', label: 'Button link' },
    ],
    defaults: { heading: 'Fresh pizza in 30 minutes', subheading: 'Order online across town.', image: '', buttonLabel: 'Order now', buttonHref: '/menu' },
    render: (p, v) => `<div class="wrap ${v === 'centered' ? 'center' : 'split'}">
      <div class="stack"><h1>${escape(p.heading)}</h1><p class="lead">${escape(p.subheading)}</p>${cta(p.buttonLabel, p.buttonHref)}</div>
      ${p.image && v !== 'centered' ? `<img src="${escape(safeHref(p.image))}" alt="${escape(p.imageAlt || '')}" loading="lazy">` : ''}</div>`,
  },
  features: {
    label: 'Features',
    variants: ['grid-3', 'list'],
    schema: [
      { key: 'heading', kind: 'text', label: 'Heading', max: 120 },
      { key: 'items', kind: 'lines', label: 'Items (one per line: Title | text)', max: 2000 },
    ],
    defaults: { heading: 'Why choose us', items: 'Fast | We deliver quickly.\nFresh | Made to order.\nFriendly | Real people, real help.' },
    render: (p, v) => `<h2>${escape(p.heading)}</h2><div class="grid ${v === 'list' ? 'one' : 'three'}">
      ${lines(p.items).map(([t, x]) => `<article class="card"><h3>${escape(t)}</h3><p>${escape(x || '')}</p></article>`).join('')}</div>`,
  },
  text: {
    label: 'Rich text',
    variants: ['left', 'center'],
    schema: [
      { key: 'heading', kind: 'text', label: 'Heading', max: 120 },
      { key: 'body', kind: 'textarea', label: 'Body', max: 4000 },
    ],
    defaults: { heading: 'About us', body: 'Tell visitors who you are and what you do.' },
    render: (p) => `<h2>${escape(p.heading)}</h2>${String(p.body || '').split(/\n{2,}/).map((para) => `<p>${escape(para)}</p>`).join('')}`,
  },
  cta: {
    label: 'Call to action',
    variants: ['banner', 'box'],
    schema: [
      { key: 'heading', kind: 'text', label: 'Heading', max: 120 },
      { key: 'text', kind: 'textarea', label: 'Text', max: 400 },
      { key: 'buttonLabel', kind: 'text', label: 'Button label', max: 40 },
      { key: 'buttonHref', kind: 'link', label: 'Button link' },
    ],
    defaults: { heading: 'Ready to get started?', text: 'Book a table today.', buttonLabel: 'Reserve', buttonHref: '#contact' },
    render: (p) => `<div class="stack center"><h2>${escape(p.heading)}</h2><p>${escape(p.text)}</p>${cta(p.buttonLabel, p.buttonHref, 'btn btn-accent')}</div>`,
  },
  faq: {
    label: 'FAQ',
    variants: ['accordion', 'list'],
    schema: [
      { key: 'heading', kind: 'text', label: 'Heading', max: 120 },
      { key: 'items', kind: 'lines', label: 'Questions (one per line: Question | Answer)', max: 4000 },
    ],
    defaults: { heading: 'Frequently asked questions', items: 'Do you deliver? | Yes, within 5 km.\nCan I pay cash? | Yes, on delivery.' },
    render: (p, v) => `<h2>${escape(p.heading)}</h2>${lines(p.items).map(([q, a]) => v === 'list'
      ? `<div class="qa"><h3>${escape(q)}</h3><p>${escape(a || '')}</p></div>`
      : `<details><summary>${escape(q)}</summary><p>${escape(a || '')}</p></details>`).join('')}`,
  },
  contact: {
    label: 'Contact form',
    variants: ['simple'],
    schema: [
      { key: 'heading', kind: 'text', label: 'Heading', max: 120 },
      { key: 'buttonLabel', kind: 'text', label: 'Button label', max: 40 },
      { key: 'notifyEmail', kind: 'text', label: 'Notify email (optional)', max: 200 },
    ],
    defaults: { heading: 'Contact us', buttonLabel: 'Send', notifyEmail: '' },
    // formId is the section id; submissions are stored per site.
    render: (p, v, ctx) => `<h2 id="contact">${escape(p.heading)}</h2>
      <form class="form" method="post" action="/api/v1/public/forms/${escape(ctx.sectionId)}/submit">
        <label>Name<input name="name" required maxlength="120"></label>
        <label>Email<input name="email" type="email" required maxlength="200"></label>
        <label>Message<textarea name="message" required maxlength="2000"></textarea></label>
        <button class="btn" type="submit">${escape(p.buttonLabel)}</button></form>`,
  },
  // Header and footer are site-level globals (see GLOBAL_TYPES).
  header: {
    label: 'Header',
    variants: ['simple', 'sticky', 'transparent'],
    schema: [
      { key: 'brand', kind: 'text', label: 'Brand', max: 60 },
      { key: 'links', kind: 'lines', label: 'Menu (one per line: Label | /path)', max: 1000 },
      { key: 'ctaLabel', kind: 'text', label: 'CTA label', max: 40 },
      { key: 'ctaHref', kind: 'link', label: 'CTA link' },
    ],
    defaults: { brand: 'My Business', links: '', ctaLabel: 'Order', ctaHref: '/#contact' },
    render: (p, v, ctx) => `<div class="wrap bar"><a class="brand" href="/">${escape(p.brand)}</a>
      <nav aria-label="Main">${ctx.nav}</nav>${cta(p.ctaLabel, p.ctaHref)}</div>`,
  },
  footer: {
    label: 'Footer',
    variants: ['simple', 'columns'],
    schema: [
      { key: 'text', kind: 'textarea', label: 'Text', max: 300 },
      { key: 'social', kind: 'lines', label: 'Social links (Label | https://...)', max: 500 },
    ],
    defaults: { text: '© My Business. All rights reserved.', social: 'Instagram | https://instagram.com' },
    render: (p) => `<div class="wrap"><p>${escape(p.text)}</p><p>${lines(p.social).map(([l, h]) => `<a href="${escape(safeHref(h))}" rel="noopener">${escape(l)}</a>`).join(' · ')}</p></div>`,
  },
};

export const SECTION_LIST_TYPES = Object.keys(SECTION_TYPES).filter((t) => !['header', 'footer'].includes(t));
export const GLOBAL_TYPES = ['header', 'footer'];

// Keep only schema keys, coerce to strings, clamp lengths, sanitize links.
export function sanitizeProps(type, props = {}) {
  const def = SECTION_TYPES[type];
  if (!def) throw new Error(`Unknown section type: ${type}`);
  const out = {};
  for (const f of def.schema) {
    const raw = props[f.key] ?? def.defaults[f.key] ?? '';
    let v = String(raw).replace(/\r/g, '').slice(0, f.max || 500);
    if (f.kind === 'link') v = safeHref(v);
    if (f.kind === 'image') v = /^(https?:\/\/|\/)/.test(v) ? v : '';
    out[f.key] = v;
  }
  return out;
}

export function sanitizeStyles(s = {}) {
  const pick = (v, ok, d) => (ok.includes(v) ? v : d);
  return {
    base: {
      paddingY: pick(s.base?.paddingY, ['none', 'sm', 'md', 'xl'], 'md'),
      background: pick(s.base?.background, ['surface', 'background', 'primary', 'secondary'], 'background'),
      textAlign: pick(s.base?.textAlign, ['left', 'center', 'right'], 'left'),
    },
    tablet: s.tablet && typeof s.tablet === 'object' ? { paddingY: pick(s.tablet.paddingY, ['none', 'sm', 'md', 'xl'], undefined) } : {},
    mobile: s.mobile && typeof s.mobile === 'object' ? { paddingY: pick(s.mobile.paddingY, ['none', 'sm', 'md', 'xl'], undefined), textAlign: pick(s.mobile.textAlign, ['left', 'center', 'right'], undefined) } : {},
  };
}

export function sanitizeVisibility(v = {}) {
  return { desktop: v.desktop !== false, tablet: v.tablet !== false, mobile: v.mobile !== false };
}

export function defaultSection(type, variant) {
  const def = SECTION_TYPES[type];
  return {
    type,
    variant: def.variants.includes(variant) ? variant : def.variants[0],
    props: sanitizeProps(type, {}),
    styles: sanitizeStyles({}),
    visibility: sanitizeVisibility({}),
  };
}

// Renders one section (or global) to HTML. `ctx` supplies nav, sectionId, etc.
export function renderSection(section, ctx = {}) {
  const def = SECTION_TYPES[section.type];
  if (!def) return '';
  const s = section.styles || sanitizeStyles({});
  const vis = section.visibility || {};
  const hide = [vis.desktop === false && 'hide-desktop', vis.tablet === false && 'hide-tablet', vis.mobile === false && 'hide-mobile'].filter(Boolean).join(' ');
  const cls = ['sec', `sec-${section.type}`, `v-${section.variant}`, `pad-${s.base?.paddingY || 'md'}`, `bg-${s.base?.background || 'background'}`, `ta-${s.base?.textAlign || 'left'}`, hide].filter(Boolean).join(' ');
  const tag = section.type === 'header' ? 'header' : section.type === 'footer' ? 'footer' : 'section';
  const body = def.render(section.props || {}, section.variant, ctx);
  return `<${tag} class="${cls}" data-section-id="${escape(ctx.sectionId || '')}" data-type="${section.type}">${body}</${tag}>`;
}
