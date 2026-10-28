// The one search window's query server. The parent ghqcd keeps the index in
// memory; fzf runs with --disabled and, on every keystroke, reloads from a tiny
// `ghqcd --serve-query` child that asks this server and streams its answer.
// fzf shows lines as they arrive and kills the child when the query changes,
// so fast keyword hits appear at once and slower meaning / code hits follow.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keywordRank } from './rank.mjs';

// A Unix socket in the cache directory (0700: nobody else can connect); a
// named pipe on Windows.
export const socketPath = (dir) =>
  (process.platform === 'win32' ? `\\\\.\\pipe\\ghqcd-${process.pid}` : join(dir, `run-${process.pid}.sock`));
// A Unix socket path stops at 104 bytes (macOS) or 108 (Linux). Under a deep
// cache dir the window's sockets go to a new 0700 directory in tmpdir instead.
export const socketDir = (dir) =>
  (Buffer.byteLength(join(dir, 'probe-0000000.sock')) < 100 ? dir : mkdtempSync(join(tmpdir(), 'ghqcd-')));

// One query's hits, best first, each passed to emit(hit): keyword hits, then
// meaning hits not already shown, then code hits. hit.via is undefined
// (keyword), 'meaning' or 'code'. meaning(query, signal) → [{key, score, ...}];
// code(query, signal) → async iterable of {key, snippet, ...}. Either may be
// slow or fail; neither may push a line once `signal` has aborted.
// Resolves after `ms`, true; false as soon as the query is replaced.
export const afterPause = (ms, signal) => new Promise((resolve) => {
  if (signal.aborted) return resolve(false);
  const t = setTimeout(() => resolve(!signal.aborted), ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(false); }, { once: true });
});

export async function streamResults({ query, docs, meaning, code, emit, signal }) {
  const byKey = new Map(docs.map((d) => [d.key, d]));
  // Vectors are keyed by the index key at embedding time; a repository cloned
  // (or deleted) since then has a new key and keeps the old one as `alias`.
  const byAlias = new Map(docs.filter((d) => d.alias).map((d) => [d.alias, d]));
  const sent = new Set();
  const out = (hit) => {
    if (signal.aborted) return;
    sent.add(hit.key);
    emit(hit);
  };
  for (const h of keywordRank(docs, query)) out(h);
  // Code search starts now but its lines wait for the meaning hits, which rank higher.
  let meaningDone = false;
  const held = [];
  const showCode = (c) => out({ ...byKey.get(c.key), ...c, via: 'code' });
  const codeRun = (async () => {
    for await (const c of code(query, signal)) {
      if (signal.aborted) return;
      if (meaningDone) showCode(c); else held.push(c);
    }
  })().catch(() => {});
  for (const h of await meaning(query, signal).catch(() => [])) {
    const doc = byKey.get(h.key) ?? byAlias.get(h.key);
    if (doc && !sent.has(doc.key)) out({ ...doc, ...h, key: doc.key, via: 'meaning' });
  }
  meaningDone = true;
  held.forEach(showCode);
  await codeRun;
}

// answer(payload, write(line), signal): one JSON line in, lines out. The signal
// aborts when the client hangs up.
export function startServer(socket, answer) {
  if (process.platform !== 'win32') rmSync(socket, { force: true });
  const server = createServer((conn) => {
    const ac = new AbortController();
    conn.on('close', () => ac.abort());
    conn.on('error', () => ac.abort());
    let buf = '';
    const onData = async (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      conn.off('data', onData);
      try {
        await answer(JSON.parse(buf.slice(0, nl)), (line) => { if (!ac.signal.aborted) conn.write(`${line}\n`); }, ac.signal);
      } catch {
        // A failed answer is an empty one; the window keeps working.
      }
      conn.end();
    };
    conn.on('data', onData);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => resolve({
      close() {
        server.close();
        if (process.platform !== 'win32') rmSync(socket, { force: true });
      },
    }));
  });
}

// The client side, run by fzf: send one payload, copy the answer to `out`.
export function queryClient(socket, payload, out = process.stdout) {
  return new Promise((resolve) => {
    const c = connect(socket, () => c.write(`${JSON.stringify(payload)}\n`));
    c.on('data', (d) => out.write(d));
    c.on('close', resolve);
    c.on('error', resolve); // the window closed: nothing to show
  });
}
