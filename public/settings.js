import {
  $, $$, escapeHtml, api,
  confirmDialog, alertDialog, setStatus, scrollToEl,
} from './app.js';
import { renderCandidateCard } from './components/candidates.js';

// Inline SVGs replace emoji glyphs in the source-card row. Lucide-style
// 24×24 stroked icons, sized by the parent (.icon-btn-sm svg { 16px }).
const SVG_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 4 20 12 6 20"/></svg>';
const SVG_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const SVG_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const SVG_DOTS = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
const SVG_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>';
const SVG_ALERT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="13" height="13"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

// Section accordion
$$('.section-head').forEach((h) => {
  h.addEventListener('click', () => {
    h.parentElement.classList.toggle('open');
  });
});

// ===== Sources =====
let sourcesData = { sources: [] };
let sourcesLoaded = false;
let firstSourceRender = true;     // gate the per-card entrance cascade
let activeKind = 'greenhouse';
// Tracked separately so loadSources() and loadPendingDiscoveries() can each
// update the section sub-line independently without overwriting the other's
// contribution. Initialized to null so the first sub-line write doesn't
// claim "0 pending review" before pending discoveries have been fetched.
let pendingCount = null;

// Single source of truth for the "Sources" section sub-line — writes
// "X configured · Y enabled · Z pending review" and toggles the pink
// pending-dot on the collapsed section title. Replaces three previously-
// inlined writers that each rendered their own template.
// Guarded on sourcesLoaded so an early pending fetch can't briefly render
// "0 configured · 0 enabled · N pending review" while sources are still
// in flight; once sources load, it pulls in whatever pendingCount holds.
function updateSourcesSub() {
  if (!sourcesLoaded) return;
  const sub = $('#sources-sub');
  if (!sub) return;
  const total = sourcesData.sources.length;
  const enabled = sourcesData.sources.filter((x) => x.enabled).length;
  let txt = `${total} configured · ${enabled} enabled`;
  if (pendingCount && pendingCount > 0) {
    txt += ` · ${pendingCount} pending review`;
  }
  sub.textContent = txt;
  const section = document.getElementById('section-sources');
  if (section) section.classList.toggle('has-pending', !!pendingCount);
}

function fmtRel(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h ago';
  const days = Math.floor(hr / 24);
  return days + 'd ago';
}

function isRepairable(s) {
  return /403|404/.test(s.lastError || '');
}

function renderSource(s) {
  // Meta line surfaces the source's identifying detail (slug or URL) only when
  // it adds information beyond the name itself. For greenhouse/lever the slug
  // often matches the name (e.g. "ACLU" / aclu) — show it only when they
  // differ. Missing-slug error state is surfaced via .source-stats below, so
  // we don't double-report it here.
  let configLine = '';
  if (s.kind === 'greenhouse' || s.kind === 'lever') {
    const slug = s.config?.slug || '';
    if (slug && slug.toLowerCase() !== s.name.toLowerCase()) configLine = slug;
  } else if (s.kind === 'smartfetch' || s.kind === 'bookmark') {
    configLine = s.config?.url || '';
  }

  let stats = '';
  if (s.kind !== 'bookmark') {
    if (s.lastError) {
      stats = `<span class="stat-bad">${SVG_ALERT}<span>${escapeHtml(s.lastError).slice(0, 60)}</span></span>`;
    } else if (typeof s.lastCount === 'number') {
      // Zero listings isn't an error (boards have quiet days), so keep it
      // in the default muted color and reserve stat-warn for actual problems.
      const cls = s.lastCount > 0 ? 'stat-good' : '';
      stats = `<span${cls ? ` class="${cls}"` : ''}>${s.lastCount} listing${s.lastCount === 1 ? '' : 's'}</span>`;
    }
    stats += ` <span>last run ${fmtRel(s.lastRunAt)}</span>`;
  } else {
    stats = `<span>cadence: every ${s.config?.cadenceDays || 7}d</span>`;
    if (s.lastBriefedAt) stats += ` <span>last shown ${fmtRel(s.lastBriefedAt)}</span>`;
  }

  const safeName = escapeHtml(s.name);

  // The wrapping <label> already provides the accessible name to the
  // checkbox via the visible "On"/"Off" text, so no explicit aria-label
  // on the input — that would shadow the visible label.
  const toggle = `
    <label class="source-toggle ${s.enabled ? 'is-on' : ''}" data-toggle-wrap="${s.id}">
      <input type="checkbox" data-toggle="${s.id}" ${s.enabled ? 'checked' : ''}>
      <span class="source-toggle-track"><span class="source-toggle-thumb"></span></span>
      <span class="source-toggle-status" data-toggle-status="${s.id}">${s.enabled ? 'On' : 'Off'}</span>
    </label>
  `;

  // Overflow menu hosts everything except the toggle — Run, Find new URL
  // (when repairable), and Delete. Run used to sit in the visible row
  // but real usage showed it gets clicked rarely; demoting it to the menu
  // declutters the row and keeps the toggle (the actually-frequent action)
  // as the only inline control. Bookmarks don't fetch, so they skip Run.
  // Keeps data-run / data-repair / data-delete attrs so the existing
  // event-delegated handlers fire from the menu items unchanged.
  const runItem = s.kind === 'bookmark' ? '' :
    `<button role="menuitem" class="source-menuitem" data-run="${s.id}">${SVG_PLAY}<span>Run now</span></button>`;
  const repairItem = isRepairable(s)
    ? `<button role="menuitem" class="source-menuitem" data-repair="${s.id}">${SVG_SEARCH}<span>Find new URL</span></button>`
    : '';
  const menu = `
    <div class="source-menu-wrap" data-menu-wrap="${s.id}">
      <button class="icon-btn-sm source-menu-btn" data-menu-btn="${s.id}"
              aria-haspopup="menu" aria-expanded="false"
              title="More actions" aria-label="More actions for ${safeName}">${SVG_DOTS}</button>
      <div class="source-menu" data-menu="${s.id}" role="menu"
           aria-label="Actions for ${safeName}" hidden>
        ${runItem}
        ${repairItem}
        <button role="menuitem" class="source-menuitem danger" data-delete="${s.id}">${SVG_TRASH}<span>Delete source</span></button>
      </div>
    </div>
  `;

  return `
    <div class="source-card ${s.enabled ? '' : 'disabled'}">
      <div class="source-info">
        <div class="source-name">${safeName}</div>
        ${configLine ? `<div class="source-meta">${escapeHtml(configLine)}</div>` : ''}
        <div class="source-stats">${stats}</div>
        <div class="run-result" data-run-result="${s.id}" style="display:none"></div>
      </div>
      <div class="source-actions">
        ${toggle}
        ${menu}
      </div>
    </div>
  `;
}

