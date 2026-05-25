// public/profile.js — drives the profile page

import {
  $, $$, escapeHtml, api, fmtDateLong,
  alertDialog, confirmDialog, scrollToEl,
} from './app.js';
import { renderPdfWithHighlights } from './pdf-viewer.js';

let prefs = null;
let dirty = false;

// Auto-save tuning. Coalesce typing into a single POST 600ms after the user
// stops; immediate flush on blur, chip changes, and explicit Save click.
const SAVE_DEBOUNCE_MS = 600;
let saveTimer = null;
let saveInFlight = null;

// Per-field saved-flash. Tracks which field wrappers (<div data-field="…">)
// have been edited since the last successful save so we can pulse the
// underline green on each of them when the POST settles. Set, not array,
// so repeated edits to the same field only flash once.
const pendingFlash = new Set();
const FIELD_FLASH_MS = 900;

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
    // New résumé invalidates any cached feedback (entries scoped to the
    // prior file). Re-show the panel and re-hydrate — the empty state will
    // surface for any lens that no longer has fresh feedback.
    togglePanel('#resume-feedback-panel', true);
    await loadFeedback();
  } catch (err) {
    alertDialog({ title: 'Upload failed', message: err.message });
    await loadResume();
  }
}

async function removeResume() {
  const ok = await confirmDialog({
    title: 'Remove your résumé?',
    message: 'Scoring and discovery will fall back to the structured profile only.',
    confirmLabel: 'Remove',
    destructive: true,
  });
  if (!ok) return;
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
  // Feedback panel mirrors the résumé's presence — show it when there's a
  // résumé to evaluate, hide it when there isn't. Loading runs after to
  // hydrate cached feedback if any exists for the current file.
  togglePanel('#resume-feedback-panel', !!data.resume);
  if (data.resume) await loadFeedback();
}

function togglePanel(selector, show) {
  const el = $(selector);
  if (!el) return;
  el.hidden = !show;
}

// ---------- Résumé feedback ----------
// Two-surface architecture:
//   - Profile page panel = "summary card" (score, lens, last-generated,
//     "Open feedback" button). Calm. Doesn't dominate the profile page.
//   - Modal = the actual experience. ~90vw wide so the PDF + findings
//     panel have real room. Opened from the summary card.

const FEEDBACK_LENSES = [
  { v: 'law-school', l: 'Law school' },
  { v: 'policy', l: 'Policy' },
  { v: 'biglaw-paralegal', l: 'BigLaw paralegal' },
];
const FEEDBACK_LENS_KEY = 'profile.feedbackLens';

function getActiveLens() {
  const stored = localStorage.getItem(FEEDBACK_LENS_KEY);
  if (FEEDBACK_LENSES.some((x) => x.v === stored)) return stored;
  return 'law-school';
}

function setActiveLens(lens) {
  localStorage.setItem(FEEDBACK_LENS_KEY, lens);
}

// Module-level cache so the modal's toolbar (which persists across body
// states) can know which lenses already have cached feedback without
// re-fetching. Refreshed on every load + every successful generate.
let feedbackCache = { text: '', feedback: {}, resume: null };
// Active PDF viewer controller (for cross-pane sync). Reset whenever the
// modal closes or the body re-renders so prior listeners don't leak.
let pdfViewerCtrl = null;

// Refreshes the summary card after every load / generate / modal close.
async function loadFeedback() {
  try {
    const data = await api('/api/profile/resume/feedback');
    feedbackCache = {
      text: data.text || '',
      feedback: data.feedback || {},
      resume: data.resume || null,
    };
    renderFeedbackSummary();
  } catch (err) {
    renderFeedbackSummary({ error: err.message });
  }
}

