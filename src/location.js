// src/location.js
//
// Classifies a free-text location string into one of:
//   "nyc"     — NYC metro: NY state code, "new york", boroughs, and greater
//               NYC commute belt (NJ/CT/Westchester/LI).
//   "remote"  — fully remote / wfh / anywhere / distributed.
//   "hybrid"  — anything mentioning "hybrid", regardless of city — we let
//               these through and decide once we see the listing.
//   "other"   — recognizable location, but not NYC/remote/hybrid (SF, DC, …).
//   "unknown" — empty/null or no recognizable signal.
//
// Used as an ingestion gate (src/daily.js) and to retroactively auto-ignore
// non-NYC listings (scripts/migrate-location.js).

const NYC_PATTERNS = [
  /\bnew york\b/i,
  /\bnyc\b/i,
  /\bny\b/i,
  /\bbrooklyn\b/i,
  /\bqueens\b/i,
  /\bbronx\b/i,
  /\bthe bronx\b/i,
  /\bmanhattan\b/i,
  /\bstaten island\b/i,
  /\bnewark\b/i,
  /\bjersey city\b/i,
  /\bhoboken\b/i,
  /\byonkers\b/i,
  /\bwhite plains\b/i,
  /\bstamford\b/i,
  /\blong island\b/i,
  /\bwestchester\b/i,
];

const REMOTE_PATTERNS = [
  /\bremote\b/i,
  /\bwfh\b/i,
  /\bwork from home\b/i,
  /\banywhere\b/i,
  /\bdistributed\b/i,
];

const HYBRID_PATTERN = /\bhybrid\b/i;

export function classifyLocation(str) {
  if (str === null || str === undefined) return 'unknown';
  const s = String(str).trim();
  if (!s) return 'unknown';

  if (HYBRID_PATTERN.test(s)) return 'hybrid';
  if (REMOTE_PATTERNS.some((p) => p.test(s))) return 'remote';
  if (NYC_PATTERNS.some((p) => p.test(s))) return 'nyc';
  return 'other';
}
