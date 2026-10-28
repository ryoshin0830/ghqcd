// Code hits: git grep in clones (no network); GitHub code search is checked by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codeSearch } from '../lib/code.mjs';

function repo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ghqcd-code-'));
  writeFileSync(join(dir, 'a.js'), 'const x = 1;\nfunction hello_world() {}\n');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
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

test('the README is not code: its line already shows above, as a readme hit', async () => {
  const dir = repo({ 'README.md': '# x\ncall hello_world to start\n' });
  try {
    const docs = [{ key: dir, slug: 'github.com/a/x', cloned: true }];
    const hits = await collect(codeSearch({ docs, query: 'hello_world', signal: new AbortController().signal }));
    assert.deepEqual(hits.map((h) => h.loc), ['a.js:2']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a localized README (README.ja.md) is code: only the README the index reads is left out', async () => {
  const dir = repo({ 'README.md': '# x\n', 'README.ja.md': '日本語の説明\n' });
  try {
    const docs = [{ key: dir, slug: 'github.com/a/x', cloned: true }];
    const hits = await collect(codeSearch({ docs, query: '日本語', signal: new AbortController().signal }));
    assert.deepEqual(hits.map((h) => h.loc), ['README.ja.md:1']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file with a Japanese name is shown by its name, not by octal escapes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghqcd-code-'));
  writeFileSync(join(dir, '設計.md'), 'hello_world\n');
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
  try {
    const docs = [{ key: dir, slug: 'github.com/a/x', cloned: true }];
    const hits = await collect(codeSearch({ docs, query: 'hello_world', signal: new AbortController().signal }));
    assert.deepEqual(hits.map((h) => h.loc), ['設計.md:1']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a one-shot search (pause 0) asks GitHub at once, without the window\'s typing pause', async () => {
  const t0 = Date.now();
  let asked;
  const docs = [{ key: 'github.com/a/far', slug: 'github.com/a/far', cloned: false }];
  await collect(codeSearch({ docs, query: 'hello', pause: 0, signal: new AbortController().signal, token: () => { asked = Date.now() - t0; return null; } }));
  assert.ok(asked < 300, `asked after ${asked} ms`);
});
