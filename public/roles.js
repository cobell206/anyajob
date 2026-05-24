// public/roles.js — drives the Roles page (index.html).
//
// Extracted from an inline <script type="module"> block so the Roles
// page follows the same load pattern as Profile, Settings, and Ignored
// (HTML + same-named JS sibling). No behavior change.

import { $, $$, escapeHtml, api, fmtSalary, fmtDate, scoreClass, STATUSES, SVG_THUMB_UP, SVG_THUMB_DOWN } from './app.js';
import { openModal } from './modal.js';
import { openAddRoleModal } from './add-role-modal.js';
import { openReviewCandidatesModal } from './review-candidates-modal.js';

let allListings = [];
let sortKey = 'score';
let sortDir = 'desc';
let currentView = localStorage.getItem('rolesView') === 'kanban' ? 'kanban' : 'table';

// First render gets a staggered entrance (rowIn keyframe in style.css).
// Subsequent re-renders from sort/filter/status-change skip the cascade,
// otherwise every interaction feels like a fresh page load. Capped at
// STAGGER_CAP rows so a big day doesn't take 2 seconds to reveal.
let firstRenderDone = false;
const STAGGER_CAP = 8;

const DEFAULT_FILTERS = {
  status: 'all',     // 'all' | one of STATUSES values
  search: '',        // matches title/company/location, case-insensitive
  minScore: 0,       // 0-10
  minSalary: 0,      // dollars; matches against salaryMax || salaryMin
  sources: [],       // empty = all sources; otherwise listing.source must be in list
  rating: 'any',     // 'any' | 'up' | 'down' | 'unrated'
  closingSoon: false,// saved/applied/interview with closesDate within 7 days
};
let filters = { ...DEFAULT_FILTERS };

function getSortValue(l, key) {
  switch (key) {
    case 'score': return l.score?.overallScore ?? 0;
    case 'title': return (l.title || '').toLowerCase();
    case 'company': return (l.company || '').toLowerCase();
    case 'location': return (l.location || '').toLowerCase();
    case 'salary': return l.score?.salaryMax || l.score?.salaryMin || 0;
    case 'status': return l.status || 'new';
    default: return 0;
  }
}

function applyFiltersAndSort(listings) {
  // Ignored listings live on /ignored.html and never appear in the main
  // table/kanban — keep this exclusion ahead of any user filter so the
  // status pill (if it ever sneaks back) can't surface them.
  let out = listings.filter((l) => (l.status || 'new') !== 'rejected');
  if (filters.status !== 'all') {
    out = out.filter((l) => (l.status || 'new') === filters.status);
  }
  if (filters.search) {
    const q = filters.search.toLowerCase();
    out = out.filter((l) =>
      (l.title || '').toLowerCase().includes(q) ||
      (l.company || '').toLowerCase().includes(q) ||
      (l.location || '').toLowerCase().includes(q)
    );
  }
  if (filters.minScore > 0) {
    out = out.filter((l) => (l.score?.overallScore ?? 0) >= filters.minScore);
  }
  if (filters.minSalary > 0) {
    out = out.filter((l) => {
      const sal = l.score?.salaryMax ?? l.score?.salaryMin ?? 0;
      return sal >= filters.minSalary;
    });
  }
  if (filters.sources.length > 0) {
    const set = new Set(filters.sources);
    out = out.filter((l) => set.has(l.source));
  }
  if (filters.rating !== 'any') {
    out = out.filter((l) => {
      if (filters.rating === 'unrated') return !l.rating;
      return l.rating === filters.rating;
    });
  }
  if (filters.closingSoon) {
    const now = Date.now();
    const cutoff = now + 7 * 86400000;
    out = out.filter((l) => {
      const status = l.status || 'new';
      if (!['saved', 'applied', 'interview'].includes(status)) return false;
      const closes = l.closesDate || l.score?.closesDate;
      if (!closes) return false;
      const t = new Date(closes).getTime();
      return !isNaN(t) && t >= now && t <= cutoff;
    });
  }
  out.sort((a, b) => {
    const av = getSortValue(a, sortKey);
    const bv = getSortValue(b, sortKey);
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });
  return out;
}