// Summary card — calm, profile-appropriate. Shows just enough to know
// whether feedback exists and roughly how it scored.
function renderFeedbackSummary({ error } = {}) {
  const root = $('#resume-feedback-state');
  if (!root) return;
  if (error) {
    root.innerHTML = `
      <div class="feedback-error">${escapeHtml(error)}</div>
      <button class="btn" id="feedback-retry-btn" style="margin-top:10px" type="button">Try again</button>
    `;
    $('#feedback-retry-btn').addEventListener('click', loadFeedback);
    return;
  }
  const lens = getActiveLens();
  const entry = feedbackCache.feedback[lens];
  if (!entry) {
    // Empty state — never run feedback for this résumé yet under this lens.
    root.innerHTML = `
      <div class="feedback-summary-empty">
        <p class="feedback-summary-pitch">
          Get an admissions reader's read on your résumé. The deep-dive view shows
          your PDF alongside specific, anchored findings.
        </p>
        <div class="feedback-summary-meta"><strong>~$0.02</strong> · 10–20 sec</div>
        <button class="btn primary" id="feedback-open-btn" type="button">Get feedback</button>
      </div>
    `;
  } else {
    const score = typeof entry.score === 'number' ? entry.score : 0;
    const scoreClass = score >= 85 ? 'score-high' : score >= 70 ? 'score-mid' : 'score-low';
    const lensLabel = FEEDBACK_LENSES.find((l) => l.v === lens)?.l || lens;
    root.innerHTML = `
      <div class="feedback-summary">
        <div class="feedback-summary-score ${scoreClass}">${score}</div>
        <div class="feedback-summary-info">
          <div class="feedback-summary-lens-label">${escapeHtml(lensLabel)} lens</div>
          <div class="feedback-summary-stamp">Generated ${escapeHtml(fmtDateLong(entry.generatedAt))}</div>
        </div>
        <button class="btn primary" id="feedback-open-btn" type="button">Open feedback →</button>
      </div>
    `;
  }
  $('#feedback-open-btn')?.addEventListener('click', openFeedbackModal);
}

// ---------- Feedback modal ----------
// Mirrors the discover-modal pattern (lazy-built backdrop, Esc/backdrop
// dismiss, dismiss disabled during a regenerate). The modal hosts the
// full two-column experience: PDF viewer left, findings panel right.

let _feedbackBackdrop = null;
let _feedbackOpen = false;
let _feedbackGenerating = false;

function getFeedbackBackdrop() {
  if (_feedbackBackdrop) return _feedbackBackdrop;
  _feedbackBackdrop = document.createElement('div');
  _feedbackBackdrop.className = 'modal-backdrop feedback-backdrop';
  _feedbackBackdrop.innerHTML = `
    <div class="modal feedback-modal" role="dialog" aria-modal="true" aria-labelledby="feedback-modal-title">
      <div class="modal-head feedback-modal-head" id="feedback-modal-head"></div>
      <div class="modal-body feedback-modal-body" id="feedback-modal-body"></div>
    </div>
  `;
  document.body.appendChild(_feedbackBackdrop);
  _feedbackBackdrop.addEventListener('click', (e) => {
    if (e.target === _feedbackBackdrop && !_feedbackGenerating) closeFeedbackModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _feedbackOpen && !_feedbackGenerating) closeFeedbackModal();
  });
  return _feedbackBackdrop;
}

function openFeedbackModal() {
  getFeedbackBackdrop().classList.add('open');
  document.body.style.overflow = 'hidden';
  _feedbackOpen = true;
  const lens = getActiveLens();
  renderFeedbackShell(lens);
  const entry = feedbackCache.feedback[lens];
  if (entry) renderFeedbackBody('loaded', { lens, entry });
  else renderFeedbackBody('empty', { lens });
}

function closeFeedbackModal() {
  if (_feedbackBackdrop) _feedbackBackdrop.classList.remove('open');
  document.body.style.overflow = '';
  _feedbackOpen = false;
  pdfViewerCtrl = null;
  // Re-render summary in case feedback was generated/refreshed in-modal.
  renderFeedbackSummary();
}

