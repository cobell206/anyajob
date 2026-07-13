// public/app.js — shared utilities

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function fmtSalary(min, max) {
  if (!min && !max) return '—';
  const fmt = (n) => `$${Math.round(n / 1000)}k`;
  if (min && max && min !== max) return `${fmt(min)}–${fmt(max)}`;
  return fmt(min || max);
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function fmtDateLong(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function scoreClass(score) {
  if (score >= 8) return 'high';
  if (score >= 6) return 'mid';
  return 'low';
}

// Reduced-motion-aware helpers. CSS handles transitions/animations via a
// global @media (prefers-reduced-motion: reduce) catch-all in style.css,
// but JS-driven smooth scrolling (scrollIntoView's {behavior:'smooth'})
// isn't governed by CSS scroll-behavior — it has to be opted out in JS.
export function prefersReducedMotion() {
  return typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
export function scrollToEl(el, { block = 'center' } = {}) {
  if (!el) return;
  el.scrollIntoView({
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    block,
  });
}

export const STATUSES = [
  { value: 'new', label: 'New' },
  { value: 'saved', label: 'Saved' },
  { value: 'applied', label: 'Applied' },
  { value: 'interview', label: 'Interview' },
  { value: 'offer', label: 'Offer' },
  // 'declined' = employer turned down the application (a real outcome that
  // stays in the main roster). Separate from 'rejected' below, which means she
  // dismissed the listing and is labeled "Ignored".
  { value: 'declined', label: 'Rejected' },
  { value: 'rejected', label: 'Ignored', pickerLabel: 'Ignore' },
];

// Lucide-style stroked icons. Centralized so every surface that shows a
// rating (modal vote buttons, table card-foot, filter pills) uses the
// same glyph instead of platform-dependent thumb emojis. Color flows
// through currentColor — callers set color on the wrapping element.
export const SVG_THUMB_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>';
export const SVG_THUMB_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/></svg>';
// File / preview / download — replace emoji glyphs in the documents
// section. Lucide stroked icons, sized by their container.
export const SVG_FILE_TEXT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>';
export const SVG_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
export const SVG_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
export const SVG_DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
// External link arrow — for "Open original ↗" style links in modals.
export const SVG_EXTERNAL_LINK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';

// ============================================================
// UI helpers — small bits shared across pages. Kept here (rather
// than a separate ui.js) because app.js is the existing utility
// module and the helpers are small enough not to warrant a split.
// ============================================================

// Updates an element's text content and toggles a state class. The base
// class is the element's first className token, captured on first call so
// callers don't have to repeat it (e.g. 'status-message' or 'save-status').
// Pass state='' to clear. autoClearMs blanks the message after a delay,
// but only if the text hasn't been replaced in the meantime.
export function setStatus(el, text, state = '', autoClearMs = 0) {
  if (!el) return;
  if (el._statusBase === undefined) {
    el._statusBase = (el.className.split(/\s+/)[0] || '');
  }
  el.textContent = text;
  el.className = state ? `${el._statusBase} ${state}` : el._statusBase;
  if (autoClearMs > 0 && text) {
    setTimeout(() => {
      if (el.textContent === text) {
        el.textContent = '';
        el.className = el._statusBase;
      }
    }, autoClearMs);
  }
}

// Placeholder for empty / loading / no-results lists. Styled by .empty-state
// in style.css. Replaces the inline padded-centered-muted divs that were
// scattered across settings.js and documents.js.
export function renderEmptyState(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

// Reusable confirmation modal. Reuses .modal-backdrop + .modal styles from
// style.css. Resolves true on confirm, false on cancel/dismiss. Pass
// cancelLabel: null to hide the cancel button (alertDialog uses this).
export function confirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop confirm-backdrop';
    const confirmClass = destructive ? 'btn danger' : 'btn primary';
    const cancelBtn = cancelLabel
      ? `<button class="btn ghost" data-act="cancel">${escapeHtml(cancelLabel)}</button>`
      : '';
    backdrop.innerHTML = `
      <div class="modal confirm-modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div class="modal-title">${escapeHtml(title)}</div>
          <button class="modal-close" aria-label="Close">×</button>
        </div>
        <div class="modal-body">
          <p style="font-size:14px;color:var(--ink-2);line-height:1.5;margin:0 0 18px">${escapeHtml(message)}</p>
          <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
            ${cancelBtn}
            <button class="${confirmClass}" data-act="confirm">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => backdrop.classList.add('open'));

    const finish = (val) => {
      backdrop.classList.remove('open');
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      setTimeout(() => backdrop.remove(), 220);
      resolve(val);
    };
    const onKey = (e) => { if (e.key === 'Escape') finish(false); };

    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(false); });
    backdrop.querySelector('.modal-close').addEventListener('click', () => finish(false));
    backdrop.querySelector('[data-act="cancel"]')?.addEventListener('click', () => finish(false));
    backdrop.querySelector('[data-act="confirm"]').addEventListener('click', () => finish(true));
    document.addEventListener('keydown', onKey);
    backdrop.querySelector('[data-act="confirm"]').focus();
  });
}

// Acknowledge-only dialog. Replaces native alert() for in-app errors and
// notices so they match the rest of the modal styling.
export function alertDialog({ title = 'Heads up', message, label = 'OK' }) {
  return confirmDialog({ title, message, confirmLabel: label, cancelLabel: null });
}
