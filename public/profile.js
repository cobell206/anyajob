// public/profile.js — drives the profile page

import {
  $, $$, escapeHtml, api, fmtDateLong,
  alertDialog,
} from './app.js';

let prefs = null;
let dirty = false;

// Auto-save tuning. Coalesce typing into a single POST 600ms after the user
// stops; immediate flush on blur, chip changes, and explicit Save click.
const SAVE_DEBOUNCE_MS = 600;
let saveTimer = null;
let saveInFlight = null;

const PROFILE_FIELDS = [
  'name', 'currentRole', 'yearsOutOfUndergrad', 'undergradSchool',
  'gpaRange', 'lsatStatus', 'geo', 'additionalContext',
];

// ---------- Resume ----------

function renderResume(meta) {
  const root = $('#resume-state');
  if (!meta) {
    // Empty-state: a dignified drop target with a paper-document glyph and
    // editorial copy. Click anywhere on the surface opens the file picker;
    // drag-and-drop is wired by wireDropzone().
    root.innerHTML = `
      <div class="resume-blank" id="resume-drop">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="8" y1="13" x2="14" y2="13"/>
          <line x1="8" y1="17" x2="16" y2="17"/>
        </svg>
        <div class="resume-blank-prompt">Drag a résumé here, or <em>click to browse</em>.</div>
        <div class="resume-blank-help">PDF · DOCX · DOC · TXT — up to 5 MB</div>
      </div>
    `;
    wireDropzone();
    return;
  }
  const sizeKb = Math.round((meta.sizeBytes || 0) / 1024);
  root.innerHTML = `
    <div class="resume-current">
      <div class="resume-current-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="8" y1="13" x2="14" y2="13"/>
          <line x1="8" y1="17" x2="16" y2="17"/>
        </svg>
      </div>
      <div class="resume-current-info">
        <div class="resume-current-name">${escapeHtml(meta.originalName || meta.file)}</div>
        <div class="resume-current-meta">Filed ${fmtDateLong(meta.uploadedAt)} · ${sizeKb} KB</div>
      </div>
      <div class="resume-actions">
        <button class="btn-link" id="resume-view-btn" type="button">View</button>
        <button class="btn-link" id="resume-replace-btn" type="button">Replace</button>
        <button class="btn-link danger" id="resume-remove-btn" type="button">Remove</button>
      </div>
    </div>
  `;
  $('#resume-view-btn').addEventListener('click', () => {
    window.open('/api/profile/resume?download=1', '_blank');
  });
  $('#resume-replace-btn').addEventListener('click', () => $('#resume-file').click());
  $('#resume-remove-btn').addEventListener('click', removeResume);
}

function wireDropzone() {
  const zone = $('#resume-drop');
  if (!zone) return;
  zone.addEventListener('click', () => $('#resume-file').click());
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) uploadResume(e.dataTransfer.files[0]);
  });
}

async function uploadResume(file) {
  const root = $('#resume-state');
  root.innerHTML = '<div class="resume-pending"><span class="spinner sm"></span> Filing résumé…</div>';
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch('/api/profile/resume', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'upload failed');
    renderResume(data.resume);
  } catch (err) {
    alertDialog({ title: 'Upload failed', message: err.message });
    await loadResume();
  }
}

async function removeResume() {
  if (!confirm('Remove your resume? Scoring and discovery will fall back to the structured profile only.')) return;
  const root = $('#resume-state');
  root.innerHTML = '<div style="padding:14px;color:var(--muted)"><span class="spinner sm"></span> Removing…</div>';
  try {
    await fetch('/api/profile/resume', { method: 'DELETE' });
  } finally {
    await loadResume();
  }
}

async function loadResume() {
  const data = await api('/api/profile/resume');
  renderResume(data.resume);
}

// ---------- About-you fields ----------

function renderProfileFields() {
  const p = prefs.profile || {};
  for (const k of PROFILE_FIELDS) {
    const el = $('#f-' + k);
    if (el) el.value = p[k] ?? '';
  }
}

function readProfileFields() {
  const p = { ...(prefs.profile || {}) };
  for (const k of PROFILE_FIELDS) {
    const el = $('#f-' + k);
    if (!el) continue;
    let v = el.value.trim();
    if (k === 'yearsOutOfUndergrad') v = v === '' ? null : Number(v);
    p[k] = v === '' ? null : v;
  }
  return p;
}

// ---------- Chip inputs ----------

function makeChipInput({ containerId, inputId, getValues, setValues }) {
  const container = $('#' + containerId);
  const input = $('#' + inputId);

  function render() {
    const values = getValues();
    container.querySelectorAll('.chip').forEach((c) => c.remove());
    for (const v of values) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = `${escapeHtml(v)}<button type="button" class="chip-x" aria-label="Remove">×</button>`;
      chip.querySelector('.chip-x').addEventListener('click', () => {
        setValues(values.filter((x) => x !== v));
        render();
        flushSave();
      });
      container.insertBefore(chip, input);
    }
  }

  function commit(raw) {
    const value = raw.trim().replace(/,$/, '').trim();
    if (!value) return;
    const values = getValues();
    if (values.includes(value)) return;
    setValues([...values, value]);
    render();
    flushSave();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit(input.value);
      input.value = '';
    } else if (e.key === 'Backspace' && !input.value) {
      const values = getValues();
      if (values.length) {
        setValues(values.slice(0, -1));
        render();
        flushSave();
      }
    }
  });
  input.addEventListener('blur', () => {
    if (input.value.trim()) {
      commit(input.value);
      input.value = '';
    }
  });

  container.addEventListener('click', (e) => {
    if (e.target === container) input.focus();
  });

  return { render };
}

// ---------- Save / dirty ----------