function activeFilterCount() {
  let n = 0;
  if (filters.status !== 'all') n++;
  if (filters.search) n++;
  if (filters.minScore > 0) n++;
  if (filters.minSalary > 0) n++;
  if (filters.sources.length > 0) n++;
  if (filters.rating !== 'any') n++;
  if (filters.closingSoon) n++;
  return n;
}

function fmtKShort(n) {
  if (!n) return '0';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

function scoreCell(l) {
  const overall = l.score?.overallScore ?? 0;
  const qual = l.score?.qualificationFit ?? 0;
  const lsv = l.score?.lawSchoolValue ?? 0;
  return `
    <div class="score-cell" role="group" aria-label="Overall score ${overall} of 10. Qualification fit ${qual} of 10. Law school value ${lsv} of 10.">
      <div class="score-num ${scoreClass(overall)}" aria-hidden="true">${overall}</div>
      <div class="score-bars" aria-hidden="true">
        <div class="score-bar qual" title="Qualification fit: ${qual}/10"><div class="score-bar-fill" style="width:${qual * 10}%"></div></div>
        <div class="score-bar value" title="Law school value: ${lsv}/10"><div class="score-bar-fill" style="width:${lsv * 10}%"></div></div>
      </div>
    </div>
  `;
}

function statusBadge(status) {
  const s = status || 'new';
  const label = STATUSES.find((x) => x.value === s)?.label || s;
  return `<span class="status-badge status-${s}">${label}</span>`;
}

function isNewListing(l) {
  if (!l.ingestedAt) return false;
  const t = new Date(l.ingestedAt).getTime();
  return !isNaN(t) && Date.now() - t < 24 * 60 * 60 * 1000;
}

function renderTable(listings) {
  const tbody = $('#tbody');
  const stagger = !firstRenderDone;
  tbody.innerHTML = listings.map((l, i) => {
    const entering = stagger && i < STAGGER_CAP ? ` is-entering" style="--i:${i}` : '';
    return `
    <tr class="listing-row${isNewListing(l) ? ' is-new' : ''}${entering}" data-id="${escapeHtml(l.dedupKey || l.fingerprint)}">
      <td>${scoreCell(l)}</td>
      <td>
        <div class="cell-title">${escapeHtml(l.title)}</div>
        ${l.score?.workMode ? `<div class="cell-sub">${escapeHtml(l.score.workMode)}</div>` : ''}
      </td>
      <td><span class="cell-company">${escapeHtml(l.company)}</span></td>
      <td><span class="cell-location">${escapeHtml(l.location || '—')}</span></td>
      <td><span class="cell-salary">${fmtSalary(l.score?.salaryMin, l.score?.salaryMax)}</span></td>
      <td>${statusBadge(l.status)}</td>
    </tr>
  `;
  }).join('');

  $$('tr', tbody).forEach((tr) => {
    tr.addEventListener('click', () => {
      const id = tr.dataset.id;
      const listing = allListings.find((l) => (l.dedupKey || l.fingerprint) === id);
      if (listing) openModal(listing, onListingUpdated);
    });
  });

  $$('th[data-sort]').forEach((th) => {
    th.classList.remove('sorted', 'asc');
    if (th.dataset.sort === sortKey) {
      th.classList.add('sorted');
      if (sortDir === 'asc') th.classList.add('asc');
    }
  });
}

function renderCards(listings) {
  const cards = $('#cards');
  const stagger = !firstRenderDone;
  cards.innerHTML = listings.map((l, i) => {
    const overall = l.score?.overallScore ?? 0;
    const entering = stagger && i < STAGGER_CAP ? ` is-entering" style="--i:${i}` : '';
    return `
      <div class="card${isNewListing(l) ? ' is-new' : ''}${entering}" data-id="${escapeHtml(l.dedupKey || l.fingerprint)}">
        <div class="card-row">
          <div style="flex:1;min-width:0">
            <div class="cell-title" style="margin-bottom:2px">${escapeHtml(l.title)}</div>
            <div class="cell-company">${escapeHtml(l.company)}</div>
          </div>
          <div class="score-num lg ${scoreClass(overall)}">${overall}</div>
        </div>
        <div class="card-meta">
          <span>${escapeHtml(l.location || '—')}</span>
          <span>${fmtSalary(l.score?.salaryMin, l.score?.salaryMax)}</span>
          ${l.closesDate ? `<span>Closes ${fmtDate(l.closesDate)}</span>` : ''}
        </div>
        <div class="card-foot">
          ${statusBadge(l.status)}
          ${l.rating === 'up' ? `<span class="rating-thumb up" aria-label="Liked">${SVG_THUMB_UP}</span>` :
            l.rating === 'down' ? `<span class="rating-thumb down" aria-label="Disliked">${SVG_THUMB_DOWN}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');

  $$('.card', cards).forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.reject-reason-bar')) return;
      const id = card.dataset.id;
      const listing = allListings.find((l) => (l.dedupKey || l.fingerprint) === id);
      if (listing) openModal(listing, onListingUpdated);
    });
  });

  // Re-attach any pending reject-reason bars (survives card re-render).
  for (const fp of pendingRejectReason.keys()) {
    const card = cards.querySelector(`.card[data-id="${cssEscape(fp)}"]`);
    if (card) attachRejectReasonBar(card, fp);
  }
}

