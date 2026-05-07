// test/location.test.js
//
// Coverage for classifyLocation — the ingestion gate that decides whether
// a listing reaches scoring (nyc/remote/hybrid/unknown) or gets dropped
// (other). Pinning the table here so a future tweak to the regex set
// can't silently let SF/DC roles through.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLocation } from '../src/location.js';

describe('classifyLocation', () => {
  const cases = [
    ['New York, NY', 'nyc'],
    ['Brooklyn, NY', 'nyc'],
    ['Jersey City, NJ', 'nyc'],
    ['Stamford, CT', 'nyc'],
    ['Remote', 'remote'],
    ['Remote (US)', 'remote'],
    ['Hybrid – NY', 'hybrid'],
    ['Hybrid', 'hybrid'],
    ['San Francisco, CA', 'other'],
    ['Washington, DC', 'other'],
    ['', 'unknown'],
    [null, 'unknown'],
  ];

  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => {
      assert.equal(classifyLocation(input), expected);
    });
  }
});
