// src/constants.js
// Single source of truth for enums shared across server, routes, frontend,
// and source modules. Keeping these here prevents drift between places that
// validate them (server routes), use them as switch keys (registry dispatch),
// and render them as UI choices (settings.html).

export const VALID_STATUSES = [
  'new',
  'saved',
  'applied',
  'interview',
  'offer',
  'rejected',
  'pass',
];

// Source kinds. Three categories:
//   integration: built-in API/scraper modules
//   smartfetch:  generic URL + AI extraction
//   bookmark:    URL surfaced for manual checks (no auto-fetch)
//
// When adding a new kind:
//   1. Add it here
//   2. Wire its handler into src/sources/registry.js DISPATCH map
//   3. Add a tab and form fields to public/settings.html
export const SOURCE_KINDS = [
  'greenhouse',
  'lever',
  'usajobs',
  'idealist',
  'nycbar',
  'psjd',
  'smartfetch',
  'bookmark',
];

// Kinds that are user-addable from the settings UI. (The HTML scrapers
// like idealist/nycbar/psjd are seeded as built-ins and not added by users
// since they require code-level scraping logic.)
export const USER_ADDABLE_KINDS = ['greenhouse', 'lever', 'smartfetch', 'bookmark'];