// ----- Reject-reason bar -----

const REJECT_CHIPS = [
  { value: 'wrong-location',  label: '📍 Wrong location' },
  { value: 'wrong-seniority', label: '📊 Wrong level' },
  { value: 'not-interested',  label: '😐 Not interested' },
  { value: 'already-applied', label: '✅ Already applied' },
  { value: 'other',           label: '✏️ Other…' },
];

// fp -> { timeoutId } — listings whose cards should currently show the bar.
const pendingRejectReason = new Map();

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"');
}

function dismissRejectReason(fp) {
  const entry = pendingRejectReason.get(fp);
  if (entry?.timeoutId) clearTimeout(entry.timeoutId);
  pendingRejectReason.delete(fp);
  const bar = $(`.reject-reason-bar[data-fp="${cssEscape(fp)}"]`);
  if (bar) bar.remove();
}

async function postRejectReason(fp, reason, note) {
  try {
    await api(`/api/feedback/${encodeURIComponent(fp)}/reject-reason`, {
      method: 'POST',
      body: { reason, note: note || '' },
    });
  } catch (err) {
    console.error('reject-reason save failed', err);
  }
}

function flashNotedThenDismiss(bar, fp) {
  bar.innerHTML = '<span class="reject-noted">✓ noted</span>';
  const t = setTimeout(() => dismissRejectReason(fp), 700);
  const entry = pendingRejectReason.get(fp);
  if (entry) {
    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    entry.timeoutId = t;
  }
}

function attachRejectReasonBar(card, fp) {
  // Avoid duplicates if re-rendered while present.
  const existing = card.querySelector('.reject-reason-bar');
  if (existing) existing.remove();

  const bar = document.createElement('div');
  bar.className = 'reject-reason-bar';
  bar.dataset.fp = fp;
  bar.innerHTML = `
    <span class="reject-reason-label">Why ignore this one?</span>
    <div class="reject-chip-row">
      ${REJECT_CHIPS.map((c) => `
        <button type="button" class="reject-chip" data-reason="${c.value}">${c.label}</button>
      `).join('')}
    </div>
  `;
  card.appendChild(bar);

  // Auto-dismiss after 8s of no interaction.
  const timeoutId = setTimeout(() => dismissRejectReason(fp), 8000);
  const entry = pendingRejectReason.get(fp) || {};
  if (entry.timeoutId) clearTimeout(entry.timeoutId);
  entry.timeoutId = timeoutId;
  pendingRejectReason.set(fp, entry);

  const clearAutoDismiss = () => {
    const e = pendingRejectReason.get(fp);
    if (e?.timeoutId) {
      clearTimeout(e.timeoutId);
      e.timeoutId = null;
    }
  };

  bar.addEventListener('click', (ev) => {
    ev.stopPropagation();
    clearAutoDismiss();
    const chip = ev.target.closest('.reject-chip');
    if (!chip) return;
    const reason = chip.dataset.reason;
    if (reason === 'other') {
      // Replace chips with an inline text input.
      bar.innerHTML = `
        <span class="reject-reason-label">Other:</span>
        <input type="text" class="reject-other-input" placeholder="What put you off?" maxlength="200" autofocus>
        <button type="button" class="reject-chip reject-other-submit">Submit</button>
      `;
      const input = bar.querySelector('.reject-other-input');
      const submit = bar.querySelector('.reject-other-submit');
      input.focus();
      const onSubmit = async () => {
        const note = input.value.trim();
        await postRejectReason(fp, 'other', note);
        flashNotedThenDismiss(bar, fp);
      };
      submit.addEventListener('click', (e) => { e.stopPropagation(); onSubmit(); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); onSubmit(); }
        if (e.key === 'Escape') { e.preventDefault(); dismissRejectReason(fp); }
      });
      return;
    }
    chip.classList.add('selected');
    postRejectReason(fp, reason);
    flashNotedThenDismiss(bar, fp);
  });
}

