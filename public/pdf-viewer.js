// public/pdf-viewer.js
// Renders a PDF with selectable text + click-to-highlight overlays. Wraps
// pdfjs-dist (vendored at /vendor/pdfjs/) so the only consumer
// (profile.js's feedback panel) doesn't need to know about workers,
// viewports, or text-layer math.
//
// Usage:
//   const ctrl = await renderPdfWithHighlights({
//     container,         // DOM element to render into
//     pdfUrl,            // URL the browser fetches the PDF from
//     findings,          // [{id, page, quote, severity}]
//     onFindingFocus,    // fn(id, source) called on hover/click of an overlay
//   });
//   ctrl.scrollToFinding(id)   // jump the viewer to a finding
//   ctrl.setActive(id)         // visually pulse an overlay (e.g. from panel hover)
//   ctrl.setScale(scale)       // re-render at a new scale (zoom)
//   ctrl.getScale()            // current scale
//   ctrl.getFitScale()         // recompute fit-to-width scale

import * as pdfjs from '/vendor/pdfjs/pdf.mjs';
import { scrollToEl } from './app.js';

pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';

// Fit-width and zoom bounds. MIN keeps text readable on cramped screens;
// MAX caps explicit zoom so a user can't crank scale beyond what the
// canvas memory budget can handle on phones.
const MIN_SCALE = 0.5;
const MAX_SCALE = 3.0;
// When auto-fitting to container width, the initial scale never exceeds
// this cap — keeps the PDF from rendering uselessly large on wide
// monitors. Users can still explicitly zoom past it via setScale().
const FIT_SCALE_CAP = 1.8;
// Slack for the .pdf-page box-shadow / margins so the visual rendering
// doesn't kiss the container edge — feels tight at the modal boundary.
const HORIZONTAL_SLACK_PX = 12;