// Shell = modal header (title + lens pills + refresh + close) + empty
// body slot. Re-rendered when lens changes so the active pill stays in
// sync without remounting the body.
function renderFeedbackShell(lens) {
  const head = $('#feedback-modal-head');
  const entry = feedbackCache.feedback[lens];
  const stamp = entry?.generatedAt ? `Generated ${fmtDateLong(entry.generatedAt)}` : '';
  head.innerHTML = `
    <div class="feedback-modal-head-row">
      <div class="modal-title" id="feedback-modal-title">Résumé feedback</div>
      <button class="modal-close" aria-label="Close" id="feedback-modal-close">×</button>
    </div>
    <div class="feedback-toolbar">
      <div class="feedback-lens-pills" role="radiogroup" aria-label="Feedback lens">
        ${FEEDBACK_LENSES.map((o) => `
          <button type="button"
                  role="radio"
                  aria-checked="${o.v === lens}"
                  class="filter-mini-pill ${o.v === lens ? 'active' : ''}"
                  data-lens="${o.v}">${o.l}</button>
        `).join('')}
      </div>
      <div class="feedback-toolbar-right">
        <span class="feedback-stamp">${stamp}</span>
        <button type="button" class="btn" id="feedback-refresh-btn" ${entry ? '' : 'hidden'}>Refresh</button>
      </div>
    </div>
  `;
  $('#feedback-modal-close').addEventListener('click', () => {
    if (!_feedbackGenerating) closeFeedbackModal();
  });
  $$('#feedback-modal-head [data-lens]').forEach((b) => {
    b.addEventListener('click', () => {
      const newLens = b.dataset.lens;
      if (newLens === lens) return;
      setActiveLens(newLens);
      renderFeedbackShell(newLens);
      const next = feedbackCache.feedback[newLens];
      if (next) renderFeedbackBody('loaded', { lens: newLens, entry: next });
      else renderFeedbackBody('empty', { lens: newLens });
    });
  });
  $('#feedback-refresh-btn')?.addEventListener('click', () => runFeedback(lens));
}

function renderFeedbackBody(state, opts = {}) {
  const body = $('#feedback-modal-body');
  if (!body) return;
  if (state === 'loading') {
    body.innerHTML = `
      <div class="feedback-loading">
        <span class="spinner sm"></span>
        Reading your résumé through an admissions reader's eye…
      </div>
    `;
    return;
  }
  if (state === 'empty') {
    body.innerHTML = `
      <div class="feedback-empty">
        <p class="feedback-empty-pitch">
          Read your résumé through an admissions reader's eye. Findings will be anchored
          to specific text on the page so you can see exactly what to revise — and what's
          already landing.
        </p>
        <div class="feedback-empty-meta"><strong>~$0.02</strong> · 10–20 sec</div>
        <button class="btn primary" id="feedback-generate-btn" type="button">Get feedback</button>
      </div>
    `;
    $('#feedback-generate-btn').addEventListener('click', () => runFeedback(opts.lens || getActiveLens()));
    return;
  }
  if (state === 'error') {
    body.innerHTML = `
      <div class="feedback-error">${escapeHtml(opts.message || 'Something went wrong.')}</div>
      <button class="btn" id="feedback-retry-btn" style="margin-top:10px" type="button">Try again</button>
    `;
    $('#feedback-retry-btn').addEventListener('click', loadFeedback);
    return;
  }
  if (state === 'loaded') {
    renderFeedbackLoaded(opts.lens, opts.entry);
  }
}

function renderFeedbackLoaded(lens, entry) {
  const body = $('#feedback-modal-body');
  const overallScore = typeof entry.score === 'number' ? entry.score : 0;
  const scoreClassName = overallScore >= 85 ? 'score-high' : overallScore >= 70 ? 'score-mid' : 'score-low';
  const isPdf = isPdfResume(feedbackCache.resume);
  body.innerHTML = `
    <div class="feedback-overall">
      <div class="feedback-overall-score ${scoreClassName}">${overallScore}</div>
      <div class="feedback-overall-text">${escapeHtml(entry.overall || '')}</div>
    </div>
    <div class="feedback-grid">
      <!-- .resume-pane wraps the scrollable .resume-render so the zoom
           toolbar can be absolute-positioned over it without being
           wiped when pdf-viewer re-renders the inner container on zoom. -->
      <div class="resume-pane">
        <div class="resume-render ${isPdf ? 'is-pdf' : ''}" id="resume-render"></div>
      </div>
      <div class="feedback-findings" id="feedback-findings"></div>
    </div>
  `;
  const findings = collectAllFindings(entry);
  $('#feedback-findings').innerHTML = (entry.sections || []).map(renderFeedbackSection).join('');

  if (isPdf) {
    mountPdfViewer(findings);
  } else {
    // Fallback for DOCX/TXT résumés — Anthropic accepts PDF only for
    // document blocks, so non-PDFs are scored against extracted text and
    // rendered the same way (string-match highlighting).
    $('#resume-render').innerHTML = renderResumeWithHighlights(feedbackCache.text, findings);
    pdfViewerCtrl = null;
    wireFeedbackInteractions();
  }
}

