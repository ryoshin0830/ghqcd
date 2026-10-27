// readDocs: what the one search window searches — the index plus the clones ghq
// knows that the index has not seen yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDocs } from '../lib/search-index.mjs';

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
    assert.equal(by['github.com/a/fresh'].name, 'fresh');
    assert.equal(by['github.com/a/fresh'].cloned, true);
    const gone = readDocs(['/r/github.com/a/new'], (p) => p.slice(3), { GHQCD_CACHE_DIR: cache }).find((d) => d.slug === 'github.com/a/old');
    assert.deepEqual([gone.key, gone.cloned], ['github.com/a/old', false], 'a clone deleted since indexing is offered for cloning again');
    assert.equal(readDocs(['/r/x/y/z'], (p) => p.slice(3), { GHQCD_CACHE_DIR: join(cache, 'none') })[0].slug, 'x/y/z', 'no index: clones only');
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});
