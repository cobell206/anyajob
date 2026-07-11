// public/components/documents.js — application materials section in the listing modal

import {
  $, escapeHtml, api,
  SVG_FILE_TEXT, SVG_FILE, SVG_EYE, SVG_DOWNLOAD,
} from '../app.js';
import { openFeedbackModal } from './feedback-modal.js';

const ALLOWED = '.pdf,.docx,.doc,.txt';

function fmtBytes(n) {
  if (!n) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function fmtRelTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h ago';
  const days = Math.floor(hr / 24);
  if (days < 30) return days + 'd ago';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function alignScoreValue(slot, align) {
  if (!align) return null;
  if (slot === 'cover' && typeof align.overallScore === 'number') return align.overallScore;
  if (typeof align.alignmentScore === 'number') return align.alignmentScore;
  return null;
}

function renderDoc(fp, slot, entry, opts = {}) {
  if (!entry) {
    return `
      <div class="doc-empty">
        <button class="btn-link doc-upload-btn" data-slot="${slot}">+ Upload ${slot === 'resume' ? 'résumé' : 'cover letter'}</button>
      </div>
    `;
  }
  const previewable = !!entry.previewFile;
  const align = entry.alignmentScore;
  const score = alignScoreValue(slot, align);
  const alignBadge = (score !== null)
    ? `<span class="doc-align align-${score >= 7 ? 'high' : score >= 5 ? 'mid' : 'low'}">${score}/10 fit</span>`
    : '';
  const fileIcon = entry.file.endsWith('.pdf') ? SVG_FILE_TEXT : SVG_FILE;
  return `
    <div class="doc-row">
      <div class="doc-icon">${fileIcon}</div>
      <div class="doc-meta">
        <div class="doc-name">${escapeHtml(entry.originalName || entry.file)}</div>
        <div class="doc-sub">${fmtBytes(entry.sizeBytes)} · ${fmtRelTime(entry.uploadedAt)} ${alignBadge}</div>
      </div>
      <div class="doc-actions">
        ${previewable ? `<button class="icon-btn-sm" data-action="preview" data-file="${entry.previewFile}" title="Preview" aria-label="Preview">${SVG_EYE}</button>` : ''}
        <a class="icon-btn-sm" href="/api/documents/${fp}/file/${entry.file}" download title="Download" aria-label="Download">${SVG_DOWNLOAD}</a>
        <button class="icon-btn-sm" data-action="replace" data-slot="${slot}" title="Replace" aria-label="Replace">↻</button>
      </div>
    </div>
  `;
}

function renderOther(fp, list = []) {
  if (!list.length) return '';
  return list.map((e) => {
    const fileIcon = e.file.endsWith('.pdf') ? SVG_FILE_TEXT : SVG_FILE;
    return `
    <div class="doc-row">
      <div class="doc-icon">${fileIcon}</div>
      <div class="doc-meta">
        <div class="doc-name">${escapeHtml(e.label || e.originalName)}</div>
        <div class="doc-sub">${fmtBytes(e.sizeBytes)} · ${fmtRelTime(e.uploadedAt)}</div>
      </div>
      <div class="doc-actions">
        ${e.previewFile ? `<button class="icon-btn-sm" data-action="preview" data-file="${e.previewFile}" title="Preview" aria-label="Preview">${SVG_EYE}</button>` : ''}
        <a class="icon-btn-sm" href="/api/documents/${fp}/file/${e.file}" download title="Download" aria-label="Download">${SVG_DOWNLOAD}</a>
        <button class="icon-btn-sm" data-action="delete-other" data-file="${e.file}" title="Delete" aria-label="Delete">×</button>
      </div>
    </div>
    `;
  }).join('');
}

export async function renderDocumentsSection(fingerprint) {
  const docs = await api(`/api/documents/${fingerprint}`).catch(() => ({}));
  // True when the user has uploaded at least one of {resume, cover} for
  // this listing. Drives whether we show the "upload to get started"
  // subtitle and whether the feedback boxes render at all — when nothing
  // is uploaded, the two empty-state placeholders are redundant noise.
  const hasAnyDoc = !!(docs.resume?.current || docs.cover?.current);
  const resumeAlignBlock = docs.resume?.current?.alignmentScore
    ? renderAlignment(docs.resume.current.alignmentScore)
    : '';
  const coverAlignBlock = docs.cover?.current?.alignmentScore
    ? renderCoverAlignment(docs.cover.current.alignmentScore)
    : '';
  // Only render feedback boxes when at least one doc exists. With one
  // uploaded and one missing, the missing one's empty-state placeholder is
  // still useful as a prompt to upload the second doc.
  const resumeFeedback = hasAnyDoc ? renderFeedbackBox('resume', docs.resume) : '';
  const coverFeedback = hasAnyDoc ? renderFeedbackBox('cover', docs.cover) : '';
  // The two empty-slot placeholders (.doc-empty) carry the upload affordance
  // when resume/cover aren't uploaded yet — no separate action-button row.
  // The "Other" slot is intentionally not surfaced in the UI; we only have
  // resume + cover concepts going forward. renderOther() + triggerUpload()
  // still handle any legacy "other" docs in saved data (show + delete).
  const otherBlock = renderOther(fingerprint, docs.other || []);
  const html = `
    <div class="modal-section docs-section">
      <h3>Application materials</h3>
      ${hasAnyDoc ? '' : '<p class="docs-section-sub">Upload a résumé or cover letter to get started.</p>'}
      <!-- Résumé and cover letter sit side by side; each column carries
           its own doc row, feedback box, and alignment result. -->
      <div class="docs-materials-grid">
        <div class="docs-col" data-col="resume">
          <div class="docs-col-head">Résumé</div>
          ${renderDoc(fingerprint, 'resume', docs.resume?.current ?? null)}
          ${resumeFeedback}
          ${resumeAlignBlock}
        </div>
        <div class="docs-col" data-col="cover">
          <div class="docs-col-head">Cover letter</div>
          ${renderDoc(fingerprint, 'cover', docs.cover?.current ?? null)}
          ${coverFeedback}
          ${coverAlignBlock}
        </div>
      </div>
      ${otherBlock ? `<div class="docs-list docs-other-list">${otherBlock}</div>` : ''}

      <!-- Inline document preview — opens within the docs section instead of
           covering the modal with a fullscreen overlay. The viewport scrolls
           when the scaled iframe exceeds its bounds, so the modal frame stays
           intact while the PDF is zoomed and panned. -->
      <div class="doc-preview-inline" id="m-doc-preview" hidden>
        <div class="doc-preview-head">
          <div class="doc-preview-title" id="m-doc-preview-title"></div>
          <div class="doc-preview-tools">
            <button type="button" class="icon-btn-sm" data-preview-action="zoom-out" title="Zoom out" aria-label="Zoom out">−</button>
            <span class="doc-preview-zoom" id="m-doc-preview-zoom">100%</span>
            <button type="button" class="icon-btn-sm" data-preview-action="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
            <button type="button" class="icon-btn-sm" data-preview-action="reset" title="Reset zoom" aria-label="Reset zoom">↺</button>
            <button type="button" class="icon-btn-sm" data-preview-action="close" title="Close preview" aria-label="Close preview">×</button>
          </div>
        </div>
        <div class="doc-preview-viewport" id="m-doc-preview-viewport">
          <div class="doc-preview-scale" id="m-doc-preview-scale">
            <iframe class="doc-preview-iframe" id="m-doc-preview-iframe" src="about:blank" title="Document preview"></iframe>
          </div>
        </div>
      </div>

      <input type="file" id="doc-file-input" accept="${ALLOWED}" style="display:none">
    </div>
  `;
  return html;
}

function renderFeedbackBox(slot, slotEntry) {
  const has = !!slotEntry?.current;
  const notes = slotEntry?.userNotes || '';
  const hasPriorScore = !!(slotEntry?.current?.alignmentScore && !slotEntry.current.alignmentScore.error);
  const label = slot === 'resume' ? 'Resume feedback' : 'Cover letter feedback';
  const placeholder = slot === 'resume'
    ? "Pre-empt suggestions you've already ruled out — e.g. \"don't suggest litigation experience, I haven't done any.\""
    : "Pre-empt suggestions you've already ruled out — e.g. \"don't suggest mentioning a JD; I'm pre-law.\"";
  if (!has) {
    return `
      <div class="align-notes empty" data-slot="${slot}">
        <div class="align-notes-head"><span class="align-notes-label">${label}</span></div>
        <div class="align-notes-empty">Upload a ${slot === 'resume' ? 'resume' : 'cover letter'} to get feedback.</div>
      </div>
    `;
  }
  const btnLabel = hasPriorScore ? 'Get feedback again' : 'Get feedback';
  return `
    <div class="align-notes" data-slot="${slot}">
      <div class="align-notes-head">
        <span class="align-notes-label">${label}</span>
        <span class="align-notes-hint">notes are optional — they shape the next round</span>
      </div>
      <textarea class="align-notes-text" data-slot="${slot}" rows="2" maxlength="1500" placeholder="${escapeHtml(placeholder)}">${escapeHtml(notes)}</textarea>
      <div class="align-notes-actions">
        <button class="btn btn-primary" data-action="get-feedback" data-slot="${slot}">${btnLabel}</button>
        <span class="align-notes-status" data-slot="${slot}"></span>
      </div>
    </div>
  `;
}

function renderAlignSkeleton(label) {
  return `
    <div class="align-skeleton">
      <span class="spinner"></span>
      <span>${escapeHtml(label)}</span>
    </div>
  `;
}

// Score at/above which a document reads as ready to submit. At/above this we
// flip the suggestion sections to "optional polish" framing rather than
// presenting them as required feedback — so she isn't nudged into an endless
// edit loop on a document that's already strong. Mirrors the prompt threshold
// in src/prompts.js.
const READY_TO_SUBMIT_SCORE = 8;

function alignSection(header, items, { optional = false } = {}) {
  if (!items?.length) return '';
  return `
    <div class="align-section${optional ? ' align-section-optional' : ''}">
      <div class="align-h">${escapeHtml(header)}</div>
      <ul>${items.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
    </div>
  `;
}

function readyBadge(ready) {
  return ready ? '<span class="align-ready-badge">✓ Ready to submit</span>' : '';
}

function optionalNote(ready, hasItems) {
  return ready && hasItems
    ? `<div class="align-optional-note">Already a strong submission — the notes below are optional polish, not required.</div>`
    : '';
}

function renderAlignment(a) {
  if (a.error) {
    return `<div class="align-box err">Resume scoring error: ${escapeHtml(a.error)}</div>`;
  }
  const ready = a.alignmentScore >= READY_TO_SUBMIT_SCORE;
  const hasSuggestions = !!(a.areasToStrengthen?.length || a.suggestedBullets?.length);
  return `
    <div class="align-box${ready ? ' align-box-ready' : ''}">
      <div class="align-head">
        <div class="align-label">Resume vs JD</div>
        <div class="align-score align-${a.alignmentScore >= 7 ? 'high' : a.alignmentScore >= 5 ? 'mid' : 'low'}">${a.alignmentScore}/10</div>
        ${readyBadge(ready)}
        <button type="button" class="btn-link align-view-btn" data-action="view-feedback" data-slot="resume">View detailed →</button>
      </div>
      <div class="align-summary">${escapeHtml(a.summary || '')}</div>
      ${alignSection("What's working", a.topStrengths)}
      ${optionalNote(ready, hasSuggestions)}
      ${alignSection('Worth highlighting more', a.areasToStrengthen, { optional: ready })}
      ${alignSection('Suggested bullets', a.suggestedBullets, { optional: ready })}
    </div>
  `;
}

function renderCoverAlignment(a) {
  if (a.error) {
    return `<div class="align-box err">Cover letter scoring error: ${escapeHtml(a.error)}</div>`;
  }
  const overall = typeof a.overallScore === 'number' ? a.overallScore : 0;
  const cls = overall >= 7 ? 'high' : overall >= 5 ? 'mid' : 'low';
  const ready = overall >= READY_TO_SUBMIT_SCORE;
  return `
    <div class="align-box${ready ? ' align-box-ready' : ''}">
      <div class="align-head">
        <div class="align-label">Cover letter vs JD</div>
        <div class="align-score align-${cls}">${overall}/10</div>
        ${readyBadge(ready)}
        <button type="button" class="btn-link align-view-btn" data-action="view-feedback" data-slot="cover">View detailed →</button>
      </div>
      ${(typeof a.relevanceScore === 'number' || typeof a.toneScore === 'number') ? `
        <div class="align-summary">
          ${typeof a.relevanceScore === 'number' ? `Relevance: <strong>${a.relevanceScore}/10</strong>` : ''}${(typeof a.relevanceScore === 'number' && typeof a.toneScore === 'number') ? ' · ' : ''}${typeof a.toneScore === 'number' ? `Tone: <strong>${a.toneScore}/10</strong>` : ''}
        </div>
      ` : ''}
      ${alignSection("What's working", a.strengths)}
      ${optionalNote(ready, !!a.suggestions?.length)}
      ${alignSection('Suggestions', a.suggestions, { optional: ready })}
    </div>
  `;
}

// Wire up actions inside the docs section. Call after rendering.
export function wireDocumentActions(container, fingerprint, refresh) {
  const fileInput = container.querySelector('#doc-file-input');
  let pendingSlot = null;
  let pendingOtherName = null;

  function triggerUpload(slot) {
    if (slot === 'other') {
      const name = prompt('What is this document? (e.g. "Writing sample")');
      if (!name) return;
      pendingOtherName = name;
    }
    pendingSlot = slot;
    fileInput.value = '';
    fileInput.click();
  }

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const slot = pendingSlot;
    const otherName = pendingOtherName;
    pendingSlot = null;
    pendingOtherName = null;

    const fd = new FormData();
    fd.append('file', file);
    fd.append('slot', slot);
    if (otherName) fd.append('otherName', otherName);

    const status = container.querySelector('.docs-status') || (() => {
      const el = document.createElement('div');
      el.className = 'docs-status';
      container.querySelector('.docs-section').appendChild(el);
      return el;
    })();
    status.innerHTML = `<span class="spinner-row"><span class="spinner sm"></span><span>Uploading ${escapeHtml(file.name)}…</span></span>`;
    status.className = 'docs-status info';

    // Disable all upload/replace buttons; show inline spinner on the active one.
    const buttons = Array.from(container.querySelectorAll('.doc-upload-btn, [data-action="replace"]'));
    const prevHtml = new Map();
    buttons.forEach((b) => {
      prevHtml.set(b, b.innerHTML);
      b.disabled = true;
      if (b.dataset.slot === slot) {
        b.innerHTML = `<span class="spinner sm"></span> Uploading…`;
      }
    });

    try {
      const res = await fetch(`/api/documents/${fingerprint}/upload`, {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Upload failed');
      }
      status.textContent = '✓ Uploaded';
      status.className = 'docs-status success';
      setTimeout(() => refresh?.(), 400);
    } catch (err) {
      status.textContent = 'Upload failed: ' + err.message;
      status.className = 'docs-status error';
      // Restore buttons on failure (refresh on success will re-render).
      buttons.forEach((b) => {
        b.disabled = false;
        b.innerHTML = prevHtml.get(b);
      });
    }
  });

  container.querySelectorAll('.doc-upload-btn').forEach((btn) => {
    btn.addEventListener('click', () => triggerUpload(btn.dataset.slot));
  });

  container.querySelectorAll('[data-action="replace"]').forEach((btn) => {
    btn.addEventListener('click', () => triggerUpload(btn.dataset.slot));
  });

  container.querySelectorAll('[data-action="preview"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openPreview(container, fingerprint, btn.dataset.file);
    });
  });

  // "View detailed" — opens the shared feedback modal (same one the
  // profile page uses) with this listing's résumé + the current
  // alignment results mapped to the modal's section format. Refetches
  // the latest docs at click time so it picks up any score that just
  // finished generating.
  container.querySelectorAll('[data-action="view-feedback"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const slot = btn.dataset.slot;
      const original = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner sm"></span>';
      try {
        const docs = await api(`/api/documents/${fingerprint}`);
        const entry = slot === 'resume' ? docs.resume?.current : docs.cover?.current;
        if (!entry?.alignmentScore) return;
        openListingFeedback(fingerprint, slot, entry);
      } finally {
        btn.disabled = false;
        btn.innerHTML = original;
      }
    });
  });

  // Inline preview tools — zoom in / out / reset / close. The viewport
  // scrolls natively when the scale wrapper exceeds it (when zoomed in),
  // so panning works via mouse wheel, trackpad, scrollbar drag, or touch.
  container.querySelectorAll('[data-preview-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.previewAction;
      if (action === 'close') closePreview(container);
      else if (action === 'zoom-in')  setZoom(container, getZoom(container) + ZOOM_STEP);
      else if (action === 'zoom-out') setZoom(container, getZoom(container) - ZOOM_STEP);
      else if (action === 'reset')    setZoom(container, 1);
    });
  });

  function notesText(slot) {
    const ta = container.querySelector(`textarea.align-notes-text[data-slot="${slot}"]`);
    return ta ? ta.value : '';
  }
  function notesStatus(slot) {
    return container.querySelector(`.align-notes-status[data-slot="${slot}"]`);
  }
  async function persistNotes(slot) {
    return api(`/api/documents/${fingerprint}/notes`, {
      method: 'POST',
      body: { slot, notes: notesText(slot) },
    });
  }

  // Auto-save notes on blur so a closed modal doesn't lose her draft.
  container.querySelectorAll('textarea.align-notes-text').forEach((ta) => {
    let saved = ta.value;
    ta.addEventListener('blur', async () => {
      if (ta.value === saved) return;
      const slot = ta.dataset.slot;
      const status = notesStatus(slot);
      try {
        await persistNotes(slot);
        saved = ta.value;
        if (status) { status.textContent = 'Notes saved'; status.className = 'align-notes-status ok'; }
      } catch (err) {
        if (status) { status.textContent = 'Save failed: ' + err.message; status.className = 'align-notes-status err'; }
      }
    });
  });

  container.querySelectorAll('[data-action="get-feedback"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const slot = btn.dataset.slot;
      const status = notesStatus(slot);
      const orig = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner sm"></span> Scoring…`;
      if (status) { status.textContent = ''; status.className = 'align-notes-status'; }

      // Replace any existing alignment block with a skeleton so it's clear
      // a new score is being generated.
      const skeleton = document.createElement('div');
      skeleton.className = 'align-skeleton';
      skeleton.innerHTML = `<span class="spinner"></span><span>${slot === 'resume' ? 'Scoring resume against this JD…' : 'Scoring cover letter against this JD…'}</span>`;
      const notesBox = container.querySelector(`.align-notes[data-slot="${slot}"]`);
      let existingAlign = notesBox?.nextElementSibling;
      if (existingAlign && (existingAlign.classList.contains('align-box') || existingAlign.classList.contains('align-skeleton'))) {
        existingAlign.replaceWith(skeleton);
      } else {
        notesBox?.insertAdjacentElement('afterend', skeleton);
      }

      try {
        await persistNotes(slot);
        await api(`/api/documents/${fingerprint}/score-${slot}`, { method: 'POST' });
        refresh?.();
      } catch (err) {
        if (status) { status.textContent = 'Scoring failed: ' + err.message; status.className = 'align-notes-status err'; }
        skeleton.remove();
        btn.disabled = false;
        btn.innerHTML = orig;
      }
    });
  });

  container.querySelectorAll('[data-action="delete-other"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this document?')) return;
      const orig = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner sm"></span>`;
      try {
        await api(`/api/documents/${fingerprint}/delete`, {
          method: 'POST',
          body: { slot: 'other', file: btn.dataset.file },
        });
        refresh?.();
      } catch (err) {
        btn.disabled = false;
        btn.innerHTML = orig;
      }
    });
  });
}