function isPdfResume(resume) {
  if (!resume?.file) return false;
  return resume.file.toLowerCase().endsWith('.pdf');
}

async function mountPdfViewer(findings) {
  const container = $('#resume-render');
  pdfViewerCtrl = null;
  try {
    pdfViewerCtrl = await renderPdfWithHighlights({
      container,
      pdfUrl: '/api/profile/resume?download=1',
      findings,
      onFindingFocus: (id, source) => {
        // Mirror the active state into the side panel; on click, scroll
        // the side-panel finding into view so she can read the comment.
        setPanelActive(id);
        if (source === 'click' && id) {
          const f = document.querySelector(`.feedback-finding[data-finding-id="${cssEscape(id)}"]`);
          scrollToEl(f);
        }
      },
    });
    mountPdfZoomBar(container, pdfViewerCtrl);
    wirePanelToPdfSync();
  } catch (err) {
    console.error('PDF render failed', err);
    container.innerHTML = `<div class="feedback-error">Could not render PDF: ${escapeHtml(err.message)}. Falling back to text view.</div>`;
    container.classList.remove('is-pdf');
    container.insertAdjacentHTML('beforeend', renderResumeWithHighlights(feedbackCache.text, findings));
    pdfViewerCtrl = null;
    wireFeedbackInteractions();
  }
}

// Floating zoom toolbar pinned at the bottom-center of the PDF column.
// Lives in .resume-pane (sibling of .resume-render) — not inside the
// scrolling .resume-render container — so pdf-viewer's paint() can wipe
// the inner container on zoom without destroying the toolbar.
function mountPdfZoomBar(container, ctrl) {
  // .resume-pane is the parent of .resume-render in the new markup.
  // Fall back to container if structure is unexpected (defensive).
  const pane = container.parentElement?.classList.contains('resume-pane')
    ? container.parentElement
    : container;
  // Remove any prior bar from a previous render so we don't stack them.
  pane.querySelector('.pdf-zoom-bar')?.remove();

  const bar = document.createElement('div');
  bar.className = 'pdf-zoom-bar';
  bar.innerHTML = `
    <button type="button" class="pdf-zoom-btn" data-zoom="out" aria-label="Zoom out" title="Zoom out">−</button>
    <span class="pdf-zoom-level" aria-live="polite">${Math.round(ctrl.getScale() * 100)}%</span>
    <button type="button" class="pdf-zoom-btn" data-zoom="in" aria-label="Zoom in" title="Zoom in">+</button>
    <button type="button" class="pdf-zoom-btn" data-zoom="fit" aria-label="Fit to width" title="Fit to width">↺</button>
  `;
  pane.appendChild(bar);

  const label = bar.querySelector('.pdf-zoom-level');
  const updateLabel = () => { label.textContent = `${Math.round(ctrl.getScale() * 100)}%`; };

  // Keep the % readout in sync regardless of where the zoom came from —
  // button click, Ctrl/Cmd + wheel, or any future gesture. pdf-viewer
  // dispatches 'pdf-zoom' on the container after every setScale settles.
  container.addEventListener('pdf-zoom', updateLabel);

  bar.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-zoom]');
    if (!btn) return;
    const action = btn.dataset.zoom;
    let target = ctrl.getScale();
    if (action === 'in') target += 0.25;
    else if (action === 'out') target -= 0.25;
    else if (action === 'fit') target = ctrl.getFitScale();

    // Disable while re-rendering so a rapid double-click doesn't fire
    // overlapping paints.
    bar.querySelectorAll('.pdf-zoom-btn').forEach((b) => (b.disabled = true));
    try {
      await ctrl.setScale(target);
    } finally {
      bar.querySelectorAll('.pdf-zoom-btn').forEach((b) => (b.disabled = false));
      updateLabel();
    }
  });
}

