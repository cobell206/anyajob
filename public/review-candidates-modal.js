// public/review-candidates-modal.js — surfaced from the roles page so
// pending source candidates can be reviewed without navigating to settings.
//
// Mirrors the settings-page "Pending review" zone:
//   - GET /api/discoveries on open
//   - renderCandidateCard() for each pending candidate (shared via candidates.js)
//   - approve → POST /api/discoveries/:id/approve
//   - dismiss → POST /api/discoveries/:id/dismiss
//   - auto-closes when the count hits zero
//   - fires onChange after each action so the host page can update the pill
//
// Backdrop is owned by this module, kept separate from modal.js (listing
// detail) and add-role-modal.js (paste flow) so all three can coexist.

import { $, $$, api, alertDialog } from './app.js';
import { renderCandidateCard } from './candidates.js';

let isOpen = false;
let onChangeCallback = null;
let backdrop = null;
let pending = [];
let lastSummary = null;

function buildBackdrop() {
  const el = document.createElement('div');
  el.className = 'modal-backdrop review-candidates-backdrop';
  el.innerHTML = `
    <div class="modal modal-add-role modal-review-candidates" role="dialog" aria-modal="true" aria-labelledby="rc-title">
      <div class="modal-head">
        <div>
          <div class="modal-title" id="rc-title">Review pending sources</div>
          <div class="modal-company" id="rc-sub"></div>
        </div>
        <button class="modal-close" aria-label="Close" type="button">×</button>
      </div>
      <div class="modal-body">
        <div id="rc-summary" class="pending-caption" hidden></div>
        <div id="rc-list" class="rc-list"></div>
        <div id="rc-empty" class="rc-empty" hidden>
          <p>Nothing pending right now. New candidates appear here after the next discovery run.</p>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(el);

  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  el.querySelector('.modal-close').addEventListener('click', close);
  return el;
}

let escBound = false;
function bindEscOnce() {
  if (escBound) return;
  escBound = true;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) close();
  });
}

function close() {
  if (!isOpen || !backdrop) return;
  backdrop.classList.remove('open');
  document.body.style.overflow = '';
  isOpen = false;
}

function renderList() {
  const list = $('#rc-list', backdrop);
  const empty = $('#rc-empty', backdrop);
  const summaryEl = $('#rc-summary', backdrop);
  const sub = $('#rc-sub', backdrop);

  if (pending.length === 0) {
    list.innerHTML = '';
    list.hidden = true;
    summaryEl.hidden = true;
    empty.hidden = false;
    sub.textContent = 'All caught up.';
    return;
  }

  list.hidden = false;
  empty.hidden = true;
  sub.textContent = `${pending.length} ${pending.length === 1 ? 'candidate' : 'candidates'} waiting on you.`;

  if (lastSummary) {
    summaryEl.hidden = false;
    summaryEl.innerHTML = `<p class="pending-caption-summary">${escapeForHtml(lastSummary)}</p>`;
  } else {
    summaryEl.hidden = true;
  }

  list.innerHTML = pending.map((c) => renderCandidateCard(c, {
    dataAttr: ` data-cand-id="${c.id}"`,
    actionsHtml: `
      <button class="btn primary" data-approve-id="${c.id}">Add to sources</button>
      <button class="btn ghost" data-dismiss-id="${c.id}">Dismiss</button>
    `,
  })).join('');

  wireRowActions();
}

// Lightweight local escaper — only used for the lastSummary string from the
// API. The shared renderCandidateCard handles escaping for everything inside
// the card itself.
function escapeForHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function wireRowActions() {
  $$('[data-approve-id]', backdrop).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.approveId;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner sm on-primary"></span>';
      try {
        await api('/api/discoveries/' + id + '/approve', { method: 'POST', body: {} });
        // Drop from local list, re-render, notify host, auto-close if empty.
        pending = pending.filter((c) => c.id !== id);
        renderList();
        onChangeCallback?.({ pendingCount: pending.length });
        if (pending.length === 0) setTimeout(close, 600);
      } catch (err) {
        await alertDialog({ title: 'Couldn’t add source', message: err.message });
        btn.disabled = false;
        btn.textContent = 'Add to sources';
      }
    });
  });

  $$('[data-dismiss-id]', backdrop).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.dismissId;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner sm"></span>';
      try {
        await api('/api/discoveries/' + id + '/dismiss', { method: 'POST', body: {} });
        pending = pending.filter((c) => c.id !== id);
        renderList();
        onChangeCallback?.({ pendingCount: pending.length });
        if (pending.length === 0) setTimeout(close, 600);
      } catch (err) {
        await alertDialog({ title: 'Couldn’t dismiss', message: err.message });
        btn.disabled = false;
        btn.textContent = 'Dismiss';
      }
    });
  });
}

async function fetchAndRender() {
  const list = $('#rc-list', backdrop);
  list.innerHTML = '<div class="rc-loading"><span class="spinner sm"></span> Loading…</div>';
  try {
    const data = await api('/api/discoveries');
    pending = data.pending || [];
    lastSummary = data.lastSummary || null;
    renderList();
  } catch (err) {
    list.innerHTML = `<p class="rc-error">Couldn’t load pending candidates: ${escapeForHtml(err.message)}</p>`;
  }
}

export function openReviewCandidatesModal({ onChange } = {}) {
  if (!backdrop) backdrop = buildBackdrop();
  bindEscOnce();
  onChangeCallback = onChange || null;
  backdrop.classList.add('open');
  document.body.style.overflow = 'hidden';
  isOpen = true;
  fetchAndRender();
}
