// The one search window's query server. The parent ghqcd keeps the index in
// memory; fzf runs with --disabled and, on every keystroke, reloads from a tiny
// `ghqcd --serve-query` child that asks this server and streams its answer.
// fzf shows lines as they arrive and kills the child when the query changes,
// so fast keyword hits appear at once and slower meaning / code hits follow.
import { rmSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { join } from 'node:path';
import { keywordRank } from './rank.mjs';

// A Unix socket in the cache directory (0700: nobody else can connect); a
// named pipe on Windows.
export const socketPath = (dir) =>
  (process.platform === 'win32' ? `\\\\.\\pipe\\ghqcd-${process.pid}` : join(dir, `run-${process.pid}.sock`));

// One query's lines, best first: keyword hits, then meaning hits not already
// shown, then code hits. meaning(query, signal) → [{key, score, ...}];
// code(query, signal) → async iterable of {key, snippet, ...}. Either may be
// slow or fail; neither may push a line once `signal` has aborted.
export async function streamResults({ query, docs, meaning, code, display, write, signal }) {
  const byKey = new Map(docs.map((d) => [d.key, d]));
  const sent = new Set();
  const out = (hit) => {
    if (signal.aborted) return;
    sent.add(hit.key);
    write(`${hit.key}\t${display(hit)}`);
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
    if (!sent.has(h.key)) out({ ...byKey.get(h.key), ...h, via: 'meaning' });
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
