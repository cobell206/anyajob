// public/profile.js — drives the profile page

import { $, $$, escapeHtml, api, fmtDateLong } from './app.js';

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
    root.innerHTML = `
      <div class="resume-dropzone" id="resume-drop">
        <div><strong>Drop your resume here</strong> or click to choose</div>
        <div style="margin-top:6px;font-size:12px">PDF, DOCX, DOC, or TXT — up to 5MB</div>
      </div>
    `;
    wireDropzone();
    return;
  }
  const sizeKb = Math.round((meta.sizeBytes || 0) / 1024);
  root.innerHTML = `
    <div class="resume-current">
      <div class="resume-current-info">
        <div class="resume-current-name">${escapeHtml(meta.originalName || meta.file)}</div>
        <div class="resume-current-meta">Uploaded ${fmtDateLong(meta.uploadedAt)} · ${sizeKb} KB</div>
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
  root.innerHTML = '<div style="padding:14px;color:var(--muted)">Uploading…</div>';
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch('/api/profile/resume', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'upload failed');
    renderResume(data.resume);
  } catch (err) {
    alert('Upload failed: ' + err.message);
    await loadResume();
  }
}

async function removeResume() {
  if (!confirm('Remove your resume? Scoring and discovery will fall back to the structured profile only.')) return;
  await fetch('/api/profile/resume', { method: 'DELETE' });
  await loadResume();
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
}

function markDirty() {
  if (!dirty) {
    dirty = true;
    setStatus('Unsaved changes', 'dirty');
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
  $('#save-btn').disabled = true;
  setStatus('Saving…');
  try {
    await api('/api/preferences', { method: 'POST', body: updated });
    prefs = updated;
    dirty = false;
    setStatus('Saved', 'saved');
    setTimeout(() => { if (!dirty) setStatus(''); }, 1500);
  } catch (err) {
    setStatus('Save failed: ' + err.message, 'dirty');
  } finally {
    $('#save-btn').disabled = false;
  }
}

// ---------- Discovery ----------

async function runDiscovery() {
  const btn = $('#discover-btn');
  const out = $('#discovery-results');
  btn.disabled = true;
  btn.textContent = 'Searching the web…';
  out.innerHTML = '<div style="padding:12px;color:var(--muted)">This usually takes 20–40 seconds.</div>';
  try {
    const data = await api('/api/sources/discover', { method: 'POST', body: { maxCandidates: 12 } });
    const candidates = data.candidates || [];
    if (!candidates.length) {
      out.innerHTML = '<div style="padding:12px;color:var(--muted)">No new candidates found. The model didn\'t see anything beyond what you\'re already tracking.</div>';
      return;
    }
    out.innerHTML = `
      <div style="font-size:13px;color:var(--muted);margin-bottom:8px">
        ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} found.
        Approve or dismiss them on the <a href="/settings.html#discoveries" style="color:var(--blue-ink)">Settings page</a>.
      </div>
      ${candidates.map((c) => `
        <div class="discovery-result">
          <div>
            <span class="discovery-result-name">${escapeHtml(c.name || c.kind)}</span>
            <span class="discovery-result-kind">${escapeHtml(c.kind || '')}</span>
          </div>
          ${c.rationale ? `<div class="discovery-result-rationale">${escapeHtml(c.rationale)}</div>` : ''}
          ${c.config?.url || c.config?.slug ? `<div class="discovery-result-meta">${escapeHtml(c.config?.url || c.config?.slug)}</div>` : ''}
        </div>
      `).join('')}
    `;
  } catch (err) {
    out.innerHTML = `<div style="padding:12px;color:var(--bad)">Discovery failed: ${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Find sources';
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

  $('#save-btn').addEventListener('click', flushSave);
  $('#reset-btn').addEventListener('click', async () => {
    prefs = await api('/api/preferences');
    renderProfileFields();
    schools.render();
    interests.render();
    dirty = false;
    setStatus('');
  });

  $('#resume-file').addEventListener('change', (e) => {
    if (e.target.files[0]) uploadResume(e.target.files[0]);
    e.target.value = '';
  });

  $('#discover-btn').addEventListener('click', runDiscovery);

  await loadResume();
  setStatus('');
}

init().catch((err) => {
  console.error(err);
  setStatus('Failed to load profile: ' + err.message, 'dirty');
});
