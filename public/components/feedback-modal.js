// public/components/feedback-modal.js — reusable "résumé feedback" modal.
//
// Hosts the two-column experience used in two places:
//   - Profile page: deep-dive feedback for the user's profile résumé
//     across multiple admissions lenses (law-school / policy / etc).
//   - Roles → listing modal: per-listing alignment of the listing's
//     uploaded résumé against that job's description.
//
// Singleton — one feedback modal in the app at a time. The caller owns
// data + handlers; this module owns the DOM, lifecycle, PDF viewer
// mount, zoom toolbar, and cross-pane sync.
//
// API:
//   const ctrl = openFeedbackModal({
//     title, subtitle?,
//     resumeUrl, resumeFile, resumeText?,
//     initial: { state, overall?, sections?, generatedAt? },
//     lenses?, activeLens?, onLensChange?,
//     onGenerate?, onRefresh?,
//     emptyPitch?, emptyMeta?,
//   });
//   ctrl.render({ state, overall, sections, generatedAt, activeLens });
//   ctrl.setGenerating(bool);   // gates close + dismiss
//   ctrl.close();

import { $, $$, escapeHtml, fmtDateLong, scrollToEl } from '../app.js';
import { renderPdfWithHighlights } from '../pdf-viewer.js';

// Module-level singleton state. Built lazily on first openFeedbackModal.
let _backdrop = null;
let _isOpen = false;
let _generating = false;
let _currentOpts = null;       // last full opts object (for re-render reference)
let _currentPayload = null;    // last { state, overall, sections, generatedAt, activeLens }
let _pdfCtrl = null;           // pdf-viewer controller for the open modal
let _onClose = null;           // optional close callback from caller

function ensureBackdrop() {
  if (_backdrop) return _backdrop;
  _backdrop = document.createElement('div');
  _backdrop.className = 'modal-backdrop feedback-backdrop';
  _backdrop.innerHTML = `
    <div class="modal feedback-modal" role="dialog" aria-modal="true" aria-labelledby="feedback-modal-title">
      <div class="modal-head feedback-modal-head" id="feedback-modal-head"></div>
      <div class="modal-body feedback-modal-body" id="feedback-modal-body"></div>
    </div>
  `;
  document.body.appendChild(_backdrop);
  _backdrop.addEventListener('click', (e) => {
    if (e.target === _backdrop && !_generating) closeFeedbackModal();
  });
  // Module-level escape handler. Only fires when the feedback modal is
  // the topmost open modal (gated by _isOpen). Stacking with other
  // modals: if a listing modal opens this feedback modal, Esc will hit
  // both handlers — feedback closes first (this handler), then the
  // event continues to the listing handler. Acceptable.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _isOpen && !_generating) closeFeedbackModal();
  });
  return _backdrop;
}

export function openFeedbackModal(opts) {
  _currentOpts = opts;
  _onClose = opts.onClose || null;
  ensureBackdrop().classList.add('open');
  document.body.style.overflow = 'hidden';
  _isOpen = true;

  const initial = opts.initial || { state: 'empty' };
  _currentPayload = {
    state: initial.state || 'empty',
    overall: initial.overall,
    sections: initial.sections,
    generatedAt: initial.generatedAt,
    activeLens: opts.activeLens,
  };

  renderShell();
  renderBody();

  return {
    render(newPayload) {
      _currentPayload = { ..._currentPayload, ...newPayload };
      renderShell();
      renderBody();
    },
    setGenerating(flag) {
      _generating = !!flag;
    },
    close: closeFeedbackModal,
  };
}

export function closeFeedbackModal() {
  if (!_backdrop) return;
  _backdrop.classList.remove('open');
  document.body.style.overflow = '';
  _isOpen = false;
  _pdfCtrl = null;
  const cb = _onClose;
  _onClose = null;
  _currentOpts = null;
  _currentPayload = null;
  if (typeof cb === 'function') cb();
}

