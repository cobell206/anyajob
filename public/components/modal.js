// public/components/modal.js — reusable detail modal for a listing

import { $, $$, escapeHtml, api, fmtSalary, fmtDateLong, scoreClass, STATUSES, SVG_THUMB_UP, SVG_THUMB_DOWN } from '../app.js';
import { renderDocumentsSection, wireDocumentActions } from './documents.js';

let currentListing = null;
let onUpdateCallback = null;

// When did the scoring config (goals + weighting) last change? A listing scored
// before this was scored under older intent — the modal offers a re-score and
// shows a subtle hint. Loaded once and cached; refreshed after a re-score.
let scoringConfigUpdatedAt = null;
let scoringConfigLoaded = false;
async function ensureScoringConfig() {
  if (scoringConfigLoaded) return;
  try {
    const p = await api('/api/preferences');
    scoringConfigUpdatedAt = p?.scoringConfigUpdatedAt || null;
  } catch { /* non-fatal: no hint, button still works */ }
  scoringConfigLoaded = true;
}
ensureScoringConfig(); // warm the cache at module load

// A score is "stale" when it was produced before the last goals/weighting edit.
function scoreIsStale(score) {
  return !!(scoringConfigUpdatedAt && score?._scoredAt && score._scoredAt < scoringConfigUpdatedAt);
}

// Lucide-style external-link icon. 18px stroked, no fill — matches the
// rest of the app's icon vocabulary. Sits inline after the title.
const SVG_OPEN_EXTERNAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
// Refresh / re-score icon — stroked, matches the icon vocabulary.
const SVG_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>';