async function runSourceNow(s, btn) {
  const ok = await confirmDialog({
    title: 'Run ' + s.name + ' now?',
    message: 'This will fetch live listings.',
    confirmLabel: 'Run',
  });
  if (!ok) return;

  const resultEl = document.querySelector(`[data-run-result="${s.id}"]`);
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.innerHTML = '<span class="spinner sm"></span><span>Running…</span>';
  if (resultEl) {
    resultEl.style.display = 'none';
    resultEl.className = 'run-result';
    resultEl.textContent = '';
  }

  try {
    const data = await api(`/api/sources/${s.id}/run`, { method: 'POST', body: {} });
    if (resultEl) {
      resultEl.style.display = '';
      if (data.error) {
        resultEl.className = 'run-result err';
        resultEl.textContent = '✗ ' + data.error;
      } else {
        resultEl.className = 'run-result ok';
        resultEl.textContent = `✓ Found ${data.count} listing${data.count === 1 ? '' : 's'}`;
      }
    }
  } catch (err) {
    if (resultEl) {
      resultEl.style.display = '';
      resultEl.className = 'run-result err';
      resultEl.textContent = '✗ ' + err.message;
    }
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.innerHTML = originalLabel;
    // Refresh stats (lastCount, lastRunAt, lastError) without nuking the
    // inline result we just rendered.
    try {
      sourcesData = await api('/api/sources');
      updateSourcesSub();
    } catch { /* ignore */ }
  }
}

