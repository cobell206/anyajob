// src/discover.test.js
// Tests for the pure prompt-building helpers in discover.js. These exercise
// the three feedback signals injected into the discovery user message:
// positive (saved/applied roles), negative (reject-reason aggregate), and
// dismissed sources.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDiscoveryUserMessage,
  formatPositiveSignal,
  formatNegativeSignal,
  formatDismissedSignal,
  formatHintBlock,
  HINT_MAX_CHARS,
} from './discover.js';

const basePrefs = {
  profile: {
    geo: 'NYC',
    interestAreas: ['litigation'],
    targetSchools: ['Columbia'],
    currentRole: 'paralegal',
    yearsOutOfUndergrad: 2,
  },
  keywords: { boost: ['litigation'], exclude: ['sales'] },
  companies: { alwaysShow: ['Davis Polk'] },
};

const baseArgs = {
  prefs: basePrefs,
  existingList: 'greenhouse:cravath',
  resumeBlock: '',
  listings: [],
  feedback: {},
  discoveries: { candidates: [] },
};

describe('formatPositiveSignal', () => {
  it('formats saved and applied listings with company, location, score', () => {
    const listings = [
      { fingerprint: 'a', title: 'Senior Associate', company: 'Brennan Center for Justice',
        location: 'NYC', score: { overallScore: 9 } },
      { fingerprint: 'b', title: 'Staff Attorney', company: 'NYCLU',
        location: 'NYC', score: { overallScore: 8 } },
      { fingerprint: 'c', title: 'Sales Rep', company: 'Acme', location: 'NYC',
        score: { overallScore: 3 } },
    ];
    const feedback = {
      status: { a: 'saved', b: 'applied', c: 'pass' },
      statusAt: { a: '2026-05-01', b: '2026-05-05' },
    };
    const block = formatPositiveSignal(listings, feedback);
    assert.match(block, /positive signal/i);
    assert.match(block, /Senior Associate, Brennan Center for Justice \(NYC, score 9\)/);
    assert.match(block, /Staff Attorney, NYCLU \(NYC, score 8\)/);
    assert.doesNotMatch(block, /Sales Rep/);
  });

  it('returns empty string when there are 0 saved/applied roles', () => {
    const listings = [
      { fingerprint: 'a', title: 'X', company: 'Y', location: 'Z' },
    ];
    const feedback = { status: { a: 'pass' } };
    assert.equal(formatPositiveSignal(listings, feedback), '');
  });

  it('caps at 15 entries, most recent first', () => {
    const listings = [];
    const status = {};
    const statusAt = {};
    for (let i = 0; i < 20; i++) {
      const fp = 'fp' + i;
      listings.push({ fingerprint: fp, title: 'T' + i, company: 'C' + i, location: 'L' });
      status[fp] = 'saved';
      statusAt[fp] = `2026-05-${String(i + 1).padStart(2, '0')}`;
    }
    const block = formatPositiveSignal(listings, { status, statusAt });
    const lines = block.trim().split('\n').filter((l) => l.startsWith('- '));
    assert.equal(lines.length, 15);
    assert.match(lines[0], /T19/);
    assert.match(lines[14], /T5/);
  });

  it('handles missing score gracefully', () => {
    const listings = [
      { fingerprint: 'a', title: 'X', company: 'Y', location: 'Z' },
    ];
    const feedback = { status: { a: 'saved' } };
    const block = formatPositiveSignal(listings, feedback);
    assert.match(block, /- X, Y \(Z\)/);
  });
});

describe('formatNegativeSignal', () => {
  it('aggregates reject reasons into counts when total >= 3', () => {
    // Real schema: { [fp]: { reason, note, at } }
    const feedback = {
      rejectReasons: {
        a: { reason: 'location', at: '2026-05-01' },
        b: { reason: 'location', at: '2026-05-02' },
        c: { reason: 'salary', at: '2026-05-03' },
      },
    };
    const block = formatNegativeSignal(feedback);
    assert.match(block, /ignoring/i);
    assert.match(block, /location: 2/);
    assert.match(block, /salary: 1/);
  });

  it('omits the block when fewer than 3 ignored', () => {
    assert.equal(formatNegativeSignal({
      rejectReasons: { a: { reason: 'location' } },
    }), '');
    assert.equal(formatNegativeSignal({ rejectReasons: {} }), '');
    assert.equal(formatNegativeSignal({}), '');
  });

  it('also accepts string reasons (defensive — older data)', () => {
    const feedback = {
      rejectReasons: { a: 'location', b: 'location', c: 'salary' },
    };
    const block = formatNegativeSignal(feedback);
    assert.match(block, /location: 2/);
    assert.match(block, /salary: 1/);
  });
});