export async function renderPdfWithHighlights({ container, pdfUrl, findings = [], onFindingFocus = () => {} }) {
  container.innerHTML = '<div class="pdf-loading"><span class="spinner sm"></span> Rendering résumé…</div>';

  // Each step wraps in try/catch with explicit context so a Safari-style
  // truncated error message still tells us WHICH pdfjs call failed.
  const step = async (label, fn) => {
    try { return await fn(); } catch (err) {
      console.error(`[pdf-viewer] step "${label}" failed:`, err);
      throw new Error(`${label}: ${err?.message || String(err)}`);
    }
  };

  console.log('[pdf-viewer] start, pdfjs version:', pdfjs.version, 'workerSrc:', pdfjs.GlobalWorkerOptions.workerSrc);

  const pdf = await step('getDocument', async () => {
    const loadingTask = pdfjs.getDocument(pdfUrl);
    return await loadingTask.promise;
  });
  console.log('[pdf-viewer] loaded:', pdf.numPages, 'pages');

  // Cache page 1 for the fit-scale measurement; re-fetch others on demand
  // each render (pdfjs caches internally, so this is cheap).
  const firstPage = await step('getPage(1)', () => pdf.getPage(1));
  const unscaled = firstPage.getViewport({ scale: 1 });

  function computeFitScale() {
    const availableWidth = Math.max(container.clientWidth - HORIZONTAL_SLACK_PX, 200);
    const fit = availableWidth / unscaled.width;
    return Math.max(MIN_SCALE, Math.min(fit, FIT_SCALE_CAP));
  }

  // Mutable state — current scale, current pages array, current
  // findingIndex map. Reassigned on each paint(). Methods on the returned
  // controller use closure references so they always see the latest state. */
  let currentScale = computeFitScale();
  let pages = [];
  let findingIndex = new Map();

  async function paint(scale) {
    container.innerHTML = '';
    pages = [];
    findingIndex = new Map();

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      // Reuse page 1; let pdfjs internal caching deduplicate the rest.
      const page = pageNum === 1 ? firstPage : await step(`getPage(${pageNum})`, () => pdf.getPage(pageNum));
      const viewport = await step(`getViewport(${pageNum})`, () => page.getViewport({ scale }));

      const pageEl = document.createElement('div');
      pageEl.className = 'pdf-page';
      pageEl.dataset.pageNumber = String(pageNum);
      pageEl.style.width = `${viewport.width}px`;
      pageEl.style.height = `${viewport.height}px`;

      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      pageEl.appendChild(canvas);

      const textLayer = document.createElement('div');
      // textLayer is pdfjs's own class name — its CSS in profile.html sets
      // the transform vars TextLayer relies on. Don't rename without also
      // updating those rules.
      textLayer.className = 'textLayer';
      textLayer.style.width = `${viewport.width}px`;
      textLayer.style.height = `${viewport.height}px`;
      pageEl.appendChild(textLayer);

      const overlayLayer = document.createElement('div');
      overlayLayer.className = 'pdf-highlight-layer';
      pageEl.appendChild(overlayLayer);

      container.appendChild(pageEl);

      await step(`render(${pageNum})`, () =>
        page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise);

      // Pass the ReadableStream directly to TextLayer rather than calling
      // page.getTextContent() — getTextContent does `for await (const v of
      // stream)` internally, and Safari doesn't implement async iteration on
      // ReadableStream. TextLayer's render() uses the explicit .getReader()
      // API, which Safari supports.
      await step(`TextLayer(${pageNum})`, async () => {
        const tl = new pdfjs.TextLayer({
          textContentSource: page.streamTextContent(),
          container: textLayer,
          viewport,
        });
        await tl.render();
      });

      pages.push({ pageNum, pageEl, textLayer, overlayLayer, viewport });
    }

    // Once every page's text layer exists, find each finding's quote and
    // paint overlay rects on top.
    for (const f of findings) {
      if (!f.quote || !f.page) continue;
      const target = pages.find((p) => p.pageNum === f.page);
      if (!target) continue;
      const rects = locateQuoteRects(target, f.quote);
      if (rects.length === 0) continue;
      const elements = drawOverlayRects(target, f, rects);
      findingIndex.set(f.id, { pageEl: target.pageEl, elements });
    }

    // Wire interactions — hover + click on any overlay rect.
    for (const [id, { elements }] of findingIndex) {
      for (const el of elements) {
        el.addEventListener('mouseenter', () => onFindingFocus(id, 'hover'));
        el.addEventListener('mouseleave', () => onFindingFocus(null, 'hover'));
        el.addEventListener('click', () => onFindingFocus(id, 'click'));
      }
    }

    currentScale = scale;
  }

  const ctrl = {
    get pdf() { return pdf; },
    get pages() { return pages; },
    get findingIndex() { return findingIndex; },
    scrollToFinding(id) {
      const entry = findingIndex.get(id);
      if (!entry || entry.elements.length === 0) return;
      scrollToEl(entry.elements[0]);
    },
    setActive(id) {
      // Pulse the matching overlay rects; clear others.
      for (const [otherId, { elements }] of findingIndex) {
        for (const el of elements) el.classList.toggle('is-active', otherId === id);
      }
    },
    // Re-render all pages at the new scale. Brief blank flash while
    // canvases re-paint (~150–400ms for a 1–2 page résumé). Clamps to
    // [MIN_SCALE, MAX_SCALE]. No-op when scale is within 1% of current.
    // Dispatches a 'pdf-zoom' event on the container so external
    // listeners (e.g. the zoom-bar label in profile.js) stay in sync
    // regardless of who called setScale — buttons, wheel, or future
    // gestures like pinch.
    async setScale(scale) {
      const clamped = Math.max(MIN_SCALE, Math.min(scale, MAX_SCALE));
      if (Math.abs(clamped - currentScale) < 0.01) return;
      await paint(clamped);
      container.dispatchEvent(new CustomEvent('pdf-zoom', { detail: { scale: currentScale } }));
    },
    getScale() { return currentScale; },
    getFitScale: computeFitScale,
    MIN_SCALE,
    MAX_SCALE,
  };

  await paint(currentScale);
  wireDragPan(container);
  wireWheelZoom(container, ctrl);

  return ctrl;
}