function setStatus(text, cls = '') {
  const el = $('#save-status');
  el.textContent = text;
  el.className = 'save-status ' + cls;
  // Reveal the "Discard pending changes" link only while dirty —
  // controlled by a class on the masthead row so CSS owns the fade.
  const row = $('#mast-status-row');
  if (row) row.classList.toggle('is-dirty', cls === 'dirty');
}

function markDirty() {
  if (!dirty) {
    dirty = true;
    setStatus('Unsaved — pen still down', 'dirty');
  }
}

function scheduleSave() {
  markDirty();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
}

async function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  // Wait for any in-flight save before issuing another, so changes never
  // arrive at the server out of order.
  if (saveInFlight) {
    try { await saveInFlight; } catch {}
  }
  if (!dirty) return;
  saveInFlight = save();
  try { await saveInFlight; } finally { saveInFlight = null; }
}

async function save() {
  const updated = {
    ...prefs,
    profile: {
      ...readProfileFields(),
      targetSchools: prefs.profile?.targetSchools || [],
      interestAreas: prefs.profile?.interestAreas || [],
    },
  };
  // The legacy bottom "Save changes" button no longer exists in the
  // dossier layout (auto-save handles everything). Guard the disabled
  // toggle so older cached HTML doesn't crash here either.
  const saveBtn = $('#save-btn');
  if (saveBtn) saveBtn.disabled = true;
  setStatus('Saving…');
  try {
    await api('/api/preferences', { method: 'POST', body: updated });
    prefs = updated;
    dirty = false;
    setStatus('Filed', 'saved');
    setTimeout(() => { if (!dirty) setStatus('auto-saves as you type'); }, 1800);
  } catch (err) {
    setStatus('Save failed: ' + err.message, 'dirty');
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

// ---------- Discovery ----------

async function runDiscovery() {
  const btn = $('#discover-btn');
  const out = $('#discovery-results');
  // Cache the original button content (SVG arrow + label) so the finally
  // block can restore it verbatim — naïvely writing the text back would
  // erase the arrow.
  const originalBtnHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner sm on-primary"></span><span>Searching…</span>';
  out.innerHTML = `
    <p class="discovery-pending">
      <span class="spinner sm"></span>
      <span>Working — Claude is searching the web. Usually 20–40 seconds.</span>
    </p>
  `;
  try {
    const data = await api('/api/sources/discover', { method: 'POST', body: { maxCandidates: 12 } });
    const candidates = data.candidates || [];
    if (!candidates.length) {
      out.innerHTML = `
        <p class="discovery-empty">
          Nothing new. The model didn't see anything beyond what you're already tracking.
        </p>
      `;
      return;
    }
    out.innerHTML = `
      <p class="discovery-summary">
        <strong>${candidates.length}</strong> candidate${candidates.length === 1 ? '' : 's'} found.
        Approve or dismiss them on the
        <a href="/settings.html#discoveries">Settings page</a>.
      </p>
      ${candidates.map((c) => {
        const url = c.url || c.config?.url;
        return `
        <div class="discovery-result">
          <div>
            <span class="discovery-result-name">${escapeHtml(c.name || c.kind)}</span>
            <span class="discovery-result-kind">${escapeHtml(c.kind || '')}</span>
          </div>
          ${c.rationale ? `<div class="discovery-result-rationale">${escapeHtml(c.rationale)}</div>` : ''}
          ${url ? `<div class="discovery-result-meta"><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)} ↗</a></div>` :
            (c.config?.slug ? `<div class="discovery-result-meta">${escapeHtml(c.config.slug)}</div>` : '')}
        </div>
      `;}).join('')}
    `;
  } catch (err) {
    out.innerHTML = `<p class="discovery-empty discovery-error">Discovery failed: ${escapeHtml(err.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalBtnHtml;
  }
}

// ---------- Init ----------

async function init() {
  prefs = await api('/api/preferences');
  renderProfileFields();

  const schools = makeChipInput({
    containerId: 'schools-chips',
    inputId: 'schools-input',
    getValues: () => prefs.profile?.targetSchools || [],
    setValues: (v) => {
      prefs.profile = prefs.profile || {};
      prefs.profile.targetSchools = v;
    },
  });
  schools.render();

  const interests = makeChipInput({
    containerId: 'interests-chips',
    inputId: 'interests-input',
    getValues: () => prefs.profile?.interestAreas || [],
    setValues: (v) => {
      prefs.profile = prefs.profile || {};
      prefs.profile.interestAreas = v;
    },
  });
  interests.render();

  for (const k of PROFILE_FIELDS) {
    const el = $('#f-' + k);
    if (!el) continue;
    el.addEventListener('input', scheduleSave);
    el.addEventListener('blur', flushSave);
  }

  // Last line of defense: if the user closes the tab mid-debounce, flush.
  window.addEventListener('beforeunload', () => {
    if (dirty && saveTimer) flushSave();
  });

  // The dossier layout drops the bottom "Save" button (auto-save covers
  // it). Guard for safety in case a stale cached HTML is served.
  $('#save-btn')?.addEventListener('click', flushSave);

  $('#reset-btn').addEventListener('click', async () => {
    prefs = await api('/api/preferences');
    renderProfileFields();
    schools.render();
    interests.render();
    dirty = false;
    setStatus('auto-saves as you type');
  });

  $('#resume-file').addEventListener('change', (e) => {
    if (e.target.files[0]) uploadResume(e.target.files[0]);
    e.target.value = '';
  });

  $('#discover-btn').addEventListener('click', runDiscovery);

  await loadResume();
  setStatus('auto-saves as you type');
}

init().catch((err) => {
  console.error(err);
  setStatus('Failed to load profile: ' + err.message, 'dirty');
});
