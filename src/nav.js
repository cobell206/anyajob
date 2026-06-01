// Single source of truth for the site nav. Rendered server-side and
// substituted into <!-- nav:header --> and <!-- nav:tab-bar --> markers
// by src/routes/page.js, so the nav paints with the rest of the HTML —
// no flash on page transitions.
//
// Before centralizing, the nav was duplicated across six HTML files and
// had silently drifted (Notifications missing on some, Profile missing
// on others, "Paste" vs "Paste JD" varying). Add new pages here, not
// in the HTML.

// Notifications consolidated into a Settings accordion (commit 407ef65), so
// it's no longer a top-level destination. The standalone /paste.html page
// was later removed in favor of a modal on the roles page, and the "Add a
// role" nav slot itself was dropped after that — the + Add role button on
// the roles page is the canonical CTA, and every page is one click from /
// via the logo or the Roles tab. The /?add=1 deep-link still works (the
// roles page auto-opens the modal when it sees the param) for anyone who
// has the URL bookmarked or links to it from outside.
const NAV = [
  { href: '/',              label: 'Roles',      short: 'Roles',    icon: 'roles' },
  { href: '/profile.html',  label: 'Profile',    short: 'Profile',  icon: 'profile' },
  { href: '/settings.html', label: 'Settings',   short: 'Settings', icon: 'settings' },
];

// Inline SVGs for the mobile tab-bar. Copied verbatim from the original
// hand-duplicated tab-bars so the visual remains pixel-identical.
const ICONS = {
  roles:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
  profile:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
};

// Small monochrome SVGs used inside the theme popover (NOT the toggle
// button itself — that one is filled by theme-toggle.js at runtime so
// it can mirror the EFFECTIVE theme, including matchMedia changes in
// auto mode).
const SVG_AUTO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M12 4v14"/></svg>';
const SVG_LIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';
const SVG_DARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

function renderHeader(activePath) {
  const links = NAV.map((item) => {
    const active = item.href === activePath ? ' class="active"' : '';
    return `        <a href="${item.href}"${active}>${item.label}</a>`;
  }).join('\n');
  // Theme toggle is server-rendered as part of the header so every page
  // gets it without each having to import a component. Logic lives in
  // /theme-toggle.js (script tag below). The button's icon is filled in
  // by that script at init — leaving it empty here means a brief flicker
  // before the script runs, which is acceptable since the toggle is a
  // chrome affordance, not above-the-fold content.
  return `  <header>
    <div class="header-inner">
      <a href="/" class="brand">
        <span class="brand-mark">A</span>
        <span>AnyaJob</span>
      </a>
      <nav>
${links}
      </nav>
      <div class="header-actions">
        <button class="theme-toggle" type="button"
                aria-haspopup="menu" aria-expanded="false"
                aria-label="Theme" title="Theme"></button>
        <div class="theme-popover" role="menu" aria-label="Theme" hidden>
          <button class="theme-option" type="button" role="menuitemradio" data-theme="auto" aria-checked="false">
            <span class="theme-option-icon">${SVG_AUTO}</span>
            <span>Auto</span>
          </button>
          <button class="theme-option" type="button" role="menuitemradio" data-theme="light" aria-checked="false">
            <span class="theme-option-icon">${SVG_LIGHT}</span>
            <span>Light</span>
          </button>
          <button class="theme-option" type="button" role="menuitemradio" data-theme="dark" aria-checked="false">
            <span class="theme-option-icon">${SVG_DARK}</span>
            <span>Dark</span>
          </button>
        </div>
      </div>
    </div>
  </header>
  <script type="module" src="/theme-toggle.js?v=__CACHE_VERSION__"></script>`;
}

function renderTabBar(activePath) {
  const tabs = NAV.map((item) => {
    const isActive = item.href === activePath;
    const attrs = isActive ? ' class="active" aria-current="page"' : '';
    return `      <a href="${item.href}"${attrs}>
        ${ICONS[item.icon]}
        <span>${item.short}</span>
      </a>`;
  }).join('\n');
  return `  <nav class="tab-bar" aria-label="Main">
    <div class="tab-bar-inner">
${tabs}
    </div>
  </nav>`;
}

export function applyNav(html, activePath) {
  return html
    .replace('<!-- nav:header -->', renderHeader(activePath))
    .replace('<!-- nav:tab-bar -->', renderTabBar(activePath));
}