// ===== Repair modal =====
// Lightweight modal kept local to settings.js — modal.js is listing-specific.
let _repairBackdrop = null;
function getRepairBackdrop() {
  if (_repairBackdrop) return _repairBackdrop;
  _repairBackdrop = document.createElement('div');
  _repairBackdrop.className = 'modal-backdrop repair-backdrop';
  _repairBackdrop.innerHTML = `
    <div class="modal repair-modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div class="modal-title">Find replacement URL</div>
        <button class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body" id="repair-body"></div>
    </div>
  `;
  document.body.appendChild(_repairBackdrop);
  _repairBackdrop.addEventListener('click', (e) => {
    if (e.target === _repairBackdrop) closeRepair();
  });
  _repairBackdrop.querySelector('.modal-close').addEventListener('click', closeRepair);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _repairBackdrop.classList.contains('open')) closeRepair();
  });
  return _repairBackdrop;
}
function openRepair() {
  getRepairBackdrop().classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeRepair() {
  if (_repairBackdrop) _repairBackdrop.classList.remove('open');
  document.body.style.overflow = '';
}

async function runRepair(source) {
  openRepair();
  const body = $('#repair-body');
  body.innerHTML = `
    <div class="repair-loading">
      <div class="repair-spinner"></div>
      <div>Searching for <strong>${escapeHtml(source.name)}</strong>'s current careers page…</div>
      <div style="font-size:12px;color:var(--muted);margin-top:6px">This usually takes 20–40 seconds.</div>
    </div>
  `;

  try {
    const res = await fetch(`/api/sources/${source.id}/repair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const conf = data.confidence || 'medium';
    const url = data.suggestedUrl || '';
    const kind = data.suggestedKind || source.kind;
    const rationale = data.rationale || '';

    body.innerHTML = `
      <div class="repair-result">
        <div class="repair-rationale">${escapeHtml(rationale)}</div>
        <div class="repair-suggestion">
          <div class="repair-suggestion-label">Suggested URL</div>
          <div class="repair-suggestion-url"><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a></div>
          <div class="repair-meta">
            <span class="kind-badge kind-${escapeHtml(kind)}">${escapeHtml(kind)}</span>
            <span class="confidence-badge confidence-${conf}">${conf} confidence</span>
          </div>
        </div>
        <div class="repair-actions">
          <button class="btn ghost" id="repair-cancel">Cancel</button>
          <button class="btn primary" id="repair-apply" ${url ? '' : 'disabled'}>Apply</button>
        </div>
        <div class="status-message" id="repair-status"></div>
      </div>
    `;

    $('#repair-cancel').addEventListener('click', closeRepair);
    $('#repair-apply').addEventListener('click', async () => {
      const btn = $('#repair-apply');
      const status = $('#repair-status');
      btn.disabled = true;
      btn.textContent = 'Applying…';
      try {
        const newConfig = { ...(source.config || {}), url };
        await api(`/api/sources/${source.id}`, {
          method: 'PATCH',
          body: { config: newConfig, kind },
        });
        setStatus(status, '✓ Updated', 'success');
        setTimeout(() => {
          closeRepair();
          loadSources();
        }, 600);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Apply';
        setStatus(status, 'Update failed: ' + err.message, 'error');
      }
    });
  } catch (err) {
    body.innerHTML = `
      <div class="repair-error">
        <div class="status-message error">Search failed: ${escapeHtml(err.message)}</div>
        <div class="repair-actions" style="margin-top:14px">
          <button class="btn" id="repair-cancel">Close</button>
        </div>
      </div>
    `;
    $('#repair-cancel').addEventListener('click', closeRepair);
  }
}

async function loadSources() {
  sourcesData = await api('/api/sources');
  sourcesLoaded = true;
  updateSourcesSub();
  $('#source-list').innerHTML = sourcesData.sources.map(renderSource).join('');

  // First-paint cascade only — gating the .is-entering class to the
  // initial render keeps toggle/delete re-renders snappy instead of
  // re-animating every card on every interaction. Capped at 8 cards
  // so a long source list doesn't take 2 seconds to reveal.
  if (firstSourceRender) {
    $$('#source-list .source-card').forEach((card, i) => {
      if (i >= 8) return;
      card.style.setProperty('--i', i);
      card.classList.add('is-entering');
    });
    firstSourceRender = false;
  }

  $$('[data-toggle]').forEach((input) => {
    input.addEventListener('change', () => {
      const s = sourcesData.sources.find((x) => x.id === input.dataset.toggle);
      if (!s) return;
      const previousEnabled = s.enabled;
      const newEnabled = input.checked;
      const wrap = document.querySelector(`[data-toggle-wrap="${s.id}"]`);
      const status = document.querySelector(`[data-toggle-status="${s.id}"]`);
      const card = input.closest('.source-card');

      const applyVisual = (enabled) => {
        s.enabled = enabled;
        input.checked = enabled;
        if (wrap) {
          wrap.classList.toggle('is-on', enabled);
          wrap.title = enabled ? 'Disable this source' : 'Enable this source';
        }
        if (status) status.textContent = enabled ? 'Active' : 'Inactive';
        input.setAttribute('aria-label', enabled ? 'Active' : 'Inactive');
        card?.classList.toggle('disabled', !enabled);
        updateSourcesSub();
      };

      applyVisual(newEnabled);

      api(`/api/sources/${s.id}`, { method: 'PATCH', body: { enabled: newEnabled } })
        .catch((err) => {
          applyVisual(previousEnabled);
          console.error('Toggle failed, reverted:', err);
        });
    });
  });

  $$('[data-run]').forEach((b) => {
    b.addEventListener('click', () => {
      const s = sourcesData.sources.find((x) => x.id === b.dataset.run);
      if (s) runSourceNow(s, b);
    });
  });

  $$('[data-delete]').forEach((b) => {
    b.addEventListener('click', async () => {
      const s = sourcesData.sources.find((x) => x.id === b.dataset.delete);
      if (!s) return;
      const ok = await confirmDialog({
        title: 'Delete ' + s.name + '?',
        message: 'This source will be removed. This cannot be undone.',
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!ok) return;

      const resultEl = document.querySelector(`[data-run-result="${s.id}"]`);
      const originalLabel = b.innerHTML;
      b.disabled = true;
      b.setAttribute('aria-busy', 'true');
      b.innerHTML = '<span class="spinner sm"></span>';
      try {
        const res = await fetch(`/api/sources/${s.id}`, { method: 'DELETE' });
        await res.json();
        loadSources();
      } catch (err) {
        b.disabled = false;
        b.removeAttribute('aria-busy');
        b.innerHTML = originalLabel;
        if (resultEl) {
          resultEl.style.display = '';
          resultEl.className = 'run-result err';
          resultEl.textContent = '✗ Delete failed: ' + err.message;
        }
      }
    });
  });

  $$('[data-repair]').forEach((b) => {
    b.addEventListener('click', () => {
      const s = sourcesData.sources.find((x) => x.id === b.dataset.repair);
      if (s) runRepair(s);
    });
  });

  wireSourceMenus();
}

// Overflow menu wiring. Per-row open/close, arrow-key navigation between
// items, and a single document-level listener (installed once) for
// click-outside and Escape so we don't pile up handlers on every re-render.
function wireSourceMenus() {
  $$('[data-menu-btn]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.menuBtn;
      const menu = document.querySelector(`[data-menu="${id}"]`);
      if (!menu) return;
      const willOpen = menu.hidden;
      closeAllSourceMenus();
      if (willOpen) openSourceMenu(btn, menu);
    });
  });

  $$('.source-menu').forEach((menu) => {
    menu.addEventListener('keydown', (e) => {
      const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
      const idx = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        items[(idx + 1) % items.length]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        items[(idx - 1 + items.length) % items.length]?.focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        items[0]?.focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        items[items.length - 1]?.focus();
      }
    });
    // Close on item activation — the underlying data-delete / data-repair
    // handlers already ran (event delegation attaches them above).
    menu.querySelectorAll('[role="menuitem"]').forEach((item) => {
      item.addEventListener('click', () => closeAllSourceMenus());
    });
  });
}

function openSourceMenu(btn, menu) {
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  const first = menu.querySelector('[role="menuitem"]');
  first?.focus();
}

function closeAllSourceMenus() {
  $$('.source-menu').forEach((menu) => {
    if (!menu.hidden) {
      menu.hidden = true;
      const id = menu.dataset.menu;
      const btn = document.querySelector(`[data-menu-btn="${id}"]`);
      btn?.setAttribute('aria-expanded', 'false');
    }
  });
}

// Installed once at module load — click-outside and Escape close any open
// source menu. Survives loadSources() re-renders because it lives on document.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.source-menu-wrap')) closeAllSourceMenus();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = document.querySelector('.source-menu:not([hidden])');
  if (!open) return;
  const id = open.dataset.menu;
  const btn = document.querySelector(`[data-menu-btn="${id}"]`);
  closeAllSourceMenus();
  btn?.focus();
});

// ===== Add source form =====
function renderFormFields() {
  const fields = $('#form-fields');
  const name = `<label>Display name</label><input type="text" id="f-name" placeholder="${activeKind === 'bookmark' ? "e.g. NYC Mayor's Office" : 'e.g. ' + activeKind + ' source'}">`;

  let body = '';
  if (activeKind === 'greenhouse') {
    body = `
      ${name}
      <label>Greenhouse slug</label>
      <input type="text" id="f-slug" placeholder="e.g. cravath, davispolk">
      <p class="form-help">Find via the company's careers URL: <code>boards.greenhouse.io/&lt;slug&gt;</code></p>
    `;
  } else if (activeKind === 'lever') {
    body = `
      ${name}
      <label>Lever slug</label>
      <input type="text" id="f-slug" placeholder="e.g. someorg">
      <p class="form-help">Find via the company's careers URL: <code>jobs.lever.co/&lt;slug&gt;</code></p>
    `;
  } else if (activeKind === 'smartfetch') {
    body = `
      ${name}
      <label>URL of careers page</label>
      <input type="url" id="f-url" placeholder="https://example.org/careers">
      <p class="form-help">⚠ AI-extracted listings. Pages that load via JavaScript may return zero results — always test before saving. Roughly 70% reliable.</p>
    `;
  } else if (activeKind === 'bookmark') {
    body = `
      ${name}
      <label>URL</label>
      <input type="url" id="f-url" placeholder="https://www.nyc.gov/jobs">
      <label>Cadence (days between reminders)</label>
      <input type="number" id="f-cadence" value="7" min="1" max="60">
      <p class="form-help">No auto-scrape. AnyaJob will remind you in the morning brief on this cadence.</p>
    `;
  }
  fields.innerHTML = body;
}

function getFormConfig() {
  const cfg = {};
  if (activeKind === 'greenhouse' || activeKind === 'lever') {
    cfg.slug = $('#f-slug')?.value.trim();
  } else if (activeKind === 'smartfetch') {
    cfg.url = $('#f-url')?.value.trim();
  } else if (activeKind === 'bookmark') {
    cfg.url = $('#f-url')?.value.trim();
    cfg.cadenceDays = parseInt($('#f-cadence')?.value, 10) || 7;
  }
  return cfg;
}

function getFormName() {
  const n = $('#f-name')?.value.trim();
  if (n) return n;
  const cfg = getFormConfig();
  return cfg.slug || cfg.url || activeKind;
}

$('#show-add-form').addEventListener('click', () => {
  $('#add-form').style.display = 'block';
  $('#show-add-form').style.display = 'none';
  renderFormFields();
});

$('#cancel-btn').addEventListener('click', () => {
  $('#add-form').style.display = 'none';
  $('#show-add-form').style.display = '';
  $('#test-result').style.display = 'none';
});

$$('.kind-tab').forEach((t) => {
  t.addEventListener('click', () => {
    activeKind = t.dataset.kind;
    $$('.kind-tab').forEach((x) => x.classList.toggle('active', x === t));
    renderFormFields();
    $('#test-result').style.display = 'none';
  });
});

$('#test-btn').addEventListener('click', async () => {
  const result = $('#test-result');
  result.style.display = 'block';
  result.className = 'test-result';
  result.innerHTML = '<span class="spinner sm"></span> Testing… (this may take 5-15 seconds for smart fetch)';
  const btn = $('#test-btn');
  const originalBtn = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner sm"></span> Testing…';

  try {
    const data = await api('/api/sources/test', {
      method: 'POST',
      body: { kind: activeKind, name: getFormName(), config: getFormConfig() },
    });
    if (data.error) {
      result.className = 'test-result err';
      result.innerHTML = '✗ ' + escapeHtml(data.error);
    } else {
      result.className = 'test-result ok';
      let html = `✓ Found ${data.count} listing${data.count === 1 ? '' : 's'} in ${data.durationMs}ms.`;
      if (data.sample?.length) {
        html += '<h4>Sample</h4><ul>';
        for (const s of data.sample) {
          html += `<li>${escapeHtml(s.title)}${s.company ? ' — ' + escapeHtml(s.company) : ''}</li>`;
        }
        html += '</ul>';
      }
      if (data.count === 0) {
        html += '<p style="margin-top:8px;color:var(--warn)">⚠ Zero listings extracted. The page may load content via JavaScript, or there may be no listings posted right now.</p>';
      }
      result.innerHTML = html;
    }
  } catch (err) {
    result.className = 'test-result err';
    result.innerHTML = '✗ ' + err.message;
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalBtn;
  }
});

$('#save-btn').addEventListener('click', async () => {
  const btn = $('#save-btn');
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner sm on-primary"></span> Saving…';
  try {
    await api('/api/sources', {
      method: 'POST',
      body: {
        kind: activeKind,
        name: getFormName(),
        config: getFormConfig(),
        enabled: true,
      },
    });
    $('#cancel-btn').click();
    loadSources();
  } catch (err) {
    alertDialog({ title: 'Save failed', message: err.message });
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
});

// ===== Manual daily run =====
$('#run-daily-btn').addEventListener('click', async () => {
  const btn = $('#run-daily-btn');
  const status = $('#run-daily-status');

  const ok = await confirmDialog({
    title: 'Run job search now?',
    message: 'This will run the full job search now and may take a few minutes. Continue?',
    confirmLabel: 'Run Now',
  });
  if (!ok) return;

  setStatus(status, '');
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Running…';

  try {
    const res = await fetch('/api/run-daily', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) {
      const t = data.startedAt
        ? new Date(data.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : 'earlier';
      setStatus(status, 'Already running since ' + t, 'error');
    } else if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    } else {
      setStatus(status, '✓ Started — check back in a few minutes', 'success', 8000);
    }
  } catch (err) {
    setStatus(status, '✗ ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
});

// ===== Pending discoveries (from cron Discovery runs) =====
async function loadPendingDiscoveries() {
  const wrap = $('#pending-discoveries');
  let data;
  try {
    data = await api('/api/discoveries');
  } catch {
    wrap.style.display = 'none';
    pendingCount = 0;
    updateSourcesSub();
    return;
  }
  const pending = data.pending || [];
  if (pending.length === 0) {
    wrap.style.display = 'none';
    pendingCount = 0;
    updateSourcesSub();
    return;
  }

  pendingCount = pending.length;
  updateSourcesSub();
  wrap.style.display = 'block';
  // Soft pink callout anchors the AI's summary copy to the cards below
  // (which share the same pink left-accent), so the summary actually gets
  // read instead of skimmed past as label-adjacent metadata. The label +
  // count sit in a head row; the summary is the body of the callout.
  wrap.innerHTML = `
    <div class="pending-caption${data.lastSummary ? '' : ' is-empty'}">
      <div class="pending-caption-head">
        <span class="pending-caption-label">Pending review</span>
        <span class="pending-caption-count">${pending.length} ${pending.length === 1 ? 'candidate' : 'candidates'}</span>
      </div>
      ${data.lastSummary ? `<p class="pending-caption-summary">${escapeHtml(data.lastSummary)}</p>` : ''}
    </div>
    <div style="display:flex;flex-direction:column;gap:8px" id="pending-list"></div>
  `;

  const list = $('#pending-list');
  list.innerHTML = pending.map((c) => renderCandidateCard(c, {
    dataAttr: ` data-cand-id="${c.id}"`,
    actionsHtml: `
      <button class="btn primary" data-approve-id="${c.id}">Add to sources</button>
      <button class="btn ghost" data-dismiss-id="${c.id}">Dismiss</button>
    `,
  })).join('');

  $$('[data-approve-id]').forEach((b) => {
    b.addEventListener('click', async () => {
      const id = b.dataset.approveId;
      b.disabled = true;
      b.innerHTML = '<span class="spinner sm on-primary"></span>';
      try {
        await api('/api/discoveries/' + id + '/approve', { method: 'POST', body: {} });
        b.textContent = '✓ Added';
        b.closest('.source-card').style.opacity = '0.5';
        loadSources();
        // Refresh after a short delay so she sees the success state
        setTimeout(loadPendingDiscoveries, 800);
      } catch (err) {
        alertDialog({ title: 'Add failed', message: err.message });
        b.disabled = false;
        b.textContent = 'Add to sources';
      }
    });
  });

  $$('[data-dismiss-id]').forEach((b) => {
    b.addEventListener('click', async () => {
      const id = b.dataset.dismissId;
      const originalLabel = b.innerHTML;
      b.disabled = true;
      b.innerHTML = '<span class="spinner sm"></span>';
      try {
        await api('/api/discoveries/' + id + '/dismiss', { method: 'POST', body: {} });
        b.closest('.source-card').remove();
        // If that was the last one, hide the wrap
        if ($('#pending-list')?.children.length === 0) {
          setTimeout(loadPendingDiscoveries, 300);
        }
      } catch (err) {
        alertDialog({ title: 'Dismiss failed', message: err.message });
        b.disabled = false;
        b.innerHTML = originalLabel;
      }
    });
  });

  // If we landed here from the email link, scroll the section into view
  if (new URLSearchParams(location.search).get('from') === 'email') {
    document.getElementById('section-sources')?.classList.add('open');
    scrollToEl(wrap, { block: 'start' });
  }
}

// ===== Source discovery (modal-driven) =====
// "Find new sources" opens a focused modal: textarea for the optional
// steering hint, loading state during the 30–60s AI run, then a result
// panel that summarizes the outcome. Candidates themselves never render
// inside the modal — they land in the pending-discoveries zone, which
// is the single canonical surface for "candidates awaiting review".
// This kills the prior live-vs-persisted duplication where the same
// candidate could be dismissed in two different places with two
// different behaviors.
let _discoverBackdrop = null;
let _discoverState = 'idle'; // 'idle' | 'form' | 'loading' | 'result'

function getDiscoverBackdrop() {
  if (_discoverBackdrop) return _discoverBackdrop;
  _discoverBackdrop = document.createElement('div');
  _discoverBackdrop.className = 'modal-backdrop discover-backdrop';
  _discoverBackdrop.innerHTML = `
    <div class="modal discover-modal" role="dialog" aria-modal="true" aria-labelledby="discover-modal-title">
      <div class="modal-head">
        <div class="modal-title" id="discover-modal-title">Find new sources</div>
        <button class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body" id="discover-body"></div>
    </div>
  `;
  document.body.appendChild(_discoverBackdrop);
  _discoverBackdrop.addEventListener('click', (e) => {
    // Click on the backdrop dismisses; clicks inside the modal don't.
    // Loading state blocks dismissal — the run is still in flight and
    // the user explicitly chose "stay open through completion".
    if (e.target === _discoverBackdrop && _discoverState !== 'loading') closeDiscover();
  });
  _discoverBackdrop.querySelector('.modal-close').addEventListener('click', () => {
    if (_discoverState !== 'loading') closeDiscover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape'
      && _discoverBackdrop.classList.contains('open')
      && _discoverState !== 'loading') closeDiscover();
  });
  return _discoverBackdrop;
}

function openDiscover() {
  const backdrop = getDiscoverBackdrop();
  backdrop.classList.add('open');
  document.body.style.overflow = 'hidden';
  renderDiscoverForm();
  // Focus the textarea so she can start typing immediately. Defer one
  // frame so the modal is laid out before focus moves into it.
  requestAnimationFrame(() => {
    document.getElementById('discover-hint')?.focus();
  });
}

function closeDiscover() {
  if (_discoverBackdrop) _discoverBackdrop.classList.remove('open');
  document.body.style.overflow = '';
  _discoverState = 'idle';
}

// Form state: textarea + Cancel/Find buttons. Re-rendered after errors
// (with the user's previous hint preserved) so she can edit and retry.
function renderDiscoverForm(prefillHint = '') {
  _discoverState = 'form';
  const body = $('#discover-body');
  body.innerHTML = `
    <div class="discover-form">
      <label class="discover-form-label" for="discover-hint">Steer this run (optional)</label>
      <textarea id="discover-hint" rows="4" maxlength="500" placeholder="e.g. focus on environmental nonprofits in NYC, or more federal/policy roles, less BigLaw"></textarea>
      <p class="discover-form-help">Tell the AI what direction to bias toward. Only applies to this run — not saved.</p>
    </div>
    <div class="discover-form-footer">
      <button class="btn ghost" id="discover-cancel">Cancel</button>
      <button class="btn primary" id="discover-submit">Find sources</button>
    </div>
  `;
  if (prefillHint) {
    const ta = document.getElementById('discover-hint');
    if (ta) ta.value = prefillHint;
  }
  $('#discover-cancel').addEventListener('click', closeDiscover);
  $('#discover-submit').addEventListener('click', runDiscover);
}

async function runDiscover() {
  const hint = ($('#discover-hint')?.value || '').trim();
  _discoverState = 'loading';
  const body = $('#discover-body');
  body.innerHTML = `
    <div class="repair-loading">
      <div class="repair-spinner"></div>
      <div>Searching the web for sources matching her profile…</div>
      <div style="font-size:12px;color:var(--muted);margin-top:6px">This usually takes 30–60 seconds.</div>
    </div>
  `;

  try {
    const data = await api('/api/sources/discover', { method: 'POST', body: hint ? { hint } : {} });
    if (data.error) throw new Error(data.error);
    renderDiscoverResult(data);
  } catch (err) {
    renderDiscoverError(err, hint);
  }
}

function renderDiscoverResult(data) {
  _discoverState = 'result';
  const cands = data.candidates || [];
  const summary = data.summary
    ? `<div class="discover-result-summary">${escapeHtml(data.summary)}</div>`
    : '';
  const message = cands.length === 0
    ? '<div class="discover-result-message empty">No new candidates found. The structured sources she already has may cover the search well.</div>'
    : `<div class="discover-result-message ok">Found ${cands.length} new candidate${cands.length === 1 ? '' : 's'}. Review them in the Pending zone above.</div>`;
  const body = $('#discover-body');
  body.innerHTML = `
    <div class="discover-result">
      ${message}
      ${summary}
    </div>
    <div class="discover-result-footer">
      <button class="btn primary" id="discover-done">Done</button>
    </div>
  `;
  $('#discover-done').addEventListener('click', () => {
    closeDiscover();
    // Refresh pending zone (new candidates landed there server-side) and
    // scroll it into view so she can see what arrived.
    loadPendingDiscoveries().then(() => {
      if (cands.length > 0) {
        document.getElementById('section-sources')?.classList.add('open');
        scrollToEl($('#pending-discoveries'), { block: 'start' });
      }
    });
  });
}

function renderDiscoverError(err, prevHint) {
  _discoverState = 'result';
  const body = $('#discover-body');
  body.innerHTML = `
    <div class="discover-result">
      <div class="discover-result-message err">Discovery failed: ${escapeHtml(err.message)}</div>
    </div>
    <div class="discover-result-footer">
      <button class="btn ghost" id="discover-error-close">Close</button>
      <button class="btn primary" id="discover-retry">Retry</button>
    </div>
  `;
  $('#discover-error-close').addEventListener('click', closeDiscover);
  $('#discover-retry').addEventListener('click', () => renderDiscoverForm(prevHint));
}

$('#discover-btn').addEventListener('click', openDiscover);

// ===== Preferences (shared state) =====
let prefs = null;
async function loadPrefs() {
  prefs = await api('/api/preferences');
  $('#json').value = JSON.stringify(prefs, null, 2);
  renderNotifySection();
  renderGradingSection();
}

// Friendly editors for the scoring knobs (goals + weighting). Reads from the
// shared `prefs` object; kept in sync with the raw JSON editor below.
function renderGradingSection() {
  // Back-compat: a legacy single `goals` string seeds the Emphasize field.
  $('#emphasize').value = prefs?.emphasize || prefs?.goals || '';
  $('#deprioritize').value = prefs?.deprioritize || '';
  const weight = prefs?.scoreWeighting || 'law-school';
  const radio = document.querySelector(`input[name="weighting"][value="${weight}"]`)
    || document.querySelector('input[name="weighting"][value="law-school"]');
  if (radio) radio.checked = true;
  updatePromptPreview();
}

// Live preview of the exact priorities block the scoring prompt receives.
// MUST mirror buildSystemBlocks() in src/prompts.js — if that wording changes,
// change it here too. Both fields empty → the block is omitted entirely.
function buildPriorityPreview(emphasize, deprioritize) {
  const lines = [];
  if (emphasize) lines.push(`- Emphasize (nudge these up): ${emphasize}`);
  if (deprioritize) lines.push(`- Deprioritize / avoid (nudge these down): ${deprioritize}`);
  if (!lines.length) return null;
  return "HER CURRENT PRIORITIES — use these to prioritize WITHIN the rubric above. "
    + "They raise or lower a role's standing, but do NOT change the 0-10 scale, "
    + "the two dimensions, or the required JSON output format:\n"
    + lines.join('\n');
}

function updatePromptPreview() {
  const body = $('#prompt-preview-body');
  const empty = $('#prompt-preview-empty');
  if (!body) return;
  const preview = buildPriorityPreview(
    $('#emphasize').value.trim(),
    $('#deprioritize').value.trim(),
  );
  if (preview) {
    body.textContent = preview;
    body.hidden = false;
    if (empty) empty.hidden = true;
  } else {
    body.textContent = '';
    body.hidden = true;
    if (empty) empty.hidden = false;
  }
}

$('#emphasize')?.addEventListener('input', updatePromptPreview);
$('#deprioritize')?.addEventListener('input', updatePromptPreview);

$('#save-grading').addEventListener('click', async () => {
  const status = $('#grading-status');
  const btn = $('#save-grading');
  const originalLabel = btn.innerHTML;
  const emphasize = $('#emphasize').value.trim();
  const deprioritize = $('#deprioritize').value.trim();
  const scoreWeighting = document.querySelector('input[name="weighting"]:checked')?.value || 'law-school';
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner sm on-primary"></span> Saving…';
  try {
    const updated = { ...prefs, emphasize, deprioritize, scoreWeighting };
    delete updated.goals; // retire the legacy single-field shape on save
    await api('/api/preferences', { method: 'POST', body: updated });
    prefs = updated;
    $('#json').value = JSON.stringify(updated, null, 2);
    setStatus(status, '✓ Saved — new roles use this immediately; re-score existing ones from their card', 'success', 4000);
  } catch (err) {
    setStatus(status, 'Save failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
});

$('#save-prefs').addEventListener('click', async () => {
  const status = $('#prefs-status');
  const btn = $('#save-prefs');
  const originalLabel = btn.innerHTML;
  let parsed;
  try {
    parsed = JSON.parse($('#json').value);
  } catch (err) {
    setStatus(status, 'Invalid JSON: ' + err.message, 'error');
    return;
  }
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner sm on-primary"></span> Saving…';
  try {
    await api('/api/preferences', { method: 'POST', body: parsed });
    prefs = parsed;
    renderNotifySection(); // pick up changes if user edited notifications JSON directly
    renderGradingSection(); // ditto for goals / weighting
    setStatus(status, '✓ Saved', 'success', 2000);
  } catch (err) {
    setStatus(status, 'Save failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
});

$('#reset-prefs').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Reset preferences to defaults?',
    message: 'This will overwrite the current profile, keywords, and companies. Notifications will be preserved.',
    confirmLabel: 'Reset',
    destructive: true,
  });
  if (!ok) return;
  const btn = $('#reset-prefs');
  const originalLabel = btn.innerHTML;
  const status = $('#prefs-status');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner sm"></span> Loading…';
  try {
    const defaults = await api('/api/preferences/example');
    // Preserve current notifications so we don't blow away her email setup
    if (prefs?.notifications) defaults.notifications = prefs.notifications;
    $('#json').value = JSON.stringify(defaults, null, 2);
    setStatus(status, 'Defaults loaded — review then click Save');
  } catch (err) {
    setStatus(status, 'Reset failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
});

// ===== Notifications form =====
function getRecipientsFromPrefs() {
  const n = prefs?.notifications || {};
  // Backward compat: old `recipient` (string) maps to single-element list
  const list = Array.isArray(n.to) && n.to.length
    ? n.to
    : (n.recipient ? [n.recipient] : []);
  return list.length ? list : [''];
}

function renderRecipientList(list) {
  const wrap = $('#recipient-list');
  wrap.innerHTML = list.map((addr, i) => `
    <div class="email-row">
      <input type="email" class="rcpt-input" data-idx="${i}" value="${escapeHtml(addr)}" placeholder="email@example.com">
      <button class="icon-btn-sm danger" data-rm-idx="${i}" title="Remove" ${list.length === 1 ? 'disabled' : ''}>×</button>
    </div>
  `).join('');
  wrap.querySelectorAll('[data-rm-idx]').forEach((b) => {
    b.addEventListener('click', () => {
      const arr = collectRecipients();
      arr.splice(parseInt(b.dataset.rmIdx, 10), 1);
      renderRecipientList(arr.length ? arr : ['']);
    });
  });
}

function collectRecipients() {
  return Array.from(document.querySelectorAll('.rcpt-input')).map((i) => i.value.trim()).filter(Boolean);
}

function renderNotifySection() {
  const n = prefs?.notifications || {};
  renderRecipientList(getRecipientsFromPrefs());
  $('#toggle-morning').checked = n.morningEmail !== false;
  $('#toggle-weekly').checked = n.weeklyEmail !== false;

  const list = getRecipientsFromPrefs().filter(Boolean);
  const types = [];
  if (n.morningEmail !== false) types.push('morning');
  if (n.weeklyEmail !== false) types.push('weekly');
  $('#notify-sub').textContent = list.length === 0
    ? 'No recipients set'
    : `${list.length} recipient${list.length === 1 ? '' : 's'} · ${types.length} email type${types.length === 1 ? '' : 's'} on`;
}

$('#add-recipient').addEventListener('click', () => {
  const arr = collectRecipients();
  arr.push('');
  renderRecipientList(arr);
  // Focus the new input
  const inputs = document.querySelectorAll('.rcpt-input');
  inputs[inputs.length - 1]?.focus();
});

$('#save-notify').addEventListener('click', async () => {
  const status = $('#notify-status');
  const btn = $('#save-notify');
  const originalLabel = btn.innerHTML;
  const to = collectRecipients();
  // Light validation: each must look like an email
  const bad = to.find((s) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
  if (bad) {
    setStatus(status, 'Invalid email: ' + bad, 'error');
    return;
  }
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner sm on-primary"></span> Saving…';
  try {
    const updated = {
      ...prefs,
      notifications: {
        to,
        morningEmail: $('#toggle-morning').checked,
        weeklyEmail: $('#toggle-weekly').checked,
      },
    };
    // Drop legacy `recipient` field if present
    if (updated.notifications.recipient) delete updated.notifications.recipient;
    await api('/api/preferences', { method: 'POST', body: updated });
    prefs = updated;
    $('#json').value = JSON.stringify(updated, null, 2);
    renderNotifySection();
    setStatus(status, '✓ Saved', 'success', 2000);
  } catch (err) {
    setStatus(status, 'Save failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
});

loadPrefs();

// ===== Email previews + test send (formerly /notifications.html) =====
// Lazy-loaded: the preview iframe + log only fetch when she actually opens
// the Notifications section, so the settings page itself stays cheap.
let activePreviewKind = 'morning';
let previewLoaded = false;

async function loadPreview() {
  try {
    const data = await api(`/api/notify/preview/${activePreviewKind}`);
    $('#preview-subject').textContent = data.subject;
    const iframe = $('#preview-iframe');
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(data.html);
    doc.close();
  } catch (err) {
    $('#preview-subject').textContent = 'Could not load preview';
  }
}

async function loadPreviewLog() {
  try {
    const log = await api('/api/notify/log');
    const recent = (log.sent || []).slice(-10).reverse();
    if (recent.length === 0) {
      $('#preview-log').innerHTML = '<div style="padding:18px;text-align:center;color:var(--muted);font-size:12px">No emails sent yet.</div>';
      return;
    }
    $('#preview-log').innerHTML = recent.map((e, i) => `
      <div style="display:flex;justify-content:space-between;padding:8px 12px;${i < recent.length - 1 ? 'border-bottom:1px solid var(--border);' : ''}align-items:center;font-size:12px">
        <div>
          <div style="font-weight:500">${escapeHtml(e.subject)}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px">${e.kind} · ${new Date(e.sentAt).toLocaleString()}</div>
        </div>
        <span class="status-badge status-applied">sent</span>
      </div>
    `).join('');
  } catch {}
}

$$('[data-preview-kind]').forEach((b) => {
  b.addEventListener('click', () => {
    activePreviewKind = b.dataset.previewKind;
    $$('[data-preview-kind]').forEach((x) => x.classList.toggle('active', x === b));
    loadPreview();
  });
});

$('#preview-send-test').addEventListener('click', async () => {
  const to = $('#preview-test-to').value.trim();
  const status = $('#preview-status');
  const btn = $('#preview-send-test');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner sm"></span> Sending…';
  try {
    const res = await fetch('/api/notify/send-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: activePreviewKind, to: to || undefined }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    status.textContent = '✓ Sent (' + data.messageId + ')';
    status.style.color = 'var(--green-ink)';
    loadPreviewLog();
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
    status.style.color = 'var(--bad)';
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

// The general section-head click handler (top of file) toggles `.open` first;
// our listener runs after, sees the new state, and lazy-loads on first open.
document.querySelector('#section-notify .section-head').addEventListener('click', () => {
  if (previewLoaded) return;
  if (document.querySelector('#section-notify').classList.contains('open')) {
    previewLoaded = true;
    loadPreview();
    loadPreviewLog();
  }
});

// Theme picker moved out of Settings — the sun/moon button in the header
// (rendered by nav.js, wired by /theme-toggle.js) is now the single
// place to flip between auto / light / dark. The no-FOUC inline script
// in each HTML <head> still applies the stored theme before paint, so
// nothing here is needed for theme.

// ===== Spend =====
api('/api/spend').then((s) => {
  const days = Object.entries(s.byDay || {}).sort();
  const last7 = days.slice(-7);
  const total = last7.reduce((sum, [, v]) => sum + v, 0);
  const html = last7.map(([d, v]) => `
    <div class="spend-row"><span>${d}</span><span>$${v.toFixed(4)}</span></div>
  `).join('');
  $('#spend').innerHTML = (html || '<p style="color:var(--muted);font-size:13px">No spend yet.</p>') +
    `<div class="spend-row total"><span>7-day total</span><span>$${total.toFixed(4)}</span></div>`;
});

loadSources();
loadPendingDiscoveries();
