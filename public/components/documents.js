// public/components/documents.js — application materials section in the listing modal

import { $, escapeHtml, api } from '../app.js';

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
        <div class="doc-empty-label">${slot === 'resume' ? 'Resume' : 'Cover letter'}</div>
        <button class="btn-link doc-upload-btn" data-slot="${slot}">+ Upload</button>
      </div>
    `;
  }
  const previewable = !!entry.previewFile;
  const align = entry.alignmentScore;
  const score = alignScoreValue(slot, align);
  const alignBadge = (score !== null)
    ? `<span class="doc-align align-${score >= 7 ? 'high' : score >= 5 ? 'mid' : 'low'}">${score}/10 fit</span>`
    : '';
  return `
    <div class="doc-row">
      <div class="doc-icon">${entry.file.endsWith('.pdf') ? '📄' : '📝'}</div>
      <div class="doc-meta">
        <div class="doc-name">${escapeHtml(entry.originalName || entry.file)}</div>
        <div class="doc-sub">${fmtBytes(entry.sizeBytes)} · ${fmtRelTime(entry.uploadedAt)} ${alignBadge}</div>
      </div>
      <div class="doc-actions">
        ${previewable ? `<button class="icon-btn-sm" data-action="preview" data-file="${entry.previewFile}" title="Preview">👁</button>` : ''}
        <a class="icon-btn-sm" href="/api/documents/${fp}/file/${entry.file}" download title="Download">⬇</a>
        <button class="icon-btn-sm" data-action="replace" data-slot="${slot}" title="Replace">↻</button>
      </div>
    </div>
  `;
}

function renderOther(fp, list = []) {
  if (!list.length) return '';
  return list.map((e) => `
    <div class="doc-row">
      <div class="doc-icon">${e.file.endsWith('.pdf') ? '📄' : '📝'}</div>
      <div class="doc-meta">
        <div class="doc-name">${escapeHtml(e.label || e.originalName)}</div>
        <div class="doc-sub">${fmtBytes(e.sizeBytes)} · ${fmtRelTime(e.uploadedAt)}</div>
      </div>
      <div class="doc-actions">
        ${e.previewFile ? `<button class="icon-btn-sm" data-action="preview" data-file="${e.previewFile}" title="Preview">👁</button>` : ''}
        <a class="icon-btn-sm" href="/api/documents/${fp}/file/${e.file}" download title="Download">⬇</a>
        <button class="icon-btn-sm" data-action="delete-other" data-file="${e.file}" title="Delete">×</button>
      </div>
    </div>
  `).join('');
}

export async function renderDocumentsSection(fingerprint) {
  const docs = await api(`/api/documents/${fingerprint}`).catch(() => ({}));
  const resumeAlignBlock = docs.resume?.current?.alignmentScore
    ? renderAlignment(docs.resume.current.alignmentScore)
    : '';
  const coverAlignBlock = docs.cover?.current?.alignmentScore
    ? renderCoverAlignment(docs.cover.current.alignmentScore)
    : '';
  const resumeFeedback = renderFeedbackBox('resume', docs.resume);
  const coverFeedback = renderFeedbackBox('cover', docs.cover);
  const html = `
    <div class="modal-section docs-section">
      <h3>Application materials</h3>
      <div class="docs-list">
        ${docs.resume ? renderDoc(fingerprint, 'resume', docs.resume.current) : renderDoc(fingerprint, 'resume', null)}
        ${docs.cover ? renderDoc(fingerprint, 'cover', docs.cover.current) : renderDoc(fingerprint, 'cover', null)}
        ${renderOther(fingerprint, docs.other || [])}
      </div>
      <div class="docs-actions">
        ${docs.resume?.current ? '' : `<button class="btn doc-upload-btn" data-slot="resume">+ Resume</button>`}
        ${docs.cover?.current ? '' : `<button class="btn doc-upload-btn" data-slot="cover">+ Cover letter</button>`}
        <button class="btn doc-upload-btn" data-slot="other">+ Other</button>
      </div>
      ${resumeFeedback}
      ${resumeAlignBlock}
      ${coverFeedback}
      ${coverAlignBlock}
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

