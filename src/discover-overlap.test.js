// src/discover-overlap.test.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findOverlap, smartfetchSources } from './discover-overlap.js';

describe('smartfetchSources', () => {
  it('filters to enabled smartfetch sources with a url', () => {
    const all = [
      { kind: 'smartfetch', enabled: true, config: { url: 'https://a.com' } },
      { kind: 'smartfetch', enabled: false, config: { url: 'https://b.com' } },
      { kind: 'smartfetch', enabled: true, config: {} },              // no url
      { kind: 'greenhouse', enabled: true, config: { slug: 'x' } },   // wrong kind
      { kind: 'bookmark', enabled: true, config: { url: 'https://c.com' } },
    ];
    const result = smartfetchSources(all);
    assert.equal(result.length, 1);
    assert.equal(result[0].config.url, 'https://a.com');
  });
});

describe('findOverlap', () => {
  const existing = [
    { id: 'sf1', name: 'Skadden careers', kind: 'smartfetch', enabled: true,
      config: { url: 'https://www.skadden.com/careers' } },
    { id: 'sf2', name: 'Mayor office', kind: 'smartfetch', enabled: true,
      config: { url: 'https://www.nyc.gov/site/mayor/staff/counsel.page' } },
  ];

  it('detects when a candidate slug appears in a smartfetch URL', () => {
    const candidate = { kind: 'greenhouse', config: { slug: 'skadden' } };
    const overlap = findOverlap(candidate, existing);
    assert.equal(overlap?.id, 'sf1');
    assert.equal(overlap?.name, 'Skadden careers');
  });

  it('returns null when there is no overlap', () => {
    const candidate = { kind: 'greenhouse', config: { slug: 'cravath' } };
    assert.equal(findOverlap(candidate, existing), null);
  });

  it('returns null for non-greenhouse/lever candidates', () => {
    // Only API-integration candidates can overlap with a smartfetch.
    // Two smartfetch sources for the same site is the user's problem.
    const candidate = { kind: 'smartfetch', config: { url: 'https://skadden.com' } };
    assert.equal(findOverlap(candidate, existing), null);
  });

  it('returns null when slug is missing', () => {
    const candidate = { kind: 'greenhouse', config: {} };
    assert.equal(findOverlap(candidate, existing), null);
  });

  it('handles invalid URLs in existing sources gracefully', () => {
    const broken = [{ id: 'x', name: 'broken', kind: 'smartfetch', enabled: true,
      config: { url: 'not-a-url' } }];
    const candidate = { kind: 'greenhouse', config: { slug: 'foo' } };
    // Should not throw, should return null.
    assert.equal(findOverlap(candidate, broken), null);
  });

  it('matches the slug against hostname+path, case-insensitive', () => {
    const sources = [{ id: 'x', name: 'mixed-case', kind: 'smartfetch', enabled: true,
      config: { url: 'https://Careers.SOMECO.com/jobs' } }];
    const candidate = { kind: 'lever', config: { slug: 'someco' } };
    const overlap = findOverlap(candidate, sources);
    assert.equal(overlap?.id, 'x');
  });
});