// Maps a per-listing alignment payload to the shared feedback-modal
// sections shape and opens the modal. The listing's alignment data is
// flat (topStrengths / areasToStrengthen / suggestedBullets) and has no
// PDF text anchors — so findings render as comment-only blocks without
// PDF highlights. (Adding text anchors is the Phase B follow-up.)
function openListingFeedback(fingerprint, slot, entry) {
  const a = entry.alignmentScore;
  const sections = [];
  if (slot === 'resume') {
    if (a.topStrengths?.length) {
      sections.push({ name: "What's working", strengths: a.topStrengths });
    }
    if (a.areasToStrengthen?.length) {
      sections.push({
        name: 'Worth highlighting more',
        findings: a.areasToStrengthen.map((c) => ({ comment: c, severity: 'minor' })),
      });
    }
    if (a.suggestedBullets?.length) {
      sections.push({
        name: 'Suggested bullets',
        findings: a.suggestedBullets.map((c) => ({ comment: c, severity: 'minor' })),
      });
    }
  } else {
    // Cover letter alignment has a different shape — strengths +
    // suggestions, plus optional relevance/tone sub-scores.
    if (a.strengths?.length) {
      sections.push({ name: "What's working", strengths: a.strengths });
    }
    if (a.suggestions?.length) {
      sections.push({
        name: 'Suggestions',
        findings: a.suggestions.map((c) => ({ comment: c, severity: 'minor' })),
      });
    }
  }
  const score = slot === 'resume' ? a.alignmentScore : a.overallScore;
  const ready = typeof score === 'number' && score >= READY_TO_SUBMIT_SCORE;
  const scoreOnHundred = typeof score === 'number' ? Math.round(score * 10) : 0;
  const title = slot === 'resume' ? 'Résumé alignment' : 'Cover letter alignment';
  openFeedbackModal({
    title,
    resumeUrl: `/api/documents/${fingerprint}/file/${entry.file}`,
    resumeFile: entry.file,
    initial: {
      state: 'loaded',
      overall: { score: scoreOnHundred, text: a.summary || '', ready },
      sections,
      generatedAt: a.generatedAt,
    },
  });
}