function renderAlignment(a) {
  if (a.error) {
    return `<div class="align-box err">Resume scoring error: ${escapeHtml(a.error)}</div>`;
  }
  return `
    <div class="align-box">
      <div class="align-head">
        <div class="align-label">Resume vs JD</div>
        <div class="align-score align-${a.alignmentScore >= 7 ? 'high' : a.alignmentScore >= 5 ? 'mid' : 'low'}">${a.alignmentScore}/10</div>
      </div>
      <div class="align-summary">${escapeHtml(a.summary || '')}</div>
      ${a.topStrengths?.length ? `
        <div class="align-section">
          <div class="align-h">What's working</div>
          <ul>${a.topStrengths.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
        </div>
      ` : ''}
      ${a.areasToStrengthen?.length ? `
        <div class="align-section">
          <div class="align-h">Worth highlighting more</div>
          <ul>${a.areasToStrengthen.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
        </div>
      ` : ''}
      ${a.suggestedBullets?.length ? `
        <div class="align-section">
          <div class="align-h">Suggested bullets</div>
          <ul>${a.suggestedBullets.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
        </div>
      ` : ''}
    </div>
  `;
}

function renderCoverAlignment(a) {
  if (a.error) {
    return `<div class="align-box err">Cover letter scoring error: ${escapeHtml(a.error)}</div>`;
  }
  const overall = typeof a.overallScore === 'number' ? a.overallScore : 0;
  const cls = overall >= 7 ? 'high' : overall >= 5 ? 'mid' : 'low';
  return `
    <div class="align-box">
      <div class="align-head">
        <div class="align-label">Cover letter vs JD</div>
        <div class="align-score align-${cls}">${overall}/10</div>
      </div>
      ${(typeof a.relevanceScore === 'number' || typeof a.toneScore === 'number') ? `
        <div class="align-summary">
          ${typeof a.relevanceScore === 'number' ? `Relevance: <strong>${a.relevanceScore}/10</strong>` : ''}${(typeof a.relevanceScore === 'number' && typeof a.toneScore === 'number') ? ' · ' : ''}${typeof a.toneScore === 'number' ? `Tone: <strong>${a.toneScore}/10</strong>` : ''}
        </div>
      ` : ''}
      ${a.strengths?.length ? `
        <div class="align-section">
          <div class="align-h">What's working</div>
          <ul>${a.strengths.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
        </div>
      ` : ''}
      ${a.suggestions?.length ? `
        <div class="align-section">
          <div class="align-h">Suggestions</div>
          <ul>${a.suggestions.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
        </div>
      ` : ''}
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
      openPreview(fingerprint, btn.dataset.file);
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

// ---------- Preview overlay ----------

let previewBackdrop = null;

function openPreview(fingerprint, filename) {
  if (!previewBackdrop) {
    previewBackdrop = document.createElement('div');
    previewBackdrop.className = 'preview-backdrop';
    previewBackdrop.innerHTML = `
      <div class="preview-frame">
        <div class="preview-head">
          <div class="preview-title" id="preview-title"></div>
          <button class="modal-close" id="preview-close">×</button>
        </div>
        <iframe class="preview-iframe" id="preview-iframe" src="about:blank"></iframe>
      </div>
    `;
    document.body.appendChild(previewBackdrop);
    previewBackdrop.addEventListener('click', (e) => {
      if (e.target === previewBackdrop) closePreview();
    });
    previewBackdrop.querySelector('#preview-close').addEventListener('click', closePreview);
  }
  $('#preview-title').textContent = filename;
  $('#preview-iframe').src = `/api/documents/${fingerprint}/file/${filename}?inline=1`;
  previewBackdrop.classList.add('open');
}

function closePreview() {
  if (!previewBackdrop) return;
  previewBackdrop.classList.remove('open');
  $('#preview-iframe').src = 'about:blank';
}