// Cross-pane sync: hovering or clicking a side-panel finding pulses its
// PDF overlay (and scrolls the PDF column to it on click).
function wirePanelToPdfSync() {
  const findings = $$('#feedback-findings .feedback-finding');
  findings.forEach((el) => {
    el.addEventListener('mouseenter', () => {
      el.classList.add('is-active');
      pdfViewerCtrl?.setActive(el.dataset.findingId);
    });
    el.addEventListener('mouseleave', () => {
      el.classList.remove('is-active');
      pdfViewerCtrl?.setActive(null);
    });
    el.addEventListener('click', () => {
      pdfViewerCtrl?.scrollToFinding(el.dataset.findingId);
      pdfViewerCtrl?.setActive(el.dataset.findingId);
    });
  });
}

function setPanelActive(id) {
  $$('#feedback-findings .feedback-finding').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.findingId === id);
  });
}

// CSS.escape isn't quite right for attribute-selector values (it escapes
// for selector parsing, not attribute matching), but it covers our case
// since finding ids are "{sectionName}-{index}" — no exotic characters.
function cssEscape(s) {
  return window.CSS?.escape ? window.CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function renderFeedbackSection(section) {
  const findings = section.findings || [];
  const strengths = section.strengths || [];
  const score = typeof section.score === 'number' ? section.score : '';
  const countLabel = findings.length
    ? `<span class="feedback-section-count">· ${findings.length} finding${findings.length === 1 ? '' : 's'}</span>`
    : '';
  return `
    <div class="feedback-section">
      <div class="feedback-section-head">
        <div class="feedback-section-name">${escapeHtml(section.name || 'Section')}${countLabel}</div>
        <div class="feedback-section-score">${score}</div>
      </div>
      ${strengths.length ? `
        <div class="feedback-strengths">
          <div class="feedback-strengths-label">Strengths</div>
          <ul>${strengths.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
        </div>
      ` : ''}
      ${findings.length ? `
        <div class="feedback-findings-label">Findings</div>
        <ul class="feedback-finding-list">
          ${findings.map((f, i) => `
            <li class="feedback-finding" data-finding-id="${section.name}-${i}" data-severity="${escapeHtml(f.severity || 'minor')}">
              <div class="feedback-finding-head">
                <span class="feedback-finding-severity"></span>
                <span class="feedback-finding-quote">"${escapeHtml(f.quote || '')}"</span>
              </div>
              <div class="feedback-finding-comment">${escapeHtml(f.comment || '')}</div>
              ${f.suggested_rewrite ? `
                <div class="feedback-finding-rewrite">
                  <div class="feedback-finding-rewrite-label">Suggested rewrite</div>
                  ${escapeHtml(f.suggested_rewrite)}
                </div>
              ` : ''}
            </li>
          `).join('')}
        </ul>
      ` : '<div class="feedback-strengths" style="border:0;padding:0;margin:0;color:var(--muted)">No findings in this section.</div>'}
    </div>
  `;
}

// Flatten findings across sections, attach the same id used in the side
// panel so hovering / clicking can cross-reference. Includes the page
// number Claude assigned (PDF-mode); text-mode falls back to first-match.
function collectAllFindings(entry) {
  const out = [];
  for (const section of entry.sections || []) {
    (section.findings || []).forEach((f, i) => {
      if (!f.quote) return;
      out.push({
        id: `${section.name}-${i}`,
        page: f.page || null,
        quote: f.quote,
        severity: f.severity || 'minor',
      });
    });
  }
  return out;
}

// Render the résumé text with <mark> tags wrapping the first occurrence of
// each finding's quote. We escape everything first, then do string-level
// replacement on the escaped HTML — the quotes themselves come from Claude
// and are escaped before splicing so the original text stays safe.
function renderResumeWithHighlights(rawText, findings) {
  if (!rawText) return '<div class="feedback-loading" style="padding:8px">Résumé text unavailable.</div>';
  let html = escapeHtml(rawText);
  for (const f of findings) {
    const needle = escapeHtml(f.quote);
    const idx = html.indexOf(needle);
    if (idx < 0) continue; // Claude quote didn't match verbatim — skip silently
    const before = html.slice(0, idx);
    const after = html.slice(idx + needle.length);
    const mark = `<mark class="finding" data-finding-id="${escapeHtml(f.id)}" data-severity="${escapeHtml(f.severity)}">${needle}</mark>`;
    html = before + mark + after;
  }
  // Wrap in a pre-style container so line breaks survive.
  return `<p style="white-space:pre-wrap;margin:0">${html}</p>`;
}

function wireFeedbackInteractions() {
  const findings = $$('#feedback-findings .feedback-finding');
  const marks = $$('#resume-render mark.finding');
  const setActive = (id, source) => {
    findings.forEach((el) => el.classList.toggle('is-active', el.dataset.findingId === id));
    marks.forEach((el) => el.classList.toggle('is-active', el.dataset.findingId === id));
    if (source === 'panel') {
      scrollToEl(marks.find((el) => el.dataset.findingId === id));
    } else if (source === 'mark') {
      scrollToEl(findings.find((el) => el.dataset.findingId === id));
    }
  };
  findings.forEach((el) => {
    el.addEventListener('mouseenter', () => setActive(el.dataset.findingId, null));
    el.addEventListener('mouseleave', () => setActive(null, null));
    el.addEventListener('click', () => setActive(el.dataset.findingId, 'panel'));
  });
  marks.forEach((el) => {
    el.addEventListener('mouseenter', () => setActive(el.dataset.findingId, null));
    el.addEventListener('mouseleave', () => setActive(null, null));
    el.addEventListener('click', () => setActive(el.dataset.findingId, 'mark'));
  });
}

async function runFeedback(lens) {
  // Gate modal dismissal while the API call is in flight — same pattern
  // as the discover modal. She chose this in the prior round; mid-flight
  // close would lose the result for an action she explicitly started.
  _feedbackGenerating = true;
  renderFeedbackShell(lens);
  renderFeedbackBody('loading');
  try {
    // Direct fetch rather than api() so we can surface the server's actual
    // error body on 4xx/5xx — api() throws a generic "HTTP NNN" that hides
    // the real reason (parse failure, no résumé, etc).
    const res = await fetch('/api/profile/resume/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lens }),
    });
    const entry = await res.json().catch(() => ({}));
    if (!res.ok || entry.error) {
      const msg = entry.error || entry.raw || `HTTP ${res.status}`;
      renderFeedbackBody('error', { message: msg });
      return;
    }
    // Refetch GET to repopulate the cache (text + cross-lens feedback map +
    // current resume meta). Preserve resume so isPdfResume keeps working.
    const data = await api('/api/profile/resume/feedback');
    feedbackCache = {
      text: data.text || '',
      feedback: data.feedback || {},
      resume: data.resume || feedbackCache.resume,
    };
    renderFeedbackShell(lens);
    renderFeedbackBody('loaded', { lens, entry: feedbackCache.feedback[lens] || entry });
  } catch (err) {
    renderFeedbackBody('error', { message: err.message });
  } finally {
    _feedbackGenerating = false;
  }
}

// ---------- About-you fields ----------

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
  // Snapshot pendingFlash up front: if the user starts editing another
  // field while this POST is in flight, that field stays dirty for the
  // next save cycle rather than getting flashed prematurely.
  const flashThisRound = Array.from(pendingFlash);
  pendingFlash.clear();
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
    flashSavedFields(flashThisRound);
    setTimeout(() => { if (!dirty) setStatus(''); }, 1800);
  } catch (err) {
    setStatus('Save failed: ' + err.message, 'dirty');
    // Restore so the next successful save still flashes these fields.
    flashThisRound.forEach((el) => pendingFlash.add(el));
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function flashSavedFields(wrappers) {
  for (const w of wrappers) {
    if (!w) continue;
    // Restart the animation cleanly even if a previous flash is still
    // mid-frame on the same element.
    w.classList.remove('is-saved');
    void w.offsetWidth;
    w.classList.add('is-saved');
    setTimeout(() => w.classList.remove('is-saved'), FIELD_FLASH_MS);
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
    // The dossier markup wraps each input in <div data-field="k"> so the
    // flash can target the row (including its underline rule) rather
    // than the bare input.
    const wrap = el.closest('[data-field]');
    el.addEventListener('input', () => {
      if (wrap) pendingFlash.add(wrap);
      scheduleSave();
    });
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
