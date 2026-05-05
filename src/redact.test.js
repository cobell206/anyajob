// src/redact.test.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactObject, redactLogText } from './redact.js';

describe('redact (string)', () => {
  it('strips Anthropic API keys', () => {
    const text = 'auth sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-XYZabcDEF in body';
    const out = redact(text);
    assert.ok(!out.includes('sk-ant-api03'), 'key should be gone');
    assert.ok(out.includes('[REDACTED-ANTHROPIC-KEY]'));
  });

  it('strips AWS access keys', () => {
    const text = 'AKIAIOSFODNN7EXAMPLE was the key';
    const out = redact(text);
    assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'));
    assert.ok(out.includes('[REDACTED-AWS-KEY]'));
  });

  it('strips email addresses', () => {
    const text = 'sent to alice@example.com from bob.smith+test@company.co.uk';
    const out = redact(text);
    assert.ok(!out.includes('@'), 'no @ should remain');
    assert.equal(out.match(/\[REDACTED-EMAIL\]/g)?.length, 2);
  });

  it('strips absolute file paths', () => {
    const text = 'opening /home/ubuntu/lawbound/data/listings.json failed';
    const out = redact(text);
    assert.ok(!out.includes('/home/ubuntu'), 'home path should be gone');
    assert.ok(out.includes('[REDACTED-PATH]'));
  });

  it('strips Bearer tokens', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = redact(text);
    assert.ok(!out.includes('eyJhbG'), 'JWT body should be gone');
  });

  it('preserves non-secret content', () => {
    const text = 'Davis Polk Litigation Paralegal closes 2026-06-15 score=9';
    assert.equal(redact(text), text);
  });

  it('handles null and undefined safely', () => {
    assert.equal(redact(null), null);
    assert.equal(redact(undefined), undefined);
  });
});

describe('redactObject', () => {
  it('walks nested objects and arrays', () => {
    const input = {
      user: { email: 'a@b.com', name: 'Alice' },
      logs: ['ok', 'error from /home/me/file.json'],
      count: 42,
    };
    const out = redactObject(input);
    assert.equal(out.user.email, '[REDACTED-EMAIL]');
    assert.equal(out.user.name, 'Alice');
    assert.equal(out.logs[0], 'ok');
    assert.ok(out.logs[1].includes('[REDACTED-PATH]'));
    assert.equal(out.count, 42);
  });

  it('does not mutate input', () => {
    const input = { email: 'a@b.com' };
    redactObject(input);
    assert.equal(input.email, 'a@b.com');
  });

  it('preserves nulls and primitives', () => {
    assert.equal(redactObject(null), null);
    assert.equal(redactObject(undefined), undefined);
    assert.equal(redactObject(42), 42);
    assert.equal(redactObject(true), true);
  });
});

describe('redactLogText', () => {
  it('redacts both JSON-line and plain-text logs', () => {
    const lines = [
      JSON.stringify({ level: 30, msg: 'sent to alice@example.com', component: 'notify' }),
      'plain log line with sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX-key',
      '',
    ].join('\n');
    const out = redactLogText(lines);
    assert.ok(!out.includes('alice@example.com'));
    assert.ok(!out.includes('sk-ant-api03'));
    assert.ok(out.includes('[REDACTED-EMAIL]'));
    assert.ok(out.includes('[REDACTED-ANTHROPIC-KEY]'));
  });

  it('preserves non-secret JSON structure', () => {
    const line = JSON.stringify({ component: 'daily', count: 7, msg: 'ok' });
    const out = redactLogText(line);
    const parsed = JSON.parse(out);
    assert.equal(parsed.component, 'daily');
    assert.equal(parsed.count, 7);
    assert.equal(parsed.msg, 'ok');
  });
});
