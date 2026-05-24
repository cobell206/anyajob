import {
  $, $$, escapeHtml, api,
  confirmDialog, alertDialog, setStatus, renderEmptyState,
} from './app.js';

// Inline SVGs replace emoji glyphs in the source-card row. Lucide-style
// 24×24 stroked icons, sized by the parent (.icon-btn-sm svg { 16px }).
const SVG_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 4 20 12 6 20"/></svg>';
const SVG_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const SVG_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const SVG_ALERT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="13" height="13"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

// Section accordion
$$('.section-head').forEach((h) => {
  h.addEventListener('click', () => {
    h.parentElement.classList.toggle('open');
  });
});

// ===== Sources =====
let sourcesData = { sources: [] };
let activeKind = 'greenhouse';

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
  let configLine = '';
  if (s.kind === 'greenhouse' || s.kind === 'lever') configLine = 'slug: ' + (s.config?.slug || '?');
  else if (s.kind === 'smartfetch' || s.kind === 'bookmark') configLine = s.config?.url || '?';

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

  // Bookmarks don't fetch — runOne short-circuits — so no "Run now" button.
  const runBtn = s.kind === 'bookmark' ? '' :
    `<button class="icon-btn-sm run-btn" data-run="${s.id}" title="Run now" aria-label="Run ${safeName} now">${SVG_PLAY}<span>Run</span></button>`;
  const repairBtn = isRepairable(s)
    ? `<button class="repair-btn" data-repair="${s.id}" title="Use AI web search to find the new URL" aria-label="Find new URL for ${safeName}">${SVG_SEARCH}<span>Find URL</span></button>`
    : '';

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

  return `
    <div class="source-card ${s.enabled ? '' : 'disabled'}">
      <div class="source-info">
        <div class="source-name"><span>${safeName}</span>${s.builtIn ? '<span class="source-builtin">· built-in</span>' : ''}</div>
        <div class="source-meta">${escapeHtml(configLine)}</div>
        <div class="source-stats">${stats}</div>
        <div class="run-result" data-run-result="${s.id}" style="display:none"></div>
      </div>
      <div class="source-actions">
        ${repairBtn}
        ${toggle}
        ${runBtn}
        <button class="icon-btn-sm danger" data-delete="${s.id}" title="Delete" aria-label="Delete ${safeName}">${SVG_X}</button>
      </div>
    </div>
  `;
}