function render() {
  const filtered = applyFiltersAndSort(allListings);
  const empty = $('#empty');
  const tableWrap = $('.table-wrap');
  const cards = $('#cards');
  const kanban = $('#kanban-board');

  if (currentView === 'kanban') {
    tableWrap.style.display = 'none';
    cards.style.display = 'none';
    empty.style.display = 'none';
    kanban.hidden = false;
    renderKanban();
    const visible = allListings.filter((l) => (l.status || 'new') !== 'rejected').length;
    $('#sub').textContent = `${visible} of ${allListings.length} listings`;
    return;
  }

  kanban.hidden = true;
  if (filtered.length === 0) {
    empty.style.display = 'block';
    tableWrap.style.display = 'none';
    cards.style.display = 'none';
  } else {
    empty.style.display = 'none';
    tableWrap.style.display = '';
    cards.style.display = '';
    renderTable(filtered);
    renderCards(filtered);
  }
  $('#sub').textContent = `${filtered.length} of ${allListings.length} listings`;
}

function kanbanColumns() {
  return STATUSES.filter((s) => s.value !== 'rejected');
}

function groupByStatus(listings) {
  const groups = {};
  for (const col of kanbanColumns()) groups[col.value] = [];
  for (const l of listings) {
    const status = l.status || 'new';
    if (status === 'rejected') continue;
    if (!groups[status]) groups[status] = [];
    groups[status].push(l);
  }
  return groups;
}

function kanbanCardHtml(l) {
  const overall = l.score?.overallScore ?? 0;
  const fp = l.dedupKey || l.fingerprint;
  return `
    <div class="kanban-card" data-fp="${escapeHtml(fp)}" draggable="true">
      <div class="kanban-card-score ${scoreClass(overall)}">${overall}</div>
      <div class="kanban-card-body">
        <div class="kanban-card-title">${escapeHtml(l.title)}</div>
        <div class="kanban-card-company">${escapeHtml(l.company)}</div>
      </div>
    </div>
  `;
}

function updateColCounts() {
  $$('#kanban-board .kanban-col').forEach((col) => {
    const count = $$('.kanban-card', col).length;
    const badge = $('.kanban-col-count', col);
    if (badge) badge.textContent = count;
  });
}

function renderKanban() {
  const board = $('#kanban-board');
  const groups = groupByStatus(allListings);
  board.innerHTML = kanbanColumns().map((col) => {
    const items = (groups[col.value] || [])
      .slice()
      .sort((a, b) => (b.score?.overallScore || 0) - (a.score?.overallScore || 0));
    return `
      <div class="kanban-col" data-status="${col.value}">
        <div class="kanban-col-head">
          <span class="kanban-col-title">${escapeHtml(col.label)}</span>
          <span class="kanban-col-count">${items.length}</span>
        </div>
        <div class="kanban-cards" data-status="${col.value}">
          ${items.map(kanbanCardHtml).join('')}
        </div>
      </div>
    `;
  }).join('');

  $$('.kanban-card', board).forEach((card) => {
    card.addEventListener('click', () => {
      const fp = card.dataset.fp;
      const listing = allListings.find((l) => (l.dedupKey || l.fingerprint) === fp);
      if (listing) openModal(listing, onListingUpdated);
    });
  });

  $$('.kanban-cards', board).forEach((el) => {
    Sortable.create(el, {
      group: 'kanban',
      animation: 150,
      onEnd(evt) {
        const fp = evt.item.dataset.fp;
        const newStatus = evt.to.dataset.status;
        const listing = allListings.find((l) => (l.dedupKey || l.fingerprint) === fp);
        if (!listing) return;
        if ((listing.status || 'new') === newStatus) {
          updateColCounts();
          return;
        }
        api(`/api/feedback/${encodeURIComponent(fp)}/status`, {
          method: 'POST',
          body: { status: newStatus },
        }).then(() => {
          listing.status = newStatus;
          if (newStatus === 'applied' && !listing.appliedDate) {
            listing.appliedDate = new Date().toISOString().slice(0, 10);
          }
          updateColCounts();
          loadStats();
        }).catch(() => {
          evt.from.insertBefore(evt.item, evt.from.children[evt.oldIndex] || null);
          updateColCounts();
        });
      },
    });
  });
}

