// src/dedupe.test.js
// Run via `npm test`. Uses Node's built-in test runner (no jest/vitest needed).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, dedupKey } from './dedupe-core.js';

describe('fingerprint', () => {
  it('produces the same hash for the same role identity', () => {
    const a = { company: 'Davis Polk', title: 'Litigation Paralegal', location: 'New York, NY' };
    const b = { ...a };
    assert.equal(fingerprint(a), fingerprint(b));
  });

  it('normalizes corporate suffixes and punctuation', () => {
    // "Acme, Inc." and "Acme LLC" should be different (LLC≠Inc on first read,
    // but normalize() strips both, leaving just "acme") — verify same fp.
    const a = { company: 'Acme, Inc.', title: 'Engineer', location: 'NYC' };
    const b = { company: 'Acme LLC', title: 'Engineer', location: 'NYC' };
    assert.equal(fingerprint(a), fingerprint(b),
      'company suffixes should be normalized away');
  });

  it('treats whitespace and case as equivalent', () => {
    const a = { company: 'CRAVATH', title: 'paralegal', location: 'New York' };
    const b = { company: 'cravath ', title: 'Paralegal', location: 'NEW YORK' };
    assert.equal(fingerprint(a), fingerprint(b));
  });

  it('produces different fingerprints for different roles', () => {
    const a = { company: 'Davis Polk', title: 'Litigation Paralegal', location: 'NYC' };
    const b = { company: 'Davis Polk', title: 'Corporate Paralegal', location: 'NYC' };
    assert.notEqual(fingerprint(a), fingerprint(b));
  });
});

describe('dedupKey', () => {
  const baseListing = {
    company: 'Davis Polk',
    title: 'Litigation Paralegal',
    location: 'New York, NY',
    source: 'greenhouse:davispolk',
  };

  it('falls back to fingerprint when no externalId is present', () => {
    const a = { ...baseListing, externalId: null };
    const b = { ...baseListing, externalId: undefined };
    const c = { ...baseListing, externalId: '' };
    assert.equal(dedupKey(a), fingerprint(a));
    assert.equal(dedupKey(b), fingerprint(b));
    assert.equal(dedupKey(c), fingerprint(c));
  });

  it('distinguishes two distinct openings with the same role + different IDs', () => {
    // The whole point of the change. Davis Polk has 3 paralegal slots open at
    // once — same title, same location, different Greenhouse IDs.
    const a = { ...baseListing, externalId: '12345' };
    const b = { ...baseListing, externalId: '12346' };
    assert.equal(fingerprint(a), fingerprint(b), 'same role identity');
    assert.notEqual(dedupKey(a), dedupKey(b), 'distinct dedup keys');
  });

  it('treats a repost (new ID) as a new listing', () => {
    // Per the design: when a posting gets a new externalId on repost, we
    // surface it again. Re-scoring cost (~$0.005) is acceptable.
    const original = { ...baseListing, externalId: '12345' };
    const repost = { ...baseListing, externalId: '99999' };
    assert.notEqual(dedupKey(original), dedupKey(repost));
  });

  it('disambiguates the same externalId from different sources', () => {
    // If both Greenhouse and Lever happen to use ID "500" for unrelated jobs,
    // including the source name in the dedup key prevents collision.
    const a = { ...baseListing, source: 'greenhouse:foo', externalId: '500' };
    const b = { ...baseListing, source: 'lever:bar', externalId: '500' };
    assert.notEqual(dedupKey(a), dedupKey(b));
  });

  it('repost dedup still works for sources without IDs', () => {
    // Smartfetch and HTML scrapers don't emit externalId. Reposts on those
    // sources should still dedupe (same content → same dedup key).
    const a = { ...baseListing, source: 'smartfetch', externalId: null };
    const b = { ...baseListing, source: 'smartfetch', externalId: undefined };
    assert.equal(dedupKey(a), dedupKey(b));
  });
});
