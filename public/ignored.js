// public/ignored.js — drives the Ignored page.
//
// Extracted from an inline <script type="module"> block so the Ignored
// page follows the same load pattern as Profile, Settings, and Roles
// (HTML + same-named JS sibling). No behavior change.

import { $, $$, escapeHtml, api, fmtSalary, fmtDateLong, scoreClass } from './app.js';
import { openModal } from './components/modal.js';

// Labels for both reject-reason vocabularies (modal chips + card chips).
const REASON_LABELS = {
  'not-a-fit': 'Not a fit',
  'salary': 'Salary too low',
  'location': 'Location',
  'too-senior': 'Too senior',
  'too-junior': 'Too junior',
  'already-applied': 'Already applied',
  'wrong-location': 'Wrong location',
  'wrong-seniority': 'Wrong level',
  'not-interested': 'Not interested',
  'other': 'Other',
};

let allListings = [];

function reasonLabel(reason) {
  if (!reason) return null;
  return REASON_LABELS[reason] || reason;
}

function rowHtml(l) {
  const overall = l.score?.overallScore ?? 0;
  const reason = reasonLabel(l.rejectReason);
  const id = l.dedupKey || l.fingerprint;
  return `
    <article class="ignored-row" data-id="${escapeHtml(id)}">
      <div class="ignored-row-main">
        <div class="ignored-row-head">
          <div class="ignored-row-title">
            <div class="cell-title">${escapeHtml(l.title)}</div>
            <div class="cell-company">${escapeHtml(l.company)}${l.location ? ' · ' + escapeHtml(l.location) : ''}</div>
          </div>
          <div class="score-num ${scoreClass(overall)}">${overall}</div>
        </div>
        <div class="ignored-row-meta">
          <span>${fmtSalary(l.score?.salaryMin, l.score?.salaryMax)}</span>
          ${l.rejectAt ? `<span>Ignored ${fmtDateLong(l.rejectAt)}</span>` :
            l.ingestedAt ? `<span>Seen ${fmtDateLong(l.ingestedAt)}</span>` : ''}
          ${l.source ? `<span>${escapeHtml(l.source)}</span>` : ''}
        </div>
        ${reason || l.rejectNote ? `
          <div class="ignored-row-reason">
            ${reason ? `<span class="reason-tag reason-tag-${escapeHtml(l.rejectReason)}">${escapeHtml(reason)}</span>` : ''}
            ${l.rejectNote ? `<span class="reason-note">${escapeHtml(l.rejectNote)}</span>` : ''}
          </div>
        ` : ''}
        ${l.note ? `<div class="ignored-row-note">${escapeHtml(l.note)}</div>` : ''}
      </div>
    </article>
  `;
}

function render() {
  const list = $('#list');
  const empty = $('#empty');
  if (allListings.length === 0) {
    list.style.display = 'none';
    empty.style.display = '';
    $('#sub').textContent = '0 listings';
    return;
  }
  list.style.display = '';
  empty.style.display = 'none';

  // Group by reason (with a tail bucket for entries with no reason set).
  const groups = new Map();
  const NO_REASON = '__none__';
  for (const l of allListings) {
    const k = l.rejectReason || NO_REASON;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  }

  // Order: sized buckets desc, "no reason" last.
  const entries = Array.from(groups.entries())
    .filter(([k]) => k !== NO_REASON)
    .sort((a, b) => b[1].length - a[1].length);
  if (groups.has(NO_REASON)) entries.push([NO_REASON, groups.get(NO_REASON)]);

  list.innerHTML = entries.map(([reason, items]) => {
    const label = reason === NO_REASON ? 'No reason given' : reasonLabel(reason);
    return `
      <section class="ignored-group">
        <h2 class="ignored-group-head">
          <span>${escapeHtml(label)}</span>
          <span class="ignored-group-count">${items.length}</span>
        </h2>
        <div class="ignored-group-body">
          ${items.map(rowHtml).join('')}
        </div>
      </section>
    `;
  }).join('');

  $$('.ignored-row', list).forEach((row) => {
    row.addEventListener('click', () => {
      const id = row.dataset.id;
      const listing = allListings.find((l) => (l.dedupKey || l.fingerprint) === id);
      if (listing) openModal(listing, onListingUpdated);
    });
  });

  $('#sub').textContent = `${allListings.length} listing${allListings.length === 1 ? '' : 's'}`;
}

function onListingUpdated(updated) {
  const updatedKey = updated.dedupKey || updated.fingerprint;
  const idx = allListings.findIndex((l) => (l.dedupKey || l.fingerprint) === updatedKey);
  if (idx < 0) return;
  // If user moved it back out of "rejected", drop from this view.
  if ((updated.status || 'new') !== 'rejected') {
    allListings.splice(idx, 1);
  } else {
    allListings[idx] = { ...allListings[idx], ...updated };
  }
  render();
}

async function load() {
  // Synchronous fast-path: server-side inline of GET /ignored.html drops
  // the dataset on window.__INITIAL so we can render before any fetch
  // fires. Falls through to the network path if the inline didn't happen
  // (direct asset reload, fallback path in routes/page.js, etc.)
  const initial = typeof window !== 'undefined' ? window.__INITIAL : null;
  if (initial?.listings?.listings) {
    allListings = initial.listings.listings;
    render();
    return;
  }
  try {
    const data = await api('/api/listings/ignored');
    allListings = data.listings || [];
    render();
  } catch (err) {
    $('#sub').textContent = `Failed to load: ${err.message}`;
  }
}

load();