function setView(view) {
  currentView = view === 'kanban' ? 'kanban' : 'table';
  localStorage.setItem('rolesView', currentView);
  $('#view-table').classList.toggle('is-active', currentView === 'table');
  $('#view-kanban').classList.toggle('is-active', currentView === 'kanban');
  render();
}

function onListingUpdated(updated) {
  const updatedKey = updated.dedupKey || updated.fingerprint;
  const idx = allListings.findIndex((l) => (l.dedupKey || l.fingerprint) === updatedKey);
  const oldStatus = idx >= 0 ? (allListings[idx].status || 'new') : 'new';
  const newStatus = updated.status || 'new';
  if (idx >= 0) allListings[idx] = { ...allListings[idx], ...updated };

  const transitionedToReject = oldStatus !== newStatus &&
    (newStatus === 'rejected' || newStatus === 'pass');
  const movedAwayFromReject = newStatus !== 'rejected' && newStatus !== 'pass';

  if (transitionedToReject && !pendingRejectReason.has(updatedKey)) {
    pendingRejectReason.set(updatedKey, {});
  } else if (movedAwayFromReject && pendingRejectReason.has(updatedKey)) {
    dismissRejectReason(updatedKey);
  }

  render();
  loadStats();
}

const FILTER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>';
const CHEVRON_ICON = '<svg class="filter-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

function closeFilterPopup() {
  const popup = $('#filter-popup');
  const trigger = $('#filter-trigger');
  if (!popup || !trigger) return;
  popup.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
}

function openFilterPopup() {
  const popup = $('#filter-popup');
  const trigger = $('#filter-trigger');
  if (!popup || !trigger) return;
  popup.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
}

function uniqueSources() {
  const set = new Set();
  for (const l of allListings) if (l.source) set.add(l.source);
  return Array.from(set).sort();
}

function maxSalaryInListings() {
  let max = 0;
  for (const l of allListings) {
    const s = l.score?.salaryMax || l.score?.salaryMin || 0;
    if (s > max) max = s;
  }
  // Round up to nearest 25k for a sensible slider ceiling.
  return Math.max(150000, Math.ceil(max / 25000) * 25000);
}

