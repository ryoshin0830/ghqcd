import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexStatus } from '../lib/status.mjs';

const now = Date.parse('2026-10-28T12:00:00Z');

test('idle status shows update age, never the last refresh duration', () => {
  assert.equal(indexStatus({ textAt: now - 7200e3, textSeconds: 53 }, null, { now }), 'updated 2 h ago');
  assert.equal(indexStatus({}, null, { now }), 'not indexed yet');
});

test('vector progress uses this run count and remaining time', () => {
  assert.equal(indexStatus({}, {
    phase: 'embedding', completed: 210, total: 852, remainingSeconds: 1200,
  }, { now }), 'vectors [##--------] 25% 210/852 · ~20 min left');
  assert.match(indexStatus({}, { phase: 'embedding', completed: 852, total: 852, remainingSeconds: 0 }), /\[##########\] 100% 852\/852/);
});

test('unknown totals show activity without a made-up percentage or ETA', () => {
  assert.equal(indexStatus({}, { text: 'github.com: asking for your repositories' }), 'refreshing: github.com: asking for your repositories');
  assert.equal(indexStatus({}, { text: 'downloading model', total: 0, completed: 9 }), 'refreshing: downloading model');
});

test('download and issue phases have their own progress, not an overall percentage', () => {
  assert.equal(indexStatus({}, { phase: 'download', completed: 25, total: 100 }), 'download [###-------] 25%');
  assert.equal(indexStatus({}, { phase: 'issues', completed: 2, total: 10 }), 'issues [##--------] 20% 2/10');
});

test('finished refresh still shows age, and keeps actionable failures and hints', () => {
  const s = { textAt: now - 1000 };
  assert.equal(indexStatus(s, { done: true, at: now, text: 'indexed 5 repositories' }, { now }), 'updated just now · indexed 5 repositories');
  assert.equal(indexStatus(s, { done: true, at: now - 61000, text: 'old receipt' }, { now }), 'updated just now');
  assert.equal(indexStatus(s, { done: true, failed: true, text: 'offline' }, { now }), '! indexing failed: offline · ctrl-r retries');
  assert.equal(indexStatus(s, { done: true, hint: 'run gh auth login' }, { now }), 'updated just now · run gh auth login');
});
