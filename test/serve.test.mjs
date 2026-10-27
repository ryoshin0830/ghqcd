// The query server behind the window: keyword hits at once, slower meaning and
// code hits appended, and nothing more once the asker has gone away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { Writable } from 'node:stream';
import { streamResults, startServer, queryClient, socketPath } from '../lib/serve.mjs';

const docs = [
  { key: '/r/apple', slug: 'github.com/a/apple', name: 'apple', cloned: true, description: 'fruit' },
  { key: '/r/pie', slug: 'github.com/a/pie', name: 'pie', cloned: true, description: 'apple pie' },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('keyword hits come first, then meaning hits not already shown, then code', async () => {
  const lines = [];
  await streamResults({
    query: 'apple', docs, write: (l) => lines.push(l), signal: new AbortController().signal,
    display: (h) => `${h.slug} ${h.via ?? h.field}`,
    meaning: async () => { await sleep(30); return [{ key: '/r/pie', score: 0.6 }, { key: 'github.com/a/far', slug: 'github.com/a/far', score: 0.5 }]; },
    code: async function* () { await sleep(30); yield { key: '/r/apple', slug: 'github.com/a/apple', snippet: 'a.js:1 apple()' }; },
  });
  assert.deepEqual(lines, [
    '/r/apple\tgithub.com/a/apple name',
    '/r/pie\tgithub.com/a/pie description',
    'github.com/a/far\tgithub.com/a/far meaning',
    '/r/apple\tgithub.com/a/apple code',
  ]);
});

test('a client that hangs up stops the work for its query', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghqcd-serve-'));
  const socket = socketPath(dir);
  let seen;
  const server = await startServer(socket, async (payload, write, signal) => {
    write(`first ${payload.q}`);
    await sleep(100);
    seen = signal.aborted;
  });
  try {
    // Hang up after the first line, the way fzf kills a reload when the query changes.
    const first = await new Promise((resolve) => {
      const c = connect(socket, () => c.write('{"q":"x"}\n'));
      c.on('data', (d) => { c.destroy(); resolve(String(d)); });
    });
    assert.equal(first, 'first x\n');
    await sleep(150);
    assert.equal(seen, true);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a full answer reaches the client line by line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghqcd-serve-'));
  const socket = socketPath(dir);
  const server = await startServer(socket, async (p, write) => { write('a'); write(`b ${p.q}`); });
  try {
    const got = [];
    await queryClient(socket, { q: 'é 日本' }, new Writable({ write(c, _e, cb) { got.push(String(c)); cb(); } }));
    assert.equal(got.join(''), 'a\nb é 日本\n');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