// Head = title + close + (optional) lens pills + (optional) refresh.
// Re-rendered on every payload change so active-lens + refresh-visibility
// stay in sync.
function renderShell() {
  const head = $('#feedback-modal-head');
  if (!head) return;
  const { title, subtitle, lenses, onLensChange, onRefresh } = _currentOpts;
  const { state, generatedAt, activeLens } = _currentPayload;
  const stamp = generatedAt ? `Generated ${fmtDateLong(generatedAt)}` : '';
  const showRefresh = state === 'loaded' && typeof onRefresh === 'function';
  head.innerHTML = `
    <div class="feedback-modal-head-row">
      <div>
        <div class="modal-title" id="feedback-modal-title">${escapeHtml(title || 'Résumé feedback')}</div>
        ${subtitle ? `<div class="feedback-modal-subtitle">${escapeHtml(subtitle)}</div>` : ''}
      </div>
      <button class="modal-close" aria-label="Close" id="feedback-modal-close">×</button>
    </div>
    ${(lenses?.length || stamp || showRefresh) ? `
      <div class="feedback-toolbar">
        ${lenses?.length ? `
          <div class="feedback-lens-pills" role="radiogroup" aria-label="Feedback lens">
            ${lenses.map((o) => `
              <button type="button"
                      role="radio"
                      aria-checked="${o.v === activeLens}"
                      class="filter-mini-pill ${o.v === activeLens ? 'active' : ''}"
                      data-lens="${escapeHtml(o.v)}">${escapeHtml(o.l)}</button>
            `).join('')}
          </div>
        ` : '<span></span>'}
        <div class="feedback-toolbar-right">
          ${stamp ? `<span class="feedback-stamp">${escapeHtml(stamp)}</span>` : ''}
          ${showRefresh ? `<button type="button" class="btn" id="feedback-refresh-btn">Refresh</button>` : ''}
        </div>
      </div>
    ` : ''}
  `;
  $('#feedback-modal-close').addEventListener('click', () => {
    if (!_generating) closeFeedbackModal();
  });
  if (lenses?.length && typeof onLensChange === 'function') {
    $$('#feedback-modal-head [data-lens]').forEach((b) => {
      b.addEventListener('click', () => {
        const newLens = b.dataset.lens;
        if (newLens === activeLens) return;
        onLensChange(newLens);
      });
    });
  }
  if (showRefresh) {
    $('#feedback-refresh-btn').addEventListener('click', () => onRefresh());
  }
}

function renderBody() {
  const body = $('#feedback-modal-body');
  if (!body) return;
  const { state, overall, sections } = _currentPayload;
  const { onGenerate, emptyPitch, emptyMeta } = _currentOpts;

  if (state === 'loading') {
    body.innerHTML = `
      <div class="feedback-loading">
        <span class="spinner sm"></span>
        Reading your résumé…
      </div>
    `;
    return;
  }

  if (state === 'empty') {
    body.innerHTML = `
      <div class="feedback-empty">
        <p class="feedback-empty-pitch">${escapeHtml(emptyPitch || 'Generate feedback to see anchored findings against this résumé.')}</p>
        ${emptyMeta ? `<div class="feedback-empty-meta">${emptyMeta}</div>` : ''}
        ${typeof onGenerate === 'function' ? `<button class="btn primary" id="feedback-generate-btn" type="button">Get feedback</button>` : ''}
      </div>
    `;
    if (typeof onGenerate === 'function') {
      $('#feedback-generate-btn').addEventListener('click', () => onGenerate());
    }
    return;
  }

  if (state === 'error') {
    body.innerHTML = `
      <div class="feedback-error">${escapeHtml(_currentPayload.message || 'Something went wrong.')}</div>
      ${typeof onGenerate === 'function' ? `<button class="btn" id="feedback-retry-btn" style="margin-top:10px" type="button">Try again</button>` : ''}
    `;
    if (typeof onGenerate === 'function') {
      $('#feedback-retry-btn').addEventListener('click', () => onGenerate());
    }
    return;
  }

  if (state === 'loaded') {
    renderLoaded(overall || {}, sections || []);
  }
}

function renderLoaded(overall, sections) {
  const body = $('#feedback-modal-body');
  const { resumeFile, resumeText } = _currentOpts;
  const overallScore = typeof overall.score === 'number' ? overall.score : 0;
  const scoreClassName = overallScore >= 85 ? 'score-high' : overallScore >= 70 ? 'score-mid' : 'score-low';
  const isPdf = !!resumeFile && resumeFile.toLowerCase().endsWith('.pdf');
  body.innerHTML = `
    <div class="feedback-overall">
      <div class="feedback-overall-score ${scoreClassName}">${overallScore}</div>
      <div class="feedback-overall-text">${escapeHtml(overall.text || '')}</div>
    </div>
    <div class="feedback-grid">
      <div class="resume-pane">
        <div class="resume-render ${isPdf ? 'is-pdf' : ''}" id="resume-render"></div>
      </div>
      <div class="feedback-findings" id="feedback-findings"></div>
    </div>
  `;
  const findings = collectAllFindings(sections);
  $('#feedback-findings').innerHTML = sections.map(renderFeedbackSection).join('');

  if (isPdf) {
    mountPdfViewer(findings);
  } else {
    $('#resume-render').innerHTML = renderResumeWithHighlights(resumeText, findings);
    _pdfCtrl = null;
    wireTextModeFindings();
  }
}