function renderFilters(stats) {
  const counts = stats.byStatus || {};
  // Exclude ignored from the totals/pills — ignored listings live on
  // their own page, so they shouldn't be selectable here.
  const visibleStatuses = STATUSES.filter((s) => s.value !== 'rejected');
  const total = visibleStatuses.reduce((sum, s) => sum + (counts[s.value] || 0), 0);
  const statusOptions = [
    { value: 'all', label: 'All', count: total },
    ...visibleStatuses.map((s) => ({ ...s, count: counts[s.value] || 0 })),
  ];
  const activeCount = activeFilterCount();
  const isFiltered = activeCount > 0;
  const sources = uniqueSources();
  const maxSal = maxSalaryInListings();

  $('#filters').innerHTML = `
    <div class="filter-trigger-wrap">
      <button type="button" class="filter-trigger ${isFiltered ? 'is-active' : ''}"
              id="filter-trigger" aria-haspopup="dialog" aria-expanded="false">
        ${FILTER_ICON}
        <span class="filter-trigger-label">${isFiltered ? 'Filtered' : 'Filter'}</span>
        ${isFiltered ? `<span class="filter-trigger-count">${activeCount}</span>` : ''}
        ${CHEVRON_ICON}
      </button>
      <div class="filter-popup filter-panel" id="filter-popup" role="dialog" hidden>
        <div class="filter-panel-head">
          <span class="filter-panel-title">Filter ${total} listings</span>
          <button type="button" class="filter-reset" id="filter-reset"
                  ${isFiltered ? '' : 'disabled'}>Reset</button>
        </div>

        <div class="filter-section">
          <span class="filter-section-label">Status</span>
          <div class="filter-pill-row">
            ${statusOptions.map((o) => `
              <button type="button"
                      class="filter-mini-pill ${o.value === filters.status ? 'active' : ''}"
                      data-status="${o.value}">
                ${o.label}<span class="filter-mini-pill-count">${o.count}</span>
              </button>
            `).join('')}
          </div>
        </div>

        <div class="filter-section">
          <div class="filter-section-row">
            <span class="filter-section-label">Min score</span>
            <span class="filter-section-value" id="f-min-score-val">${filters.minScore || 'any'}</span>
          </div>
          <input type="range" id="f-min-score" min="0" max="10" step="1"
                 value="${filters.minScore}" class="filter-slider">
        </div>

        <div class="filter-section">
          <div class="filter-section-row">
            <span class="filter-section-label">Min salary</span>
            <span class="filter-section-value" id="f-min-salary-val">${filters.minSalary ? '$' + fmtKShort(filters.minSalary) : 'any'}</span>
          </div>
          <input type="range" id="f-min-salary" min="0" max="${maxSal}" step="5000"
                 value="${filters.minSalary}" class="filter-slider">
        </div>

        ${sources.length > 1 ? `
          <div class="filter-section">
            <span class="filter-section-label">Source</span>
            <div class="filter-pill-row">
              ${sources.map((src) => `
                <button type="button"
                        class="filter-mini-pill ${filters.sources.includes(src) ? 'active' : ''}"
                        data-source="${escapeHtml(src)}">
                  ${escapeHtml(src)}
                </button>
              `).join('')}
            </div>
          </div>
        ` : ''}

        <div class="filter-section">
          <span class="filter-section-label">Rating</span>
          <div class="filter-pill-row">
            ${[
              { v: 'any', l: 'Any' },
              { v: 'up', l: 'Liked', icon: SVG_THUMB_UP },
              { v: 'down', l: 'Disliked', icon: SVG_THUMB_DOWN },
              { v: 'unrated', l: 'Unrated' },
            ].map((o) => `
              <button type="button"
                      class="filter-mini-pill ${o.v === filters.rating ? 'active' : ''}"
                      data-rating="${o.v}">${o.icon ? `<span class="filter-mini-pill-icon">${o.icon}</span>` : ''}${o.l}</button>
            `).join('')}
          </div>
        </div>

        <div class="filter-section">
          <label class="filter-toggle-row">
            <span>
              <span class="filter-section-label" style="display:block">Closing soon</span>
              <span class="filter-toggle-sub">Saved/applied/interview, deadline ≤ 7 days</span>
            </span>
            <input type="checkbox" id="f-closing-soon" ${filters.closingSoon ? 'checked' : ''}>
          </label>
        </div>
      </div>
    </div>
  `;

  // ---- Wire up controls ----

  $('#filter-trigger').addEventListener('click', (e) => {
    e.stopPropagation();
    const popup = $('#filter-popup');
    if (popup.hidden) openFilterPopup(); else closeFilterPopup();
  });

  $('#filter-reset').addEventListener('click', () => {
    filters = { ...DEFAULT_FILTERS };
    $('#t-search').value = '';
    render();
    renderFilters(stats);
    openFilterPopup();
  });

  // Status pills
  $$('[data-status]').forEach((btn) => {
    btn.addEventListener('click', () => {
      filters.status = btn.dataset.status;
      $$('[data-status]').forEach((x) => x.classList.toggle('active', x.dataset.status === filters.status));
      render();
      updateTriggerState(stats);
    });
  });

  // Min score slider
  $('#f-min-score').addEventListener('input', (e) => {
    filters.minScore = parseInt(e.target.value, 10);
    $('#f-min-score-val').textContent = filters.minScore || 'any';
    render();
    updateTriggerState(stats);
  });

  // Min salary slider
  $('#f-min-salary').addEventListener('input', (e) => {
    filters.minSalary = parseInt(e.target.value, 10);
    $('#f-min-salary-val').textContent = filters.minSalary ? '$' + fmtKShort(filters.minSalary) : 'any';
    render();
    updateTriggerState(stats);
  });

  // Source chips (multi-select)
  $$('[data-source]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const src = btn.dataset.source;
      if (filters.sources.includes(src)) {
        filters.sources = filters.sources.filter((x) => x !== src);
      } else {
        filters.sources = [...filters.sources, src];
      }
      btn.classList.toggle('active');
      render();
      updateTriggerState(stats);
    });
  });

  // Rating pills (single-select)
  $$('[data-rating]').forEach((btn) => {
    btn.addEventListener('click', () => {
      filters.rating = btn.dataset.rating;
      $$('[data-rating]').forEach((x) => x.classList.toggle('active', x.dataset.rating === filters.rating));
      render();
      updateTriggerState(stats);
    });
  });

  // Closing-soon toggle
  $('#f-closing-soon').addEventListener('change', (e) => {
    filters.closingSoon = e.target.checked;
    render();
    updateTriggerState(stats);
  });
}

