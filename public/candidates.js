// public/candidates.js — shared source-candidate card renderer.
//
// Two consumers right now:
//   1. settings.js → renders the "Pending review" list inside the Sources
//      accordion, plus the "Find new sources" live-discovery results.
//   2. review-candidates-modal.js → renders the same cards inside a modal
//      surfaced from the roles page so she can review without navigating.
//
// Kept here (rather than re-implementing in each call site) so the two
// surfaces can't drift on copy, layout, or which fields are surfaced.

import { escapeHtml } from './app.js';

// Render a single candidate card. The action buttons differ per caller —
// live discovery uses position-indexed approve buttons (cands aren't
// persisted in the response), pending-review uses the candidate id — so
// callers pass actionsHtml + a dataAttr instead of us prescribing.
export function renderCandidateCard(c, { actionsHtml, dataAttr = '' }) {
  const isStructured = c.kind === 'greenhouse' || c.kind === 'lever';
  // Slug is the canonical identifier for structured sources, so we surface
  // it as one short line of metadata. The standalone URL line was dropped:
  // the name itself is now the link, with a small external-link glyph
  // inline. One affordance to the source, not two, and the long URL
  // string no longer eats half the card's height.
  const slugLine = isStructured && c.config?.slug
    ? `<div class="source-meta">slug: ${escapeHtml(c.config.slug)}</div>`
    : '';
  const url = c.url || c.config?.url;
  const nameInner = url
    ? `<a class="candidate-name-link" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="${escapeHtml(url)}" aria-label="${escapeHtml(c.name)} (opens in new tab)">${escapeHtml(c.name)}<svg class="ext-link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" aria-hidden="true"><path d="M7 17 17 7"/><path d="M9 7h8v8"/></svg></a>`
    : escapeHtml(c.name);
  // Confidence chip rides in the header row to the right of the name. The
  // word "confidence" is dropped — context (the badge color + position next
  // to a discovery suggestion) makes "HIGH" / "MEDIUM" / "LOW" unambiguous.
  const conf = c.confidence;
  const confBadge = conf
    ? `<span class="confidence-badge confidence-${escapeHtml(conf)}" title="${escapeHtml(conf)} confidence">${escapeHtml(conf)}</span>`
    : '';
  const rationale = c.rationale
    ? `<div class="candidate-rationale">${escapeHtml(c.rationale)}</div>`
    : '';
  const overlapWarning = c.overlapsWith
    ? `<div class="candidate-overlap">⚠ Overlaps with smartfetch source <strong>${escapeHtml(c.overlapsWith.name)}</strong>. Adding this would cause double-fetching — consider disabling that source after.</div>`
    : '';
  // Kind badge is only shown for bookmarks — they behave differently (no
  // auto-fetch, surfaced on a cadence) and that's a decision-relevant fact
  // for her before approving. Auto-fetching kinds (greenhouse, lever,
  // smartfetch) don't need a badge: behavior is uniform.
  const kindTag = c.kind === 'bookmark'
    ? '<span class="kind-badge kind-bookmark">Manual</span>'
    : '';
  return `
    <div class="source-card candidate-card"${dataAttr}>
      <div class="candidate-header">
        <div class="candidate-header-text">
          ${kindTag}
          <div class="source-name">${nameInner}</div>
          ${confBadge}
        </div>
        <div class="candidate-actions">${actionsHtml}</div>
      </div>
      ${slugLine}
      ${rationale}
      ${overlapWarning}
    </div>
  `;
}
