// public/modal.js — reusable detail modal for a listing

import { $, $$, escapeHtml, api, fmtSalary, fmtDateLong, scoreClass, STATUSES, SVG_THUMB_UP, SVG_THUMB_DOWN } from './app.js';
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
            <button class="btn btn-vote up ${listing.rating === 'up' ? 'active' : ''}" data-rate="up" aria-label="Like this listing">${SVG_THUMB_UP}</button>
            <button class="btn btn-vote down ${listing.rating === 'down' ? 'active' : ''}" data-rate="down" aria-label="Dislike this listing">${SVG_THUMB_DOWN}</button>
            ${listing.url ? `<a class="btn primary" href="${escapeHtml(listing.url)}" target="_blank" rel="noopener">Open original ↗</a>` : ''}
          </div>

          <label>Status</label>
          <select id="m-status">
            ${STATUSES.map((s) => `<option value="${s.value}" ${s.value === listing.status ? 'selected' : ''}>${s.pickerLabel || s.label}</option>`).join('')}
          </select>

          <div id="m-reject-reasons" class="reject-reasons" hidden>
            <p class="reject-reasons-label">Why ignore? (optional)</p>
            <div class="reject-reasons-chips">
              <button type="button" class="reason-chip" data-reason="not-a-fit">Not a fit</button>
              <button type="button" class="reason-chip" data-reason="salary">Salary too low</button>
              <button type="button" class="reason-chip" data-reason="location">Location</button>
              <button type="button" class="reason-chip" data-reason="too-senior">Too senior</button>
              <button type="button" class="reason-chip" data-reason="too-junior">Too junior</button>
              <button type="button" class="reason-chip" data-reason="already-applied">Already applied</button>
              <button type="button" class="reason-chip" data-reason="other">Other…</button>
            </div>
            <input type="text" id="m-reject-note" class="reject-note-input" placeholder="Tell me more…" hidden>
          </div>

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

  // Rate / status / dates / note are toggle-like state indicators — they
  // should feel instantaneous. Apply the visual change immediately, fire the
  // API in the background, and revert only if the request fails.
  $$('[data-rate]', $('#m-body')).forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.rate;
      const newRating = btn.classList.contains('active') ? null : action;
      const previousRating = currentListing.rating;
      const rateBtns = $$('[data-rate]', $('#m-body'));

      const apply = (rating) => {
        rateBtns.forEach((b) => b.classList.toggle('active', rating && b.dataset.rate === rating));
        currentListing.rating = rating;
      };
      apply(newRating);
      onUpdateCallback?.(currentListing);

      api(`/api/feedback/${fp}/rating`, { method: 'POST', body: { rating: newRating } })
        .catch((err) => {
          apply(previousRating);
          onUpdateCallback?.(currentListing);
          showMsg(`Failed to save: ${err.message}`, 'error');
        });
    });
  });

  const rejectReasonsEl = $('#m-reject-reasons');
  const rejectNoteEl = $('#m-reject-note');

  function syncRejectReasonsVisibility(status) {
    if (status === 'rejected') {
      rejectReasonsEl.hidden = false;
      preselectReasonChip(currentListing.rejectReason, currentListing.rejectNote);
    } else {
      rejectReasonsEl.hidden = true;
    }
  }

  function preselectReasonChip(reason, note) {
    $$('.reason-chip', rejectReasonsEl).forEach((c) => {
      c.classList.toggle('is-selected', !!reason && c.dataset.reason === reason);
    });
    if (reason === 'other') {
      rejectNoteEl.hidden = false;
      rejectNoteEl.value = note || '';
    } else {
      rejectNoteEl.hidden = true;
      rejectNoteEl.value = '';
    }
  }

  function saveRejectReason() {
    const selected = rejectReasonsEl.querySelector('.reason-chip.is-selected');
    const reason = selected ? selected.dataset.reason : null;
    const note = reason === 'other' ? (rejectNoteEl.value || '') : '';
    currentListing.rejectReason = reason;
    currentListing.rejectNote = note || null;
    onUpdateCallback?.(currentListing);

    api(`/api/feedback/${fp}/reject-reason`, { method: 'POST', body: { reason, note } })
      .catch((err) => {
        showMsg(`Failed to save: ${err.message}`, 'error');
      });
  }

  $$('.reason-chip', rejectReasonsEl).forEach((chip) => {
    chip.addEventListener('click', () => {
      const wasSelected = chip.classList.contains('is-selected');
      $$('.reason-chip', rejectReasonsEl).forEach((c) => c.classList.remove('is-selected'));
      if (!wasSelected) chip.classList.add('is-selected');
      const isOther = !wasSelected && chip.dataset.reason === 'other';
      rejectNoteEl.hidden = !isOther;
      if (!isOther) rejectNoteEl.value = '';
      if (isOther) {
        rejectNoteEl.focus();
      } else {
        saveRejectReason();
      }
    });
  });

  rejectNoteEl.addEventListener('blur', () => {
    if (rejectReasonsEl.querySelector('.reason-chip.is-selected[data-reason="other"]')) {
      saveRejectReason();
    }
  });

  $('#m-status').addEventListener('change', (e) => {
    const status = e.target.value;
    const prev = currentListing.status;
    currentListing.status = status;
    if (status === 'applied' && !currentListing.appliedDate) {
      const today = new Date().toISOString().slice(0, 10);
      currentListing.appliedDate = today;
      $('#m-applied-date').value = today;
    }
    syncRejectReasonsVisibility(status);
    onUpdateCallback?.(currentListing);

    api(`/api/feedback/${fp}/status`, { method: 'POST', body: { status } })
      .catch((err) => {
        e.target.value = prev || 'new';
        currentListing.status = prev;
        syncRejectReasonsVisibility(prev);
        onUpdateCallback?.(currentListing);
        showMsg(`Failed to save: ${err.message}`, 'error');
      });
  });

  syncRejectReasonsVisibility(listing.status);

  $('#m-applied-date').addEventListener('change', (e) => {
    const date = e.target.value || null;
    const prev = currentListing.appliedDate;
    currentListing.appliedDate = date;
    onUpdateCallback?.(currentListing);

    api(`/api/feedback/${fp}/appliedDate`, { method: 'POST', body: { appliedDate: date } })
      .catch((err) => {
        currentListing.appliedDate = prev;
        e.target.value = prev || '';
        onUpdateCallback?.(currentListing);
        showMsg(`Failed to save: ${err.message}`, 'error');
      });
  });

  $('#m-closes-date').addEventListener('change', (e) => {
    const date = e.target.value || null;
    const prev = currentListing.closesDate;
    currentListing.closesDate = date;
    onUpdateCallback?.(currentListing);

    api(`/api/feedback/${fp}/closesDate`, { method: 'POST', body: { closesDate: date } })
      .catch((err) => {
        currentListing.closesDate = prev;
        e.target.value = prev || '';
        onUpdateCallback?.(currentListing);
        showMsg(`Failed to save: ${err.message}`, 'error');
      });
  });

  let noteTimer;
  $('#m-note').addEventListener('input', (e) => {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      const value = e.target.value;
      const prev = currentListing.note;
      currentListing.note = value;
      onUpdateCallback?.(currentListing);

      api(`/api/feedback/${fp}/note`, { method: 'POST', body: { note: value } })
        .catch((err) => {
          currentListing.note = prev;
          showMsg(`Failed to save: ${err.message}`, 'error');
        });
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
      <div class="docs-loading"><span class="spinner-row"><span class="spinner sm"></span><span>Loading…</span></span></div>
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
