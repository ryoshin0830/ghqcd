// Code hits: git grep in clones (no network); GitHub code search is checked by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codeSearch } from '../lib/code.mjs';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'ghqcd-code-'));
  writeFileSync(join(dir, 'a.js'), 'const x = 1;\nfunction hello_world() {}\n');
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
  return dir;
}
const collect = async (it) => { const out = []; for await (const x of it) out.push(x); return out; };

test('a clone whose code contains the query is a code hit, with file and line', async () => {
  const dir = repo();
  try {
    const docs = [{ key: dir, slug: 'github.com/a/x', cloned: true }];
    const hits = await collect(codeSearch({ docs, query: 'hello_world', signal: new AbortController().signal, env: {} }));
    assert.deepEqual(hits, [{ key: dir, loc: 'a.js:2', snippet: 'a.js:2 function hello_world() {}' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('short queries and aborted searches yield nothing', async () => {
  const dir = repo();
  try {
    const docs = [{ key: dir, slug: 'github.com/a/x', cloned: true }];
    assert.deepEqual(await collect(codeSearch({ docs, query: 'he', signal: new AbortController().signal, env: {} })), []);
    const ac = new AbortController();
    ac.abort();
    assert.deepEqual(await collect(codeSearch({ docs, query: 'hello_world', signal: ac.signal, env: {} })), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a slow local search prints no Node warning into the window', async () => {
  const dir = repo();
  try {
    const docs = [{ key: dir, slug: 'github.com/a/x', cloned: true }, { key: 'github.com/a/far', slug: 'github.com/a/far', cloned: false }];
    const warnings = [];
    const onWarn = (w) => warnings.push(w.name);
    process.on('warning', onWarn);
    // Local grep past the 700 ms pause used to make the remote wait negative.
    const slow = { key: dir, slug: 'github.com/a/y', cloned: true };
    const original = Date.now;
    let t = original();
    Date.now = () => (t += 1000);
    try {
      await collect(codeSearch({ docs: [...docs, slow], query: 'hello_world', signal: new AbortController().signal }));
    } finally {
      Date.now = original;
    }
    await new Promise((r) => setTimeout(r, 20));
    process.off('warning', onWarn);
    assert.deepEqual(warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