const backdrop = document.createElement('div');
backdrop.className = 'modal-backdrop';
backdrop.innerHTML = `
  <div class="modal" role="dialog" aria-modal="true">
    <div class="modal-head">
      <div class="modal-head-titles">
        <div class="modal-title-row">
          <div class="modal-title" id="m-title"></div>
          <a class="modal-open-link" id="m-open-link" href="#" target="_blank" rel="noopener" aria-label="Open original posting" title="Open original posting" hidden>${SVG_OPEN_EXTERNAL}</a>
        </div>
        <div class="modal-company" id="m-company"></div>
      </div>
      <div class="modal-head-actions">
        <button class="modal-vote up" id="m-vote-up" data-rate="up" aria-label="Like this listing">${SVG_THUMB_UP}</button>
        <button class="modal-vote down" id="m-vote-down" data-rate="down" aria-label="Dislike this listing">${SVG_THUMB_DOWN}</button>
        <button class="modal-close" aria-label="Close">×</button>
      </div>
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
  // Defensive: if the inline doc preview was open when the modal closed,
  // clear its state so the next opened listing doesn't inherit the
  // hide-non-preview mode. The class lives on .modal which is persistent
  // across opens (built once at module load).
  backdrop.querySelector('.modal')?.classList.remove('has-preview-open');
  currentListing = null;
}

export function openModal(listing, onUpdate) {
  currentListing = listing;
  onUpdateCallback = onUpdate;

  const s = listing.score || {};
  $('#m-title').textContent = listing.title;
  $('#m-company').textContent = `${listing.company}${listing.location ? ' · ' + listing.location : ''}`;

  // Open-original link in the header — only shown when we have a URL.
  const openLink = $('#m-open-link');
  if (listing.url) {
    openLink.href = listing.url;
    openLink.hidden = false;
  } else {
    openLink.removeAttribute('href');
    openLink.hidden = true;
  }

  // Thumbs up/down live in the modal head now — apply active class
  // based on the listing's saved rating. The click handler below
  // queries against `backdrop` so it picks these up regardless of
  // where they sit in the DOM.
  $('#m-vote-up').classList.toggle('active', listing.rating === 'up');
  $('#m-vote-down').classList.toggle('active', listing.rating === 'down');

  const overall = s.overallScore ?? 0;
  const qual = s.qualificationFit ?? 0;
  const lsv = s.lawSchoolValue ?? 0;
  // Qualitative summary tag under the overall score — gives the number
  // semantic context and adds a little vertical anchor so the score
  // block balances visually against the taller decision column.
  const scoreLabel = overall >= 8 ? 'High fit'
                   : overall >= 6 ? 'Solid fit'
                   : overall >= 4 ? 'Some fit'
                   : 'Low fit';

  $('#m-body').innerHTML = `
    <!-- Top summary row: scores on the left (compact card),
         status/dates/notes on the right (working area). The two
         "above-the-fold" surfaces of the modal — read + write. -->
    <div class="modal-summary-row">
      <div class="modal-score-block ${scoreClass(overall)}">
        <div class="modal-score-overall">
          <span class="modal-score-num">${overall}</span>
          <span class="modal-score-denom">/10</span>
        </div>
        <div class="modal-score-tag">${scoreLabel}</div>
        <div class="modal-score-divider"></div>
        <ul class="modal-score-stats">
          <li>
            <span class="modal-score-stat-label">Qualification fit</span>
            <span class="modal-score-stat-value">${qual}/10</span>
          </li>
          <li>
            <span class="modal-score-stat-label">Law school value</span>
            <span class="modal-score-stat-value">${lsv}/10</span>
          </li>
          <li>
            <span class="modal-score-stat-label">Salary</span>
            <span class="modal-score-stat-value">${fmtSalary(s.salaryMin, s.salaryMax)}</span>
          </li>
        </ul>
        ${s.overallScore != null ? `
        <div class="modal-score-rescore">
          <p class="modal-score-stale" id="m-score-stale" ${scoreIsStale(s) ? '' : 'hidden'}>Scored under older goals</p>
          <button type="button" class="modal-rescore-btn" id="m-rescore" title="Re-score with current goals & weighting">${SVG_REFRESH}<span>Re-score</span></button>
        </div>
        ` : ''}
      </div>

      <div class="modal-decision modal-section">
        <!-- Status + both dates share one 3-col row — status is a short
             dropdown and the dates are narrow inputs, so they all fit
             comfortably side-by-side. Mobile collapses to single column. -->
        <div class="field-grid cols-3">
          <div>
            <label for="m-status">Status</label>
            <select id="m-status">
              ${STATUSES.map((s) => `<option value="${s.value}" ${s.value === listing.status ? 'selected' : ''}>${s.pickerLabel || s.label}</option>`).join('')}
            </select>
          </div>
          <div>
            <label for="m-applied-date">Applied</label>
            <input type="date" id="m-applied-date" value="${listing.appliedDate || ''}">
          </div>
          <div>
            <label for="m-closes-date">Closes</label>
            <input type="date" id="m-closes-date" value="${listing.closesDate || ''}">
          </div>
        </div>

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

        <label for="m-note">Notes</label>
        <textarea id="m-note" placeholder="Application status, follow-ups, contacts…">${escapeHtml(listing.note || '')}</textarea>

        <div class="status-message" id="m-status-msg"></div>
      </div>
    </div>

    ${s.rationale ? `
      <div class="modal-section">
        <h3>Why this score</h3>
        <div class="rationale-box">${escapeHtml(s.rationale)}</div>
      </div>
    ` : ''}

    <!-- Analysis row: strengths, concerns, and personal-statement angle
         each get a column in one three-up row. -->
    <div class="modal-analysis">
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

    <!-- Application materials — full-width block that splits internally
         into a résumé column and a cover-letter column. -->
    <div id="m-docs-mount"></div>

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
  // API in the background, and revert only if the request fails. The thumbs
  // live in modal-head now (not #m-body), so we scope queries to `backdrop`
  // — that container holds both the head and the body.
  $$('[data-rate]', backdrop).forEach((btn) => {
    // openModal re-runs every time the modal opens; the static thumb buttons
    // need fresh listeners only on the first open. Use a once-per-button flag
    // via dataset so re-binding doesn't stack handlers.
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      if (!currentListing) return;
      const action = btn.dataset.rate;
      const newRating = btn.classList.contains('active') ? null : action;
      const previousRating = currentListing.rating;
      const rateBtns = $$('[data-rate]', backdrop);

      const apply = (rating) => {
        rateBtns.forEach((b) => b.classList.toggle('active', rating && b.dataset.rate === rating));
        currentListing.rating = rating;
      };
      apply(newRating);
      onUpdateCallback?.(currentListing);

      const ratingFp = currentListing.dedupKey || currentListing.fingerprint;
      api(`/api/feedback/${ratingFp}/rating`, { method: 'POST', body: { rating: newRating } })
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

  // Re-score this one listing with the current goals + weighting. Reuses the
  // same scoreOne path as the daily scrape, then re-renders the modal (and the
  // roles table via onUpdate) with the fresh score.
  $('#m-rescore')?.addEventListener('click', async () => {
    if (!currentListing) return;
    const btn = $('#m-rescore');
    const key = currentListing.dedupKey || currentListing.fingerprint;
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner sm"></span><span>Re-scoring…</span>';
    try {
      const { listing: updated } = await api(
        `/api/listings/${encodeURIComponent(key)}/rescore`, { method: 'POST' },
      );
      Object.assign(currentListing, updated);
      onUpdateCallback?.(currentListing);
      openModal(currentListing, onUpdateCallback); // full re-render with new score
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = orig;
      // scoreOne throws on the daily spend cap; surface whatever it says.
      showMsg(`Re-score failed: ${err.message}`, 'error');
    }
  });

  // The stale hint depends on the scoring-config timestamp, which may still be
  // loading on the very first modal open. Refresh it once the cache resolves.
  ensureScoringConfig().then(() => {
    if (currentListing !== listing) return; // modal moved on
    const stale = $('#m-score-stale');
    if (stale) stale.hidden = !scoreIsStale(listing.score || {});
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
