// public/modal.js — reusable detail modal for a listing

import { $, $$, escapeHtml, api, fmtSalary, fmtDateLong, scoreClass, STATUSES } from './app.js';
import { renderDocumentsSection, wireDocumentActions } from './documents.js';

let currentListing = null;
let onUpdateCallback = null;

const backdrop = document.createElement('div');
backdrop.className = 'modal-backdrop';
backdrop.innerHTML = `
  <div class="modal" role="dialog" aria-modal="true">
    <div class="modal-head">
      <div>
        <div class="modal-title" id="m-title"></div>
        <div class="modal-company" id="m-company"></div>
      </div>
      <button class="modal-close" aria-label="Close">×</button>
    </div>
    <div class="modal-body" id="m-body"></div>
  </div>
`;
document.body.appendChild(backdrop);

backdrop.addEventListener('click', (e) => {
  if (e.target === backdrop) close();
});
backdrop.querySelector('.modal-close').addEventListener('click', close);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && backdrop.classList.contains('open')) close();
});

function close() {
  backdrop.classList.remove('open');
  document.body.style.overflow = '';
  currentListing = null;
}

export function openModal(listing, onUpdate) {
  currentListing = listing;
  onUpdateCallback = onUpdate;

  const s = listing.score || {};
  $('#m-title').textContent = listing.title;
  $('#m-company').textContent = `${listing.company}${listing.location ? ' · ' + listing.location : ''}`;

  const overall = s.overallScore ?? 0;
  const qual = s.qualificationFit ?? 0;
  const lsv = s.lawSchoolValue ?? 0;

  $('#m-body').innerHTML = `
    <div class="modal-section">
      <div class="modal-grid">
        <div class="modal-stat">
          <div class="modal-stat-label">Score</div>
          <div class="modal-stat-value" style="color: var(--${overall >= 8 ? 'green' : 'blue'}-ink)">${overall}/10</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">Qualification fit</div>
          <div class="modal-stat-value">${qual}/10</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">Law school value</div>
          <div class="modal-stat-value">${lsv}/10</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">Salary</div>
          <div class="modal-stat-value">${fmtSalary(s.salaryMin, s.salaryMax)}</div>
        </div>
      </div>
    </div>

    ${s.rationale ? `
      <div class="modal-section">
        <h3>Why this score</h3>
        <div class="rationale-box">${escapeHtml(s.rationale)}</div>
      </div>
    ` : ''}

    <div class="modal-cols">
      <div class="modal-col-left">
        ${s.strengths?.length ? `
          <div class="modal-section">
            <h3>Strengths</h3>
            <ul class="bullet-list">${s.strengths.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
          </div>
        ` : ''}

        ${s.concerns?.length ? `
          <div class="modal-section">
            <h3>Concerns</h3>
            <ul class="bullet-list concerns">${s.concerns.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
          </div>
        ` : ''}

        ${s.applicationAngle ? `
          <div class="modal-section">
            <h3>Personal statement angle</h3>
            <p style="font-size:14px; color: var(--ink-2); line-height: 1.55">${escapeHtml(s.applicationAngle)}</p>
          </div>
        ` : ''}
      </div>

      <div class="modal-col-right">
        <div class="modal-section">
          <h3>Your decision</h3>
          <div class="btn-row" style="margin-bottom: 8px">
            <button class="btn btn-vote up ${listing.rating === 'up' ? 'active' : ''}" data-rate="up">👍</button>
            <button class="btn btn-vote down ${listing.rating === 'down' ? 'active' : ''}" data-rate="down">👎</button>
            ${listing.url ? `<a class="btn primary" href="${escapeHtml(listing.url)}" target="_blank" rel="noopener">Open original ↗</a>` : ''}
          </div>

          <label>Status</label>
          <select id="m-status">
            ${STATUSES.map((s) => `<option value="${s.value}" ${s.value === listing.status ? 'selected' : ''}>${s.pickerLabel || s.label}</option>`).join('')}
          </select>

          <div class="field-grid">
            <div>
              <label>Applied date</label>
              <input type="date" id="m-applied-date" value="${listing.appliedDate || ''}">
            </div>
            <div>
              <label>Closes date</label>
              <input type="date" id="m-closes-date" value="${listing.closesDate || ''}">
            </div>
          </div>

          <label>Notes</label>
          <textarea id="m-note" placeholder="Application status, follow-ups, contacts…">${escapeHtml(listing.note || '')}</textarea>

          <div class="status-message" id="m-status-msg"></div>
        </div>

        <div id="m-docs-mount"></div>
      </div>
    </div>

    <hr class="modal-footer-divider">

    <div class="modal-section modal-meta">
      <div class="modal-meta-grid">
        <div><span class="modal-meta-label">Source</span> ${escapeHtml(listing.source || '—')}</div>
        <div><span class="modal-meta-label">Posted</span> ${fmtDateLong(listing.postedAt)}</div>
        <div><span class="modal-meta-label">Ingested</span> ${fmtDateLong(listing.ingestedAt)}</div>
        ${s.workMode ? `<div><span class="modal-meta-label">Work mode</span> ${escapeHtml(s.workMode)}</div>` : ''}
      </div>
    </div>
  `;

  // Wire up handlers.
  // dedupKey is per-listing (used for feedback — distinct openings have
  // distinct dedupKeys). fingerprint is per-role (used for documents — the
  // same role across reposts shares uploads).
  const fp = listing.dedupKey || listing.fingerprint;
  const docFp = listing.fingerprint;
  const showMsg = (text, kind = 'success') => {
    const el = $('#m-status-msg');
    el.textContent = text;
    el.className = `status-message ${kind}`;
    setTimeout(() => { el.textContent = ''; }, 1500);
  };

  $$('[data-rate]', $('#m-body')).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.rate;
      const newRating = btn.classList.contains('active') ? null : action;
      await api(`/api/feedback/${fp}/rating`, {
        method: 'POST',
        body: { rating: newRating },
      });
      $$('[data-rate]', $('#m-body')).forEach((b) => b.classList.remove('active'));
      if (newRating) btn.classList.add('active');
      currentListing.rating = newRating;
      showMsg(newRating ? 'Saved' : 'Cleared');
      onUpdateCallback?.(currentListing);
    });
  });

  $('#m-status').addEventListener('change', async (e) => {
    const status = e.target.value;
    const prev = currentListing.status;
    try {
      await api(`/api/feedback/${fp}/status`, { method: 'POST', body: { status } });
      currentListing.status = status;
      if (status === 'applied' && !currentListing.appliedDate) {
        const today = new Date().toISOString().slice(0, 10);
        currentListing.appliedDate = today;
        $('#m-applied-date').value = today;
      }
      showMsg('Saved');
      onUpdateCallback?.(currentListing);
    } catch (err) {
      e.target.value = prev || 'new';
      showMsg(`Failed to save: ${err.message}`, 'error');
    }
  });

  $('#m-applied-date').addEventListener('change', async (e) => {
    const date = e.target.value || null;
    await api(`/api/feedback/${fp}/appliedDate`, { method: 'POST', body: { appliedDate: date } });
    currentListing.appliedDate = date;
    showMsg('Applied date saved');
    onUpdateCallback?.(currentListing);
  });

  $('#m-closes-date').addEventListener('change', async (e) => {
    const date = e.target.value || null;
    await api(`/api/feedback/${fp}/closesDate`, { method: 'POST', body: { closesDate: date } });
    currentListing.closesDate = date;
    showMsg('Closes date saved');
    onUpdateCallback?.(currentListing);
  });

  let noteTimer;
  $('#m-note').addEventListener('input', (e) => {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(async () => {
      await api(`/api/feedback/${fp}/note`, { method: 'POST', body: { note: e.target.value } });
      currentListing.note = e.target.value;
      showMsg('Saved');
      onUpdateCallback?.(currentListing);
    }, 500);
  });

  backdrop.classList.add('open');
  document.body.style.overflow = 'hidden';

  // Async-load the documents section so the modal opens instantly.
  // Documents are keyed by role fingerprint, not the per-listing dedupKey.
  loadDocs(docFp);
}

async function loadDocs(fp) {
  const mount = $('#m-docs-mount');
  if (!mount) return;
  mount.innerHTML = `
    <div class="modal-section docs-section">
      <h3>Application materials</h3>
      <div class="docs-loading">Loading…</div>
    </div>
  `;
  try {
    const html = await renderDocumentsSection(fp);
    mount.innerHTML = html;
    wireDocumentActions(mount, fp, () => loadDocs(fp));
  } catch (err) {
    mount.innerHTML = `
      <div class="modal-section docs-section">
        <h3>Application materials</h3>
        <div class="docs-status error">Failed to load: ${err.message}</div>
      </div>
    `;
  }
}