describe('formatDismissedSignal', () => {
  it('lists dismissed candidates by kind:slug or kind:url', () => {
    const discoveries = {
      candidates: [
        { kind: 'greenhouse', config: { slug: 'aclu-ca' }, status: 'dismissed' },
        { kind: 'smartfetch', config: { url: 'https://example.com/jobs' }, status: 'dismissed' },
        { kind: 'greenhouse', config: { slug: 'cravath' }, status: 'pending' },
      ],
    };
    const block = formatDismissedSignal(discoveries);
    assert.match(block, /do not re-suggest/i);
    assert.match(block, /greenhouse:aclu-ca/);
    assert.match(block, /smartfetch:https:\/\/example\.com\/jobs/);
    assert.doesNotMatch(block, /cravath/);
  });

  it('returns empty string when nothing is dismissed', () => {
    assert.equal(formatDismissedSignal({ candidates: [] }), '');
    assert.equal(formatDismissedSignal({
      candidates: [{ kind: 'greenhouse', config: { slug: 'x' }, status: 'pending' }],
    }), '');
  });

  it('caps at 20 entries', () => {
    const candidates = [];
    for (let i = 0; i < 30; i++) {
      candidates.push({ kind: 'greenhouse', config: { slug: 's' + i }, status: 'dismissed' });
    }
    const block = formatDismissedSignal({ candidates });
    const lines = block.trim().split('\n').filter((l) => l.startsWith('- '));
    assert.equal(lines.length, 20);
  });
});

describe('buildDiscoveryUserMessage', () => {
  it('includes saved roles when present', () => {
    const listings = [
      { fingerprint: 'a', title: 'Senior Associate', company: 'Brennan Center',
        location: 'NYC', score: { overallScore: 9 } },
    ];
    const feedback = { status: { a: 'saved' } };
    const msg = buildDiscoveryUserMessage({
      ...baseArgs,
      listings,
      feedback,
    });
    assert.match(msg, /positive signal/i);
    assert.match(msg, /Senior Associate, Brennan Center \(NYC, score 9\)/);
  });

  it('omits the positive signal block when 0 saved/applied roles', () => {
    const msg = buildDiscoveryUserMessage(baseArgs);
    assert.doesNotMatch(msg, /positive signal/i);
    assert.doesNotMatch(msg, /saved or applied/i);
  });

  it('omits the ignore block when fewer than 3 ignored', () => {
    const feedback = {
      rejectReasons: {
        a: { reason: 'location' },
        b: { reason: 'salary' },
      },
    };
    const msg = buildDiscoveryUserMessage({ ...baseArgs, feedback });
    assert.doesNotMatch(msg, /ignoring/i);
  });

  it('includes the ignore block when 3+ ignored', () => {
    const feedback = {
      rejectReasons: {
        a: { reason: 'location' },
        b: { reason: 'location' },
        c: { reason: 'location' },
      },
    };
    const msg = buildDiscoveryUserMessage({ ...baseArgs, feedback });
    assert.match(msg, /ignoring/i);
    assert.match(msg, /location: 3/);
  });

  it('includes the dismissed block when sources are dismissed', () => {
    const discoveries = {
      candidates: [
        { kind: 'greenhouse', config: { slug: 'aclu-ca' }, status: 'dismissed' },
      ],
    };
    const msg = buildDiscoveryUserMessage({ ...baseArgs, discoveries });
    assert.match(msg, /do not re-suggest/i);
    assert.match(msg, /greenhouse:aclu-ca/);
  });

  it('omits the dismissed block when nothing is dismissed', () => {
    const msg = buildDiscoveryUserMessage(baseArgs);
    assert.doesNotMatch(msg, /do not re-suggest/i);
    assert.doesNotMatch(msg, /Previously dismissed/);
  });

  it('preserves the existing profile and keywords sections', () => {
    const msg = buildDiscoveryUserMessage(baseArgs);
    assert.match(msg, /HER PROFILE/);
    assert.match(msg, /KEYWORDS/);
    assert.match(msg, /ALREADY TRACKING/);
    assert.match(msg, /greenhouse:cravath/);
  });

  it('includes the hint block when a non-empty hint is passed', () => {
    const msg = buildDiscoveryUserMessage({
      ...baseArgs,
      hint: 'focus on environmental nonprofits in NYC',
    });
    assert.match(msg, /FOCUS FOR THIS RUN/);
    assert.match(msg, /focus on environmental nonprofits in NYC/);
  });

  it('omits the hint block when hint is empty / whitespace / missing', () => {
    assert.doesNotMatch(buildDiscoveryUserMessage(baseArgs), /FOCUS FOR THIS RUN/);
    assert.doesNotMatch(buildDiscoveryUserMessage({ ...baseArgs, hint: '' }), /FOCUS FOR THIS RUN/);
    assert.doesNotMatch(buildDiscoveryUserMessage({ ...baseArgs, hint: '   \n  ' }), /FOCUS FOR THIS RUN/);
  });
});

describe('formatHintBlock', () => {
  it('returns empty for missing / non-string / empty / whitespace hints', () => {
    assert.equal(formatHintBlock(undefined), '');
    assert.equal(formatHintBlock(null), '');
    assert.equal(formatHintBlock(123), '');
    assert.equal(formatHintBlock(''), '');
    assert.equal(formatHintBlock('   \t\n  '), '');
  });

  it('trims surrounding whitespace', () => {
    const block = formatHintBlock('   more federal policy roles   ');
    assert.match(block, /"""\nmore federal policy roles\n"""/);
    assert.doesNotMatch(block, /   more federal/);
  });

  it('caps hint at HINT_MAX_CHARS', () => {
    const huge = 'x'.repeat(HINT_MAX_CHARS + 250);
    const block = formatHintBlock(huge);
    // The body between the triple quotes should be exactly HINT_MAX_CHARS x's
    const match = block.match(/"""\n(x+)\n"""/);
    assert.ok(match, 'expected fenced hint body');
    assert.equal(match[1].length, HINT_MAX_CHARS);
  });
});