async function mountPdfViewer(findings) {
  const container = $('#resume-render');
  const { resumeUrl, resumeText } = _currentOpts;
  _pdfCtrl = null;
  try {
    _pdfCtrl = await renderPdfWithHighlights({
      container,
      pdfUrl: resumeUrl,
      findings,
      onFindingFocus: (id, source) => {
        setPanelActive(id);
        if (source === 'click' && id) {
          const f = document.querySelector(`.feedback-finding[data-finding-id="${cssEscape(id)}"]`);
          scrollToEl(f);
        }
      },
    });
    mountPdfZoomBar(container, _pdfCtrl);
    wirePanelToPdfSync();
  } catch (err) {
    console.error('PDF render failed', err);
    container.innerHTML = `<div class="feedback-error">Could not render PDF: ${escapeHtml(err.message)}. Falling back to text view.</div>`;
    container.classList.remove('is-pdf');
    container.insertAdjacentHTML('beforeend', renderResumeWithHighlights(resumeText, findings));
    _pdfCtrl = null;
    wireTextModeFindings();
  }
}

// Floating zoom toolbar pinned at the bottom-center of the PDF column.
// Lives in .resume-pane (sibling of .resume-render) so pdf-viewer's
// paint() can wipe the inner container on zoom without destroying it.
function mountPdfZoomBar(container, ctrl) {
  const pane = container.parentElement?.classList.contains('resume-pane')
    ? container.parentElement
    : container;
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

  container.addEventListener('pdf-zoom', updateLabel);

  bar.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-zoom]');
    if (!btn) return;
    const action = btn.dataset.zoom;
    let target = ctrl.getScale();
    if (action === 'in') target += 0.25;
    else if (action === 'out') target -= 0.25;
    else if (action === 'fit') target = ctrl.getFitScale();

    bar.querySelectorAll('.pdf-zoom-btn').forEach((b) => (b.disabled = true));
    try {
      await ctrl.setScale(target);
    } finally {
      bar.querySelectorAll('.pdf-zoom-btn').forEach((b) => (b.disabled = false));
      updateLabel();
    }
  });
}

// Cross-pane sync (PDF mode): panel-finding hover → PDF overlay pulse;
// panel-finding click → scroll PDF column to that finding.
function wirePanelToPdfSync() {
  const findings = $$('#feedback-findings .feedback-finding');
  findings.forEach((el) => {
    el.addEventListener('mouseenter', () => {
      el.classList.add('is-active');
      _pdfCtrl?.setActive(el.dataset.findingId);
    });
    el.addEventListener('mouseleave', () => {
      el.classList.remove('is-active');
      _pdfCtrl?.setActive(null);
    });
    el.addEventListener('click', () => {
      _pdfCtrl?.scrollToFinding(el.dataset.findingId);
      _pdfCtrl?.setActive(el.dataset.findingId);
    });
  });
}

// Cross-pane sync (text-fallback mode): panel ↔ <mark> highlights in
// the rendered text resume.
function wireTextModeFindings() {
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

function setPanelActive(id) {
  $$('#feedback-findings .feedback-finding').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.findingId === id);
  });
}

// CSS.escape isn't strictly correct for attribute-selector values (it
// targets selector parsing, not attribute matching), but it covers
// finding ids which are "{sectionName}-{index}" — no exotic characters.
function cssEscape(s) {
  return window.CSS?.escape ? window.CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
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
            <li class="feedback-finding" data-finding-id="${escapeHtml(section.name)}-${i}" data-severity="${escapeHtml(f.severity || 'minor')}">
              <div class="feedback-finding-head">
                <span class="feedback-finding-severity"></span>
                ${f.quote ? `<span class="feedback-finding-quote">"${escapeHtml(f.quote)}"</span>` : ''}
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
      ` : (strengths.length ? '' : '<div class="feedback-strengths" style="border:0;padding:0;margin:0;color:var(--muted)">No findings in this section.</div>')}
    </div>
  `;
}

// Flatten findings across sections into the format pdf-viewer expects.
function collectAllFindings(sections) {
  const out = [];
  for (const section of sections || []) {
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

// Text-fallback rendering: wrap each finding's quote in <mark> for the
// non-PDF resume case. Quotes come from the AI; escape both haystack
// and needle so splicing escaped HTML stays safe.
function renderResumeWithHighlights(rawText, findings) {
  if (!rawText) return '<div class="feedback-loading" style="padding:8px">Résumé text unavailable.</div>';
  let html = escapeHtml(rawText);
  for (const f of findings) {
    if (!f.quote) continue;
    const needle = escapeHtml(f.quote);
    const idx = html.indexOf(needle);
    if (idx < 0) continue;
    const before = html.slice(0, idx);
    const after = html.slice(idx + needle.length);
    const mark = `<mark class="finding" data-finding-id="${escapeHtml(f.id)}" data-severity="${escapeHtml(f.severity)}">${needle}</mark>`;
    html = before + mark + after;
  }
  return `<p style="white-space:pre-wrap;margin:0">${html}</p>`;
}