// Shared template for a Discovery candidate row — used by both the live
// "Find new sources" panel and the persisted "Pending source candidates"
// panel. Keeping a single template prevents the two from drifting on copy,
// layout, or which fields are surfaced. Callers pass the action buttons
// (Add/Dismiss) because their data attributes differ: live uses position
// index (cands aren't persisted with IDs in the response), pending uses
// the candidate id.
function renderCandidateCard(c, { actionsHtml, dataAttr = '' }) {
  const isStructured = c.kind === 'greenhouse' || c.kind === 'lever';
  // Slug is the canonical identifier for structured sources, so we surface
  // it as metadata. For smartfetch/bookmark the slug is absent and the URL
  // is the only identifier — show it once, as a link, never duplicated.
  const slugLine = isStructured && c.config?.slug
    ? `<div class="source-meta">slug: ${escapeHtml(c.config.slug)}</div>`
    : '';
  const url = c.url || c.config?.url;
  const urlLine = url
    ? `<div class="source-meta"><a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="color:var(--blue-ink);text-decoration:none">${escapeHtml(url)} ↗</a></div>`
    : '';
  // Confidence chip rides in the header row to the right of the name. The
  // word "confidence" is dropped — context (the badge color + position next
  // to a discovery suggestion) makes "HIGH" / "MEDIUM" / "LOW" unambiguous.
  const conf = c.confidence;
  const confBadge = conf
    ? `<span class="confidence-badge confidence-${escapeHtml(conf)}" title="${escapeHtml(conf)} confidence">${escapeHtml(conf)}</span>`
    : '';
  const rationale = c.rationale
    ? `<div class="candidate-rationale">${escapeHtml(c.rationale)}</div>`
    : '';
  const overlapWarning = c.overlapsWith
    ? `<div class="candidate-overlap">⚠ Overlaps with smartfetch source <strong>${escapeHtml(c.overlapsWith.name)}</strong>. Adding this would cause double-fetching — consider disabling that source after.</div>`
    : '';
  // Kind badge is only shown for bookmarks — they behave differently (no
  // auto-fetch, surfaced on a cadence) and that's a decision-relevant fact
  // for her before approving. Auto-fetching kinds (greenhouse, lever,
  // smartfetch) don't need a badge: behavior is uniform.
  const kindTag = c.kind === 'bookmark'
    ? '<span class="kind-badge kind-bookmark">Manual</span>'
    : '';
  return `
    <div class="source-card candidate-card"${dataAttr}>
      <div class="candidate-header">
        ${kindTag}
        <div class="source-name">${escapeHtml(c.name)}</div>
        ${confBadge}
      </div>
      ${slugLine}
      ${urlLine}
      ${rationale}
      ${overlapWarning}
      <div class="candidate-actions">${actionsHtml}</div>
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
      const enabled = sourcesData.sources.filter((x) => x.enabled).length;
      $('#sources-sub').textContent = `${sourcesData.sources.length} configured · ${enabled} enabled`;
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
  const enabled = sourcesData.sources.filter((s) => s.enabled).length;
  $('#sources-sub').textContent = `${sourcesData.sources.length} configured · ${enabled} enabled`;
  $('#source-list').innerHTML = sourcesData.sources.map(renderSource).join('');

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
        const total = sourcesData.sources.length;
        const on = sourcesData.sources.filter((x) => x.enabled).length;
        $('#sources-sub').textContent = `${total} configured · ${on} enabled`;
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
}

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
    return;
  }
  const pending = data.pending || [];
  if (pending.length === 0) {
    wrap.style.display = 'none';
    return;
  }

  wrap.style.display = 'block';
  // The pink left-border on each .candidate-card now carries the "this is
  // pending review" signal, so the section just needs a quiet caption above.
  wrap.innerHTML = `
    <div class="pending-caption">
      <span class="pending-caption-label">Pending review</span>
      <span class="pending-caption-count">${pending.length} ${pending.length === 1 ? 'candidate' : 'candidates'}</span>
      ${data.lastSummary ? `<span class="pending-caption-summary">${escapeHtml(data.lastSummary)}</span>` : ''}
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
    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// ===== Source discovery (live, button-triggered) =====
$('#discover-btn').addEventListener('click', async () => {
  const panel = $('#discover-panel');
  const status = $('#discover-status');
  const summary = $('#discover-summary');
  const list = $('#discover-candidates');
  const btn = $('#discover-btn');

  panel.style.display = 'block';
  status.innerHTML = '<span class="spinner sm"></span> Searching the web for sources matching your profile…';
  status.style.color = 'var(--muted)';
  summary.style.display = 'none';
  list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px">This usually takes 30-60 seconds…</div>';
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner sm"></span> Searching…';

  try {
    const hintInput = $('#discover-hint');
    const hint = (hintInput?.value || '').trim();
    const data = await api('/api/sources/discover', { method: 'POST', body: hint ? { hint } : {} });
    if (data.error) throw new Error(data.error);

    if (hintInput) hintInput.value = '';

    const cands = data.candidates || [];
    status.textContent = `Found ${cands.length} candidate${cands.length === 1 ? '' : 's'}.`;
    status.style.color = 'var(--green-ink)';
    if (data.summary) {
      summary.textContent = data.summary;
      summary.style.display = 'block';
    }

    if (cands.length === 0) {
      list.innerHTML = renderEmptyState('No new candidates found. The structured sources you already have may cover your search well.');
    } else {
      list.innerHTML = cands.map((c, i) => renderCandidateCard(c, {
        dataAttr: ` data-cand-idx="${i}"`,
        actionsHtml: `
          <button class="btn primary" data-add-idx="${i}">Add to sources</button>
          <button class="btn ghost" data-skip-idx="${i}">Dismiss</button>
        `,
      })).join('');

      // Wire up Add buttons
      $$('[data-add-idx]').forEach((b) => {
        b.addEventListener('click', async () => {
          const c = cands[parseInt(b.dataset.addIdx, 10)];
          const originalLabel = b.innerHTML;
          b.disabled = true;
          b.innerHTML = '<span class="spinner sm on-primary"></span>';
          try {
            await api('/api/sources', {
              method: 'POST',
              body: { kind: c.kind, name: c.name, config: c.config, enabled: true },
            });
            // Mark this card as added
            const card = b.closest('.source-card');
            card.style.opacity = '0.5';
            b.textContent = '✓ Added';
            loadSources();
          } catch (err) {
            b.disabled = false;
            b.innerHTML = originalLabel;
            alertDialog({ title: 'Add failed', message: err.message });
          }
        });
      });

      // Wire up Dismiss buttons. Live candidates are persisted server-side
      // by /api/sources/discover but the response doesn't surface their IDs,
      // so dismiss here is DOM-only — they'll reappear in the pending panel
      // on next page load. Plumbing IDs through is a follow-up.
      $$('[data-skip-idx]').forEach((b) => {
        b.addEventListener('click', () => {
          b.closest('.source-card').remove();
        });
      });
    }
  } catch (err) {
    status.textContent = '✗ Discovery failed: ' + err.message;
    status.style.color = 'var(--bad)';
    list.innerHTML = '';
  } finally {
    btn.disabled = false;
    btn.innerHTML = '✨ Find new sources';
  }
});

// ===== Preferences (shared state) =====
let prefs = null;
async function loadPrefs() {
  prefs = await api('/api/preferences');
  $('#json').value = JSON.stringify(prefs, null, 2);
  renderNotifySection();
}

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
