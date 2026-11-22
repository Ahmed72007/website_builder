// Theme engine: tokens -> CSS custom properties, presets, WCAG contrast checks.
// Shared by the editor (preview + warnings) and the renderer (site CSS).

export const PRESETS = {
  classic: {
    name: 'Classic',
    colors: { primary: '#E63946', secondary: '#1D3557', accent: '#F4A261', background: '#FFFFFF', surface: '#F8F9FA', text: '#111827', muted: '#6B7280' },
    typography: { headingFont: 'Poppins', bodyFont: 'Inter', baseSize: 16, scale: 1.25 },
    radius: 'md', spacing: 'comfortable', buttons: { shape: 'pill', shadow: false },
    darkMode: { enabled: true, colors: { background: '#0B0F19', text: '#F3F4F6' } },
  },
  ocean: {
    name: 'Ocean',
    colors: { primary: '#0077B6', secondary: '#023E8A', accent: '#00B4D8', background: '#FFFFFF', surface: '#EAF6FB', text: '#0B1F33', muted: '#4A6074' },
    typography: { headingFont: 'Montserrat', bodyFont: 'Open Sans', baseSize: 16, scale: 1.25 },
    radius: 'lg', spacing: 'comfortable', buttons: { shape: 'pill', shadow: true },
    darkMode: { enabled: true, colors: { background: '#06141F', text: '#E6F4FA' } },
  },
  warm: {
    name: 'Warm',
    colors: { primary: '#C2410C', secondary: '#7C2D12', accent: '#F59E0B', background: '#FFFBF5', surface: '#FFF1E0', text: '#2A1A10', muted: '#7A5C4A' },
    typography: { headingFont: 'Playfair Display', bodyFont: 'Lato', baseSize: 17, scale: 1.2 },
    radius: 'sm', spacing: 'airy', buttons: { shape: 'square', shadow: false },
    darkMode: { enabled: false, colors: { background: '#1C120B', text: '#FFF1E0' } },
  },
  mint: {
    name: 'Mint',
    colors: { primary: '#059669', secondary: '#064E3B', accent: '#A3E635', background: '#FFFFFF', surface: '#F0FDF4', text: '#052E16', muted: '#4B6358' },
    typography: { headingFont: 'Poppins', bodyFont: 'Inter', baseSize: 16, scale: 1.25 },
    radius: 'md', spacing: 'comfortable', buttons: { shape: 'pill', shadow: false },
    darkMode: { enabled: true, colors: { background: '#031A10', text: '#E7F8EE' } },
  },
  midnight: {
    name: 'Midnight',
    colors: { primary: '#8B5CF6', secondary: '#1E1B4B', accent: '#22D3EE', background: '#0F0E17', surface: '#1A1832', text: '#F5F3FF', muted: '#A5A1C2' },
    typography: { headingFont: 'Space Grotesk', bodyFont: 'Inter', baseSize: 16, scale: 1.25 },
    radius: 'lg', spacing: 'compact', buttons: { shape: 'pill', shadow: true },
    darkMode: { enabled: true, colors: { background: '#0F0E17', text: '#F5F3FF' } },
  },
};

const RADII = { sm: '4px', md: '12px', lg: '20px', pill: '999px' };
const SPACING = { compact: '0.75', comfortable: '1', airy: '1.35' };
const FONT_OK = /^[A-Za-z0-9 ]{1,40}$/;
const HEX_OK = /^#[0-9a-fA-F]{6}$/;

export function defaultTheme() {
  return structuredClone(PRESETS.classic);
}

export function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) throw new Error(`Unknown preset: ${name}`);
  return structuredClone(p);
}

