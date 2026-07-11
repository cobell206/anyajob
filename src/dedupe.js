// src/dedupe.js
// Storage-aware dedupe layer. Pure fingerprint logic lives in dedupe-core.js
// so it can be tested without pulling in the IO/logger graph.
//
// Two-part fingerprinting:
//
//   - fingerprint:  hash(company + title + location)
//                   Stable identifier for the role. Used for documents/,
//                   feedback.json keys, modal lookups. Same role at same
//                   employer in same location → same fingerprint forever.
//
//   - dedupKey:     hash(company + title + location + source + externalId)
//                   when externalId is present; otherwise equals fingerprint.
//                   This is what seen.json tracks. It's what determines
//                   whether a listing is "new" and gets scored.
//
// Why two? It lets distinct openings with identical titles (Davis Polk has
// 3 paralegal slots at once, each with its own Greenhouse ID) coexist
// without one suppressing the others, while still deduping reposts on
// sources that don't expose stable IDs (smartfetch, HTML scrapers).
//
// On reposts at the same source: a new externalId → new dedupKey → kept
// as a fresh listing.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeJsonAtomic } from './atomic.js';
import { readJsonSafe } from './io.js';
import { fingerprint, dedupKey } from './dedupe-core.js';

// Re-export the pure functions so callers can import everything from one place.
export { fingerprint, dedupKey } from './dedupe-core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEEN_PATH = join(__dirname, '..', 'data', 'seen.json');

export async function loadSeen() {
  const data = await readJsonSafe(SEEN_PATH, { fallback: { fingerprints: [] } });
  return new Set(data.fingerprints || []);
}

export async function saveSeen(set) {
  await writeJsonAtomic(SEEN_PATH, { fingerprints: Array.from(set) });
}

// Filter out duplicates and stamp each listing with both its fingerprint
// (stable role identity) and the dedupKey that gets recorded in seen.json.
//
// Returns only NEW listings, plus the updated seen set.
export async function dedupeListings(listings) {
  const seen = await loadSeen();
  // Track keys we've already added in THIS batch so two integrations
  // emitting the exact same listing in one run don't both get kept
  const batchKeys = new Set();
  const fresh = [];
  for (const listing of listings) {
    const key = dedupKey(listing);
    if (seen.has(key) || batchKeys.has(key)) continue;
    listing.fingerprint = fingerprint(listing);
    listing.dedupKey = key;
    fresh.push(listing);
    batchKeys.add(key);
    seen.add(key);
  }
  return { fresh, seen };
}
