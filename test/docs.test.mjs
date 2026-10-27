// readDocs: what the one search window searches — the index plus the clones ghq
// knows that the index has not seen yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDocs, needsRefresh } from '../lib/search-index.mjs';

test('readDocs merges the index with clones ghq knows, and a new clone replaces its remote entry', () => {
  const cache = mkdtempSync(join(tmpdir(), 'ghqcd-docs-'));
  try {
    writeFileSync(join(cache, 'index.json'), JSON.stringify({ repos: {
      '/r/github.com/a/old': { slug: 'github.com/a/old', name: 'old', cloned: true, description: 'indexed clone', issues: [] },
      'github.com/a/far': { slug: 'github.com/a/far', name: 'far', cloned: false, description: 'not cloned', issues: [] },
      'github.com/a/new': { slug: 'github.com/a/new', name: 'new', cloned: false, description: 'cloned since', issues: [] },
    } }));
    const paths = ['/r/github.com/a/old', '/r/github.com/a/new', '/r/github.com/a/fresh'];
    const docs = readDocs(paths, (p) => p.slice(3), { GHQCD_CACHE_DIR: cache });
    const by = Object.fromEntries(docs.map((d) => [d.slug, d]));
    assert.deepEqual(Object.keys(by).sort(), ['github.com/a/far', 'github.com/a/fresh', 'github.com/a/new', 'github.com/a/old']);
    assert.equal(by['github.com/a/far'].cloned, false);
    assert.equal(by['github.com/a/new'].key, '/r/github.com/a/new', 'the clone wins');
    assert.equal(by['github.com/a/new'].description, 'cloned since', 'and keeps what the index knew');
    assert.equal(by['github.com/a/new'].alias, 'github.com/a/new', 'the old key, so vectors embedded before the clone still resolve');
    assert.equal(by['github.com/a/fresh'].name, 'fresh');
    assert.equal(by['github.com/a/fresh'].cloned, true);
    const gone = readDocs(['/r/github.com/a/new'], (p) => p.slice(3), { GHQCD_CACHE_DIR: cache }).find((d) => d.slug === 'github.com/a/old');
    assert.deepEqual([gone.key, gone.cloned, gone.alias], ['github.com/a/old', false, '/r/github.com/a/old'], 'a clone deleted since indexing is offered for cloning again');
    assert.equal(readDocs(['/r/x/y/z'], (p) => p.slice(3), { GHQCD_CACHE_DIR: join(cache, 'none') })[0].slug, 'x/y/z', 'no index: clones only');
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test('needsRefresh: missing or day-old index, missing vectors; not right after a failure', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  const fresh = { textAt: now - 3600e3, semanticAt: now - 3600e3 };
  assert.equal(needsRefresh({}, null, now, true), true);
  assert.equal(needsRefresh(fresh, null, now, true), false);
  assert.equal(needsRefresh({ ...fresh, textAt: now - 2 * 864e5 }, null, now, true), true);
  assert.equal(needsRefresh({ textAt: fresh.textAt }, null, now, true), true, 'vectors never built');
  assert.equal(needsRefresh({ textAt: fresh.textAt }, null, now, false), false, 'unless meaning search is off');
  assert.equal(needsRefresh({ textAt: now, semanticAt: fresh.semanticAt }, null, now, true), true, 'text updated with vectors off: catch up when enabled');
  assert.equal(needsRefresh({}, { done: true, failed: true, at: now - 600e3 }, now, true), false, 'a failure ten minutes ago is not retried on every window');
  assert.equal(needsRefresh({}, { done: true, failed: true, at: now - 7 * 3600e3 }, now, true), true);
});

test('readDocs: a clone whose path differs from GitHub only in case is the same repository', () => {
  const cache = mkdtempSync(join(tmpdir(), 'ghqcd-docs-'));
  try {
    writeFileSync(join(cache, 'index.json'), JSON.stringify({ repos: {
      'github.com/alice/tools': { slug: 'github.com/alice/tools', name: 'tools', cloned: false, description: 'from GitHub', issues: [] },
    } }));
    const docs = readDocs(['/r/github.com/Alice/Tools'], (p) => p.slice(3), { GHQCD_CACHE_DIR: cache });
    assert.deepEqual(docs.map((d) => [d.key, d.cloned, d.description]), [['/r/github.com/Alice/Tools', true, 'from GitHub']]);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test('readDocs: the same repository cloned under two ghq roots is listed twice, once per clone', () => {
  const docs = readDocs(['/a/github.com/x/api', '/b/github.com/x/api'], (p) => p.slice(3), { GHQCD_CACHE_DIR: join(tmpdir(), 'ghqcd-none') });
  assert.deepEqual(docs.map((d) => [d.key, d.cloned]), [['/a/github.com/x/api', true], ['/b/github.com/x/api', true]]);
});
