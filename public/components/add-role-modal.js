// public/components/add-role-modal.js — modal flow for adding a new role.
//
// Replaces the standalone /paste.html page. The flow is unchanged:
//   1. URL hero — paste a job URL, click Auto-fill, server extracts fields.
//   2. Manual form — revealed by autofill (success or failure) or by the
//      "or, fill in manually" divider. Title/company/location/description +
//      optional "already applied" sub-block.
//   3. Submit — POST to /api/score-paste, fire onAdded so the host page can
//      refresh its data, then close the modal.
//
// Backdrop is its own DOM element, kept separate from modal.js's listing-
// detail backdrop so both can co-exist on the page without state collision.

import { $, $$, api, alertDialog } from '../app.js';

let isOpen = false;
let onAddedCallback = null;
let backdrop = null;

function buildBackdrop() {
  const el = document.createElement('div');
  el.className = 'modal-backdrop add-role-backdrop';
  el.innerHTML = `
    <div class="modal modal-add-role" role="dialog" aria-modal="true" aria-labelledby="ar-title">
      <div class="modal-head">
        <div>
          <div class="modal-title" id="ar-title">Add a role</div>
          <div class="modal-company">Drop in a URL — Claude reads the page and fills the rest. Or enter it manually.</div>
        </div>
        <button class="modal-close" aria-label="Close" type="button">×</button>
      </div>
      <div class="modal-body">
        <section class="result-card" aria-label="Auto-fill from URL">
          <label for="ar-url">Job URL</label>
          <div class="url-row">
            <input type="url" id="ar-url" placeholder="https://example.com/jobs/123" autocomplete="off" spellcheck="false">
            <button type="button" class="btn primary" id="ar-fetch">Auto-fill →</button>
          </div>
          <p class="form-help">
            Works best on greenhouse, lever, and company careers pages.
            LinkedIn and Indeed often block bots — fill manually if it fails.
          </p>
          <p id="ar-fetch-status" class="test-result" hidden></p>
        </section>

        <button type="button" class="manual-divider" id="ar-manual-divider" aria-controls="ar-manual-form" aria-expanded="false">
          or, fill in manually
        </button>

        <form id="ar-manual-form" class="result-card manual-form" hidden>
          <label>Title</label>
          <input type="text" id="ar-title-field" placeholder="e.g. Litigation Paralegal">

          <div class="field-grid">
            <div>
              <label>Company</label>
              <input type="text" id="ar-company" placeholder="e.g. Davis Polk">
            </div>
            <div>
              <label>Location</label>
              <input type="text" id="ar-location" placeholder="e.g. New York, NY">
            </div>
          </div>

          <label>Description</label>
          <textarea id="ar-description" rows="10" placeholder="Paste the full job description here…"></textarea>

          <label class="applied-toggle">
            <input type="checkbox" id="ar-already-applied">
            <span>I've already applied to this</span>
          </label>

          <div id="ar-applied-fields" class="applied-fields" hidden>
            <div class="field-grid">
              <div>
                <label>Outcome</label>
                <select id="ar-app-status">
                  <option value="applied">Applied — waiting</option>
                  <option value="interview">Interview</option>
                  <option value="offer">Offer</option>
                  <option value="rejected">Rejected</option>
                </select>
              </div>
              <div>
                <label>When</label>
                <input type="date" id="ar-app-date">
              </div>
            </div>
            <label>Notes (optional)</label>
            <textarea id="ar-app-note" rows="3" placeholder="Anything worth remembering — referral source, OA date, contact name…"></textarea>
            <p class="applied-help">This will count as a positive example when scoring future listings and discovering new sources.</p>
          </div>

          <button type="button" class="btn primary submit-btn" id="ar-submit">Score it</button>
        </form>
      </div>
    </div>
  `;
  document.body.appendChild(el);

  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  el.querySelector('.modal-close').addEventListener('click', close);

  // Wire form behavior once at construction. Resetting state happens in open().
  wireForm(el);

  return el;
}