// ---------- Inline document preview ----------
//
// The preview lives inside the docs section (a div, not a fullscreen
// overlay) so it never extends past the modal. Zooming resizes the
// scale wrapper around the iframe, which makes the browser's native
// PDF viewer fit-to-width at the larger size. The viewport scrolls
// when the scaled content exceeds its bounds — that handles panning.
//
// The viewport's height is computed from the modal's available space
// each open + on resize, so the preview never pushes the modal past
// its max-height (the symptom: modal-level scroll on preview open).

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;
// Track the active preview container so the resize handler knows what
// to refit. Only one preview is open at a time across the app.
let activePreviewContainer = null;

function previewEls(container) {
  return {
    root:     container.querySelector('#m-doc-preview'),
    title:    container.querySelector('#m-doc-preview-title'),
    iframe:   container.querySelector('#m-doc-preview-iframe'),
    scale:    container.querySelector('#m-doc-preview-scale'),
    viewport: container.querySelector('#m-doc-preview-viewport'),
    label:    container.querySelector('#m-doc-preview-zoom'),
  };
}

function getZoom(container) {
  const { scale } = previewEls(container);
  return parseFloat(scale?.dataset.zoom || '1');
}

function setZoom(container, z) {
  const { scale, label, viewport } = previewEls(container);
  if (!scale) return;
  const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  scale.dataset.zoom = String(clamped);
  // Size the scale wrapper to (zoom × 100%) wide and (zoom × viewport
  // height) tall. The iframe inside fills 100%×100%, and the browser's
  // PDF viewer fit-to-widths the document — so a wider iframe = bigger
  // rendered PDF. No CSS transform needed; the natural sizing creates
  // a scrollable region inside .doc-preview-viewport.
  const viewportH = viewport?.clientHeight || 360;
  scale.style.width = `${clamped * 100}%`;
  scale.style.height = `${clamped * viewportH}px`;
  if (label) label.textContent = `${Math.round(clamped * 100)}%`;
}

