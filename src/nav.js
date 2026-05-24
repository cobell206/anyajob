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

function renderHeader(activePath) {
  const links = NAV.map((item) => {
    const active = item.href === activePath ? ' class="active"' : '';
    return `        <a href="${item.href}"${active}>${item.label}</a>`;
  }).join('\n');
  return `  <header>
    <div class="header-inner">
      <a href="/" class="brand">
        <span class="brand-mark">A</span>
        <span>AnyaJob</span>
      </a>
      <nav>
${links}
      </nav>
    </div>
  </header>`;
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