function wireForm(root) {
  const urlInput = root.querySelector('#ar-url');
  const fetchBtn = root.querySelector('#ar-fetch');
  const fetchStatus = root.querySelector('#ar-fetch-status');
  const manualForm = root.querySelector('#ar-manual-form');
  const manualDivider = root.querySelector('#ar-manual-divider');
  const alreadyApplied = root.querySelector('#ar-already-applied');
  const appliedFields = root.querySelector('#ar-applied-fields');
  const submitBtn = root.querySelector('#ar-submit');

  function setFetchStatus(text, kind = null) {
    if (!text) {
      fetchStatus.hidden = true;
      fetchStatus.textContent = '';
      fetchStatus.className = 'test-result';
      return;
    }
    fetchStatus.hidden = false;
    fetchStatus.textContent = text;
    fetchStatus.className = 'test-result' + (kind ? ' ' + kind : '');
  }

  function revealForm({ focusTitle = false } = {}) {
    if (!manualForm.hidden) {
      if (focusTitle) root.querySelector('#ar-title-field').focus();
      return;
    }
    manualForm.hidden = false;
    manualDivider.setAttribute('aria-expanded', 'true');
    if (focusTitle) {
      requestAnimationFrame(() => root.querySelector('#ar-title-field').focus());
    }
  }

  function syncAppliedToggle() {
    const on = alreadyApplied.checked;
    appliedFields.hidden = !on;
    submitBtn.textContent = on ? 'Log it' : 'Score it';
  }
  alreadyApplied.addEventListener('change', syncAppliedToggle);

  async function autoFillFromUrl() {
    const url = urlInput.value.trim();
    if (!url) {
      setFetchStatus('Paste a URL into the field first.', 'err');
      urlInput.focus();
      return;
    }
    try { new URL(url); } catch {
      setFetchStatus("That doesn't look like a valid URL.", 'err');
      return;
    }
    fetchBtn.disabled = true;
    fetchBtn.innerHTML = '<span class="spinner sm on-primary"></span> Fetching…';
    setFetchStatus('Fetching the page and extracting fields…');
    try {
      const data = await api('/api/score-paste/extract-from-url', {
        method: 'POST',
        body: { url },
      });
      if (!data.extracted) {
        setFetchStatus(`Couldn't extract — ${data.reason || 'unknown reason'}. Fill in the fields manually below.`, 'err');
        revealForm();
        return;
      }
      if (data.title && !root.querySelector('#ar-title-field').value) root.querySelector('#ar-title-field').value = data.title;
      if (data.company && !root.querySelector('#ar-company').value) root.querySelector('#ar-company').value = data.company;
      if (data.location && !root.querySelector('#ar-location').value) root.querySelector('#ar-location').value = data.location;
      if (data.description && !root.querySelector('#ar-description').value) root.querySelector('#ar-description').value = data.description;
      setFetchStatus('Filled in from the URL — verify and edit before scoring.', 'ok');
      revealForm();
    } catch (err) {
      setFetchStatus(`Couldn't reach that page (${err.message}). Fill in manually.`, 'err');
      revealForm();
    } finally {
      fetchBtn.disabled = false;
      fetchBtn.innerHTML = 'Auto-fill →';
    }
  }

  fetchBtn.addEventListener('click', autoFillFromUrl);
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); autoFillFromUrl(); }
  });
  manualDivider.addEventListener('click', () => revealForm({ focusTitle: true }));

  submitBtn.addEventListener('click', async () => {
    const body = {
      title: root.querySelector('#ar-title-field').value.trim(),
      company: root.querySelector('#ar-company').value.trim(),
      location: root.querySelector('#ar-location').value.trim(),
      url: urlInput.value.trim(),
      description: root.querySelector('#ar-description').value.trim(),
    };
    if (alreadyApplied.checked) {
      body.alreadyApplied = true;
      body.applicationStatus = root.querySelector('#ar-app-status').value;
      body.appliedDate = root.querySelector('#ar-app-date').value || null;
      body.applicationNote = root.querySelector('#ar-app-note').value.trim();
    }
    if (!body.title || !body.description) {
      await alertDialog({ title: 'Missing fields', message: 'Title and description are required.' });
      return;
    }
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner sm on-primary"></span> Scoring…';
    try {
      const data = await api('/api/score-paste', { method: 'POST', body });
      if (data.error) throw new Error(data.error);
      // Hand off to the host page so it can re-fetch listings/stats and let
      // the new row appear in the table. Then close — the user lands back on
      // the roles list with the new entry visible (and any score data
      // already attached, since /api/score-paste runs the scorer inline).
      try { onAddedCallback?.(data); } catch (cbErr) { console.error('onAdded callback failed', cbErr); }
      close();
    } catch (err) {
      await alertDialog({ title: 'Couldn’t save', message: err.message || 'Unknown error.' });
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = alreadyApplied.checked ? 'Log it' : 'Score it';
    }
  });
}

function resetForm(root) {
  root.querySelector('#ar-url').value = '';
  root.querySelector('#ar-title-field').value = '';
  root.querySelector('#ar-company').value = '';
  root.querySelector('#ar-location').value = '';
  root.querySelector('#ar-description').value = '';
  root.querySelector('#ar-already-applied').checked = false;
  root.querySelector('#ar-app-status').value = 'applied';
  root.querySelector('#ar-app-date').value = new Date().toISOString().slice(0, 10);
  root.querySelector('#ar-app-note').value = '';
  root.querySelector('#ar-applied-fields').hidden = true;
  root.querySelector('#ar-manual-form').hidden = true;
  root.querySelector('#ar-manual-divider').setAttribute('aria-expanded', 'false');
  const fs = root.querySelector('#ar-fetch-status');
  fs.hidden = true; fs.textContent = ''; fs.className = 'test-result';
  const submit = root.querySelector('#ar-submit');
  submit.textContent = 'Score it';
  submit.disabled = false;
  const fetchBtn = root.querySelector('#ar-fetch');
  fetchBtn.disabled = false;
  fetchBtn.innerHTML = 'Auto-fill →';
}

function close() {
  if (!isOpen || !backdrop) return;
  backdrop.classList.remove('open');
  document.body.style.overflow = '';
  isOpen = false;
  onAddedCallback = null;
}

// One-time Escape handler — bound on first open() instead of at module load
// so we don't add a listener until the user actually opens the modal.
let escBound = false;
function bindEscOnce() {
  if (escBound) return;
  escBound = true;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) close();
  });
}

export function openAddRoleModal({ onAdded } = {}) {
  if (!backdrop) backdrop = buildBackdrop();
  bindEscOnce();
  resetForm(backdrop);
  onAddedCallback = onAdded || null;
  backdrop.classList.add('open');
  document.body.style.overflow = 'hidden';
  isOpen = true;
  // Focus the URL field once the slide-up transform has started, so the
  // virtual keyboard (mobile) doesn't fight the modal's entrance animation.
  requestAnimationFrame(() => backdrop.querySelector('#ar-url').focus());
}