// Size the preview viewport to fit the modal — head + preview-head +
// some bottom buffer subtracted from modal client height. With the
// .has-preview-open mode hiding the other modal content, the modal's
// content area equals (modal-head + docs-section + padding), so this
// arithmetic lands the viewport flush with the modal's bottom edge.
function fitPreviewHeight(container) {
  const { viewport, scale } = previewEls(container);
  const modal = container.closest('.modal');
  if (!viewport || !modal) return;
  const modalHead = modal.querySelector('.modal-head');
  const previewHead = container.querySelector('.doc-preview-head');
  const modalH = modal.clientHeight;
  const headH = modalHead?.offsetHeight || 70;
  const previewHeadH = previewHead?.offsetHeight || 45;
  // 52 = modal-body padding (20 top + 32 bottom). 16 = small bottom
  // breathing space inside the preview card.
  const target = modalH - headH - previewHeadH - 52 - 16;
  const clamped = Math.max(240, target);
  viewport.style.height = `${clamped}px`;
  // Re-apply zoom so the scale wrapper height tracks the new viewport.
  if (scale) setZoom(container, getZoom(container));
}

function openPreview(container, fingerprint, filename) {
  const { root, title, iframe } = previewEls(container);
  if (!root) return;
  title.textContent = filename;
  iframe.src = `/api/documents/${fingerprint}/file/${filename}?inline=1`;
  root.hidden = false;
  setZoom(container, 1);

  // Mark the modal so CSS can hide non-preview content (summary row,
  // rationale, strengths/concerns column, feedback boxes, footer meta).
  // Without this, those sections push the modal past 92dvh and the
  // whole modal scrolls — defeating the inline-preview goal.
  const modal = container.closest('.modal');
  modal?.classList.add('has-preview-open');
  // Reset the modal scroll so the preview lands at the top of the visible
  // area instead of wherever the user happened to be reading.
  if (modal) modal.scrollTop = 0;

  // Fit after layout settles — content is hidden, so available height
  // is now (modal viewport - head - preview-head - buffer).
  requestAnimationFrame(() => {
    fitPreviewHeight(container);
  });

  // While the preview is open, keep the viewport sized to the modal on
  // window resize / dvh changes (mobile address-bar collapse, etc.).
  activePreviewContainer = container;
  window.addEventListener('resize', handlePreviewResize);
}

function closePreview(container) {
  const { root, iframe, viewport } = previewEls(container);
  if (!root) return;
  root.hidden = true;
  iframe.src = 'about:blank';
  // Drop the explicit height so the CSS fallback takes over on next open.
  if (viewport) viewport.style.height = '';
  // Restore the full modal view.
  const modal = container.closest('.modal');
  modal?.classList.remove('has-preview-open');
  window.removeEventListener('resize', handlePreviewResize);
  activePreviewContainer = null;
}

function handlePreviewResize() {
  if (activePreviewContainer) fitPreviewHeight(activePreviewContainer);
}
