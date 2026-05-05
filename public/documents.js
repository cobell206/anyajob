// public/documents.js — application materials section in the listing modal

import { $, escapeHtml, api } from './app.js';

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
  const alignBadge = (align && typeof align.alignmentScore === 'number')
    ? `<span class="doc-align align-${align.alignmentScore >= 7 ? 'high' : align.alignmentScore >= 5 ? 'mid' : 'low'}">${align.alignmentScore}/10 fit</span>`
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
      ${docs.resume?.current?.alignmentScore ? renderAlignment(docs.resume.current.alignmentScore) : ''}
      <input type="file" id="doc-file-input" accept="${ALLOWED}" style="display:none">
    </div>
  `;
  return html;
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
    status.textContent = `Uploading ${file.name}…`;
    status.className = 'docs-status info';

    try {
      const res = await fetch(`/api/documents/${fingerprint}/upload`, {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Upload failed');
      }
      const data = await res.json();
      status.textContent = data.alignmentScore ? '✓ Uploaded and scored' : '✓ Uploaded';
      status.className = 'docs-status success';
      setTimeout(() => refresh?.(), 400);
    } catch (err) {
      status.textContent = 'Upload failed: ' + err.message;
      status.className = 'docs-status error';
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

  container.querySelectorAll('[data-action="delete-other"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this document?')) return;
      await api(`/api/documents/${fingerprint}/delete`, {
        method: 'POST',
        body: { slot: 'other', file: btn.dataset.file },
      });
      refresh?.();
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