// Walks the text-layer spans on a page, finds where the quote occurs in
// the concatenated text, and returns the bounding rects (one per visual
// line — multi-line matches yield multiple rects). Tolerates whitespace
// collapsing inside the PDF's extracted text by normalizing both sides.
function locateQuoteRects({ textLayer, pageEl }, quote) {
  // pdfjs v4+ renders text into <span> children, possibly nested under
  // <span class="markedContent">. Grab any leaf span whose first child
  // is a text node — that gives us the actual visible-text-bearing spans.
  const spans = Array.from(textLayer.querySelectorAll('span'))
    .filter((s) => s.firstChild?.nodeType === Node.TEXT_NODE && s.firstChild.textContent.length > 0);
  if (spans.length === 0) return [];

  // Build a flat representation: each character in `flat` records the span
  // it came from and its index within that span.
  const norm = (s) => s.replace(/\s+/g, ' ');
  const needle = norm(quote).trim().toLowerCase();
  if (!needle) return [];

  let flat = '';
  const charMap = []; // each entry: { span, charIndex }
  for (const span of spans) {
    const raw = norm(span.textContent || '');
    for (let i = 0; i < raw.length; i++) {
      flat += raw[i].toLowerCase();
      charMap.push({ span, charIndex: i, raw });
    }
    // Spans don't always carry trailing whitespace, but visual breaks
    // between them usually imply one. Insert a soft space so quotes that
    // straddle span boundaries still match.
    if (raw.length > 0 && !raw.endsWith(' ')) {
      flat += ' ';
      charMap.push({ span: null, charIndex: -1, raw: ' ' });
    }
  }

  const idx = flat.indexOf(needle);
  if (idx < 0) return [];

  // Walk the charMap covering [idx, idx + needle.length) and collect the
  // unique spans touched, in order.
  const touchedSpans = [];
  const seen = new Set();
  for (let i = idx; i < idx + needle.length && i < charMap.length; i++) {
    const entry = charMap[i];
    if (!entry?.span) continue;
    if (!seen.has(entry.span)) {
      seen.add(entry.span);
      touchedSpans.push(entry.span);
    }
  }
  if (touchedSpans.length === 0) return [];

  // Get bounding rects relative to the page element so overlay divs can
  // be absolutely positioned within .pdf-page using simple top/left/etc.
  const pageRect = pageEl.getBoundingClientRect();
  return touchedSpans.map((span) => {
    const r = span.getBoundingClientRect();
    return {
      top: r.top - pageRect.top,
      left: r.left - pageRect.left,
      width: r.width,
      height: r.height,
    };
  });
}

// Click-and-drag panning on the scroll container. A 5px movement
// threshold separates "click" (text selection / highlight click) from
// "drag" (pan). Below the threshold, default behaviors run unchanged.
// Past it, we steal the gesture, clear any incidental text selection,
// capture the pointer, and translate movement into scroll deltas.
// Touch is excluded — native overflow-scroll already pans on touch and
// taking over would suppress momentum / pinch handling.
function wireDragPan(scrollContainer) {
  let startX = 0;
  let startY = 0;
  let startScrollL = 0;
  let startScrollT = 0;
  let panning = false;
  let activePointerId = null;
  const THRESHOLD_PX = 5;

  scrollContainer.addEventListener('pointerdown', (e) => {
    // Mouse-only — touch/pen use native scroll.
    if (e.pointerType !== 'mouse') return;
    if (e.button !== 0) return;
    // Let the zoom toolbar + finding highlights handle their own clicks
    // without pan interference.
    if (e.target.closest('.pdf-zoom-bar, .pdf-highlight')) return;
    startX = e.clientX;
    startY = e.clientY;
    startScrollL = scrollContainer.scrollLeft;
    startScrollT = scrollContainer.scrollTop;
    activePointerId = e.pointerId;
    panning = false;
  });

  scrollContainer.addEventListener('pointermove', (e) => {
    if (e.pointerId !== activePointerId) return;
    // pointermove fires while hovering too; only act when primary button
    // is held. e.buttons bit 1 = left button.
    if ((e.buttons & 1) !== 1) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!panning && Math.hypot(dx, dy) > THRESHOLD_PX) {
      panning = true;
      scrollContainer.classList.add('is-panning');
      // Clear any text selection that started before the threshold.
      window.getSelection()?.removeAllRanges();
      try { scrollContainer.setPointerCapture(activePointerId); } catch (_) { /* unsupported */ }
    }
    if (panning) {
      e.preventDefault();
      scrollContainer.scrollLeft = startScrollL - dx;
      scrollContainer.scrollTop = startScrollT - dy;
    }
  });

  const release = (e) => {
    if (e && e.pointerId !== activePointerId) return;
    if (panning) {
      scrollContainer.classList.remove('is-panning');
      try { scrollContainer.releasePointerCapture(activePointerId); } catch (_) { /* unsupported */ }
    }
    panning = false;
    activePointerId = null;
  };
  scrollContainer.addEventListener('pointerup', release);
  scrollContainer.addEventListener('pointercancel', release);
}

