// src/dedupe-core.js
// Pure fingerprint logic. No file I/O, no logger — just hashing.
// Split out from dedupe.js so tests can import it without pulling in
// the full dependency graph (atomic.js → log.js → pino).
//
// See src/dedupe.js for the storage-aware wrappers and detailed design notes.

import { createHash } from 'node:crypto';

function normalize(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/\b(inc|llc|llp|p\.?c\.?|ltd|the|a)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function hash(parts) {
  return createHash('sha256')
    .update(parts.join('|'))
    .digest('hex')
    .slice(0, 16);
}

// Stable role identity: same role → same fingerprint, regardless of source
// or repost. This is what `documents/`, feedback.json, and the modal use.
export function fingerprint(listing) {
  return hash([
    normalize(listing.company),
    normalize(listing.title),
    normalize(listing.location),
  ]);
}

// Dedup key: distinguishes between distinct openings under the same title.
// Includes the source-issued ID when available; falls back to the bare
// fingerprint when not (preserving repost-dedup for scrapers without IDs).
export function dedupKey(listing) {
  const base = fingerprint(listing);
  if (listing.externalId == null || listing.externalId === '') return base;
  // Include the source name so the same externalId from two different sources
  // (e.g., a Greenhouse "1234" and a Lever "1234") doesn't collide.
  const source = String(listing.source || 'unknown').toLowerCase();
  return hash([base, source, String(listing.externalId)]);
}