// Keep only known keys and valid values; fall back to the classic preset.
export function sanitizeTheme(input = {}) {
  const base = defaultTheme();
  const t = structuredClone(base);
  const c = input.colors || {};
  for (const k of Object.keys(base.colors)) {
    if (typeof c[k] === 'string' && HEX_OK.test(c[k])) t.colors[k] = c[k];
  }
  const ty = input.typography || {};
  if (typeof ty.headingFont === 'string' && FONT_OK.test(ty.headingFont)) t.typography.headingFont = ty.headingFont;
  if (typeof ty.bodyFont === 'string' && FONT_OK.test(ty.bodyFont)) t.typography.bodyFont = ty.bodyFont;
  const size = Number(ty.baseSize);
  if (size >= 12 && size <= 24) t.typography.baseSize = size;
  const scale = Number(ty.scale);
  if (scale >= 1.1 && scale <= 1.5) t.typography.scale = scale;
  if (RADII[input.radius]) t.radius = input.radius;
  if (SPACING[input.spacing]) t.spacing = input.spacing;
  if (['pill', 'rounded', 'square'].includes(input.buttons?.shape)) t.buttons.shape = input.buttons.shape;
  if (typeof input.buttons?.shadow === 'boolean') t.buttons.shadow = input.buttons.shadow;
  if (typeof input.darkMode?.enabled === 'boolean') t.darkMode.enabled = input.darkMode.enabled;
  for (const k of ['background', 'text']) {
    const v = input.darkMode?.colors?.[k];
    if (typeof v === 'string' && HEX_OK.test(v)) t.darkMode.colors[k] = v;
  }
  return t;
}

// Token -> CSS. Sections only reference var(--color-*), so one edit restyles the site.
export function compileTheme(theme) {
  const c = theme.colors;
  const dark = theme.darkMode.colors;
  const vars = (obj) => Object.entries(obj).map(([k, v]) => `--${k}: ${v};`).join('');
  const colorVars = Object.fromEntries(Object.entries(c).map(([k, v]) => [`color-${k}`, v]));
  const darkVars = { 'color-background': dark.background, 'color-text': dark.text, 'color-surface': shade(dark.background, 0.06), 'color-muted': '#9CA3AF' };
  const btnRadius = theme.buttons.shape === 'pill' ? RADII.pill : theme.buttons.shape === 'rounded' ? RADII.md : '0px';
  const root = vars({
    ...colorVars,
    'font-heading': `"${theme.typography.headingFont}", system-ui, sans-serif`,
    'font-body': `"${theme.typography.bodyFont}", system-ui, sans-serif`,
    'base-size': `${theme.typography.baseSize}px`,
    'radius': RADII[theme.radius],
    'btn-radius': btnRadius,
    'btn-shadow': theme.buttons.shadow ? '0 4px 14px rgba(0,0,0,.18)' : 'none',
    'space': SPACING[theme.spacing],
    'scale': String(theme.typography.scale),
  });
  const darkBlock = vars(darkVars);
  return [
    `:root{${root}}`,
    theme.darkMode.enabled ? `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${darkBlock}}}` : '',
    theme.darkMode.enabled ? `:root[data-theme="dark"]{${darkBlock}}` : '',
  ].join('\n');
}

export function fontsUrl(theme) {
  const fams = [...new Set([theme.typography.headingFont, theme.typography.bodyFont])]
    .filter((f) => FONT_OK.test(f))
    .map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;600;700`);
  return `https://fonts.googleapis.com/css2?${fams.join('&')}&display=swap`;
}

// WCAG 2.1 contrast ratio helpers.
function lum(hex) {
  const n = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2];
}
export function contrast(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function shade(hex, amt) {
  const v = [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 + amt)));
  return '#' + v.map((x) => Math.min(255, x).toString(16).padStart(2, '0')).join('').toUpperCase();
}

// Returns human-readable warnings for pairs that fail WCAG AA (4.5:1 for body text).
export function contrastWarnings(theme) {
  const c = theme.colors;
  const pairs = [
    ['text on background', c.text, c.background, 4.5],
    ['text on surface', c.text, c.surface, 4.5],
    ['muted on background', c.muted, c.background, 4.5],
    ['white on primary (buttons)', '#FFFFFF', c.primary, 4.5],
  ];
  if (theme.darkMode.enabled) {
    pairs.push(['dark text on dark background', theme.darkMode.colors.text, theme.darkMode.colors.background, 4.5]);
  }
  return pairs
    .map(([label, a, b, min]) => ({ label, ratio: Math.round(contrast(a, b) * 100) / 100, min }))
    .filter((p) => p.ratio < p.min)
    .map((p) => `${p.label} is ${p.ratio}:1 (needs ${p.min}:1)`);
}