// Update only the trigger button label/count without rebuilding the
// popup (so sliders, focus, and search-input state survive interaction).
function updateTriggerState(stats) {
  const trigger = $('#filter-trigger');
  const reset = $('#filter-reset');
  if (!trigger) return;
  const activeCount = activeFilterCount();
  const isFiltered = activeCount > 0;
  trigger.classList.toggle('is-active', isFiltered);
  const label = trigger.querySelector('.filter-trigger-label');
  const countEl = trigger.querySelector('.filter-trigger-count');
  if (label) label.textContent = isFiltered ? 'Filtered' : 'Filter';
  if (countEl && !isFiltered) countEl.remove();
  else if (!countEl && isFiltered) {
    const span = document.createElement('span');
    span.className = 'filter-trigger-count';
    span.textContent = activeCount;
    label.after(span);
  } else if (countEl && isFiltered) {
    countEl.textContent = activeCount;
  }
  if (reset) reset.disabled = !isFiltered;
}

document.addEventListener('click', (e) => {
  const wrap = e.target.closest('.filter-trigger-wrap');
  if (!wrap) closeFilterPopup();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeFilterPopup();
});

function renderStats(stats) {
  const ignored = stats.byStatus?.rejected || 0;
  const link = $('#ignored-link');
  const count = $('#ignored-link-count');
  // Guard the element lookups so a stale-cached HTML without the
  // ignored-link element can't crash this function and leave the
  // page stuck on "Loading…".
  if (link && count) {
    if (ignored > 0) {
      link.hidden = false;
      count.textContent = `(${ignored})`;
    } else {
      link.hidden = true;
    }
  }

  $('#stats').innerHTML = `
    <div class="stat">
      <div class="stat-label">Total roles</div>
      <div class="stat-value">${stats.total}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Saved</div>
      <div class="stat-value accent">${stats.byStatus.saved || 0}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Applied</div>
      <div class="stat-value good">${stats.byStatus.applied || 0}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Applied this week</div>
      <div class="stat-value">${stats.appliedThisWeek}</div>
    </div>
  `;
}

function fmtBriefDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function renderSummaries(s) {
  if (s.daily?.text) {
    $('#brief').style.display = 'block';
    $('#brief-date').textContent = fmtBriefDate(s.daily.date);
    $('#brief-text').textContent = s.daily.text;
  }
  if (s.weekly?.text) {
    $('#weekly').style.display = 'block';
    $('#weekly-date').textContent = s.weekly.weekRange || '';
    // Render simple markdown (** **) inline
    const html = escapeHtml(s.weekly.text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');
    $('#weekly-text').innerHTML = `<p>${html}</p>`;
  }
}

async function loadStats() {
  const stats = await api('/api/stats');
  renderStats(stats);
  renderFilters(stats);
}

async function loadSummaries() {
  try {
    const s = await api('/api/summaries');
    renderSummaries(s);
  } catch (err) {
    console.warn('No summaries yet', err);
  }
}

async function load() {
  // Synchronous fast-path: server-side inline of GET / drops the initial
  // dataset on window.__INITIAL so we can render before any fetch fires.
  // Falls through to the network path if the inline didn't happen
  // (direct asset reload, fallback path in routes/page.js, etc.)
  const initial = typeof window !== 'undefined' ? window.__INITIAL : null;
  if (initial?.listings?.listings) {
    allListings = initial.listings.listings;
    if (initial.stats) {
      renderStats(initial.stats);
      renderFilters(initial.stats);
    }
    if (initial.summaries) renderSummaries(initial.summaries);
    if (initial.discoveries) updatePendingReviewPill(initial.discoveries.pendingCount || 0);
    render();
    firstRenderDone = true;
    return;
  }

  const data = await api('/api/listings?days=60');
  allListings = data.listings;
  await Promise.all([loadStats(), loadSummaries(), loadPendingReviewCount()]);
  render();
  firstRenderDone = true;
}

// Pending source candidates from cron Discovery runs. We only need the
// count for the pill — the modal fetches the full list on open. Initial
// paint reads from window.__INITIAL.discoveries (inlined by routes/page.js);
// this function only runs on the network fallback path.
async function loadPendingReviewCount() {
  try {
    const data = await api('/api/discoveries');
    updatePendingReviewPill((data.pending || []).length);
  } catch {
    updatePendingReviewPill(0);
  }
}

function updatePendingReviewPill(count) {
  const pill = $('#pending-review-pill');
  if (!pill) return;
  const countEl = $('#pending-review-count');
  if (count > 0) {
    if (countEl) countEl.textContent = String(count);
    pill.hidden = false;
  } else {
    pill.hidden = true;
  }
}

// Re-fetch after the add-role modal saves a new listing. Skips the
// window.__INITIAL fast-path (that's the page-load snapshot and is stale
// now) and uses the same network branch load() would take. firstRenderDone
// stays true so the stagger animation doesn't replay on every reload.
async function reloadData() {
  const data = await api('/api/listings?days=60');
  allListings = data.listings;
  await Promise.all([loadStats(), loadSummaries()]);
  render();
}

function openAddRole() {
  openAddRoleModal({ onAdded: reloadData });
}
$('#add-role-btn')?.addEventListener('click', openAddRole);
// Empty-state button only exists in the DOM when there are no roles; bind
// defensively in case the empty state isn't shown.
$('#add-role-btn-empty')?.addEventListener('click', openAddRole);

// Pending-review pill: open the review-candidates modal. Modal calls back
// with the post-action count so we can shrink/hide the pill in real time
// as she approves or dismisses candidates inside it.
$('#pending-review-pill')?.addEventListener('click', () => {
  openReviewCandidatesModal({
    onChange: ({ pendingCount }) => updatePendingReviewPill(pendingCount),
  });
});

// Deep-link entry point: nav links from other pages route here as
// /?add=1 so clicking "Add a role" from anywhere lands on roles with the
// modal already open. Strip the param after opening so a refresh doesn't
// re-trigger it.
if (new URLSearchParams(location.search).get('add')) {
  openAddRole();
  history.replaceState(null, '', location.pathname);
}

$('#view-table').addEventListener('click', () => setView('table'));
$('#view-kanban').addEventListener('click', () => setView('kanban'));
// Reflect persisted view immediately so toggle state is correct on first paint.
$('#view-table').classList.toggle('is-active', currentView === 'table');
$('#view-kanban').classList.toggle('is-active', currentView === 'kanban');

$$('th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (sortKey === key) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortKey = key;
      sortDir = key === 'score' || key === 'salary' ? 'desc' : 'asc';
    }
    render();
  });
});

// Toolbar search — primary filter affordance, debounced 200ms.
let toolbarSearchTimer;
$('#t-search').addEventListener('input', (e) => {
  clearTimeout(toolbarSearchTimer);
  toolbarSearchTimer = setTimeout(() => {
    filters.search = e.target.value;
    render();
    if ($('#filter-trigger')) {
      // The popup may not be rendered yet on first load. Guard it.
      // Use a no-op stats when we don't have one cached.
      updateTriggerState({ byStatus: {} });
    }
  }, 200);
});

load();