// Ctrl/Cmd + wheel zoom with cursor anchoring. Plain wheel without
// modifier passes through to native scroll (so the user can still pan
// vertically through pages). Anchored zoom: the document point under
// the cursor stays under the cursor across the scale change — gives
// the natural "zoom toward what I'm looking at" feel. Rapid wheel
// events coalesce into a single render per cycle via pendingScale.
function wireWheelZoom(scrollContainer, ctrl) {
  const STEP = 0.1;
  let renderInFlight = false;
  let pendingScale = null;
  let pendingAnchor = null;

  scrollContainer.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();

    // Latest desired scale based on either the current rendered scale
    // (idle) or whatever's already queued (mid-cycle).
    const base = pendingScale !== null ? pendingScale : ctrl.getScale();
    const direction = e.deltaY < 0 ? 1 : -1;
    pendingScale = Math.max(ctrl.MIN_SCALE, Math.min(ctrl.MAX_SCALE, base + direction * STEP));
    pendingAnchor = { x: e.clientX, y: e.clientY };

    if (renderInFlight) return;
    runZoomLoop();
  }, { passive: false });

  async function runZoomLoop() {
    renderInFlight = true;
    while (pendingScale !== null) {
      const targetScale = pendingScale;
      const anchor = pendingAnchor;
      pendingScale = null;
      pendingAnchor = null;

      // Capture the document point under the cursor BEFORE re-render.
      // Convert from "cursor position within container viewport" to a
      // scale-independent document coordinate, then back to scroll
      // offsets at the new scale.
      const oldScale = ctrl.getScale();
      const rect = scrollContainer.getBoundingClientRect();
      const cursorL = anchor.x - rect.left;
      const cursorT = anchor.y - rect.top;
      const docX = (scrollContainer.scrollLeft + cursorL) / oldScale;
      const docY = (scrollContainer.scrollTop + cursorT) / oldScale;

      await ctrl.setScale(targetScale);

      // After render, restore scroll so docX/docY ends up back under
      // the cursor. Use the actual rendered scale (might be clamped).
      const newScale = ctrl.getScale();
      scrollContainer.scrollLeft = docX * newScale - cursorL;
      scrollContainer.scrollTop = docY * newScale - cursorT;
    }
    renderInFlight = false;
  }
}

function drawOverlayRects({ overlayLayer }, finding, rects) {
  const elements = [];
  // Pad slightly so the highlight reads as a block underline rather than a
  // tight character-fit. 2px top/bottom feels right at this scale.
  for (const r of rects) {
    const el = document.createElement('div');
    el.className = 'pdf-highlight';
    el.dataset.findingId = finding.id;
    el.dataset.severity = finding.severity || 'minor';
    el.style.top = `${r.top - 2}px`;
    el.style.left = `${r.left - 1}px`;
    el.style.width = `${r.width + 2}px`;
    el.style.height = `${r.height + 4}px`;
    overlayLayer.appendChild(el);
    elements.push(el);
  }
  return elements;
}
