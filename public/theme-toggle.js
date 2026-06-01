// public/theme-toggle.js
// Wires the header theme-toggle button + Auto/Light/Dark popover.
//
// Stays self-contained (no app.js import) so it can load and run early
// without dragging utilities along. The no-FOUC inline script in each
// HTML <head> already applies the stored theme before paint; this
// module handles user-driven changes after page load and keeps the
// icon in sync as system theme flips under "auto" mode.

const KEY = 'theme';
const VALID = new Set(['auto', 'light', 'dark']);

const SVG_SUN  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';
const SVG_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

function getPref() {
  const v = localStorage.getItem(KEY);
  return VALID.has(v) ? v : 'auto';
}

function effective(pref) {
  if (pref === 'auto') {
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return pref;
}

function applyTheme(eff) {
  document.documentElement.dataset.theme = eff;
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.content = eff === 'dark' ? '#1a1614' : '#fafaf7';
}

function setPref(pref) {
  localStorage.setItem(KEY, pref);
  applyTheme(effective(pref));
  refresh();
}

// Sync the button icon (shows EFFECTIVE theme so it matches what the
// user sees on the page) and the popover's active option (shows the
// STORED preference — auto/light/dark — so the user can tell which
// they picked).
function refresh() {
  const pref = getPref();
  const eff = effective(pref);
  const btn = document.querySelector('.theme-toggle');
  if (btn) btn.innerHTML = eff === 'dark' ? SVG_MOON : SVG_SUN;
  document.querySelectorAll('.theme-option').forEach((o) => {
    const active = o.dataset.theme === pref;
    o.classList.toggle('is-active', active);
    o.setAttribute('aria-checked', String(active));
  });
}

function init() {
  const btn = document.querySelector('.theme-toggle');
  const pop = document.querySelector('.theme-popover');
  if (!btn || !pop) return;

  const close = () => {
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    refresh();
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (pop.hidden) open(); else close();
  });

  pop.addEventListener('click', (e) => {
    const opt = e.target.closest('.theme-option');
    if (!opt) return;
    setPref(opt.dataset.theme);
    close();
    btn.focus();
  });

  document.addEventListener('click', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && e.target !== btn) close();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) {
      close();
      btn.focus();
    }
  });

  // System theme change in auto mode → swap the icon to match. The
  // inline head script already re-applies the actual theme; we just
  // re-render the icon here.
  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (getPref() === 'auto') refresh();
    });
  } catch (_) { /* older Safari */ }

  refresh();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
